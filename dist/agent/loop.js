/**
 * runcode Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 * Original implementation with different architecture from any reference codebase.
 */
import { ModelClient } from './llm.js';
import { autoCompactIfNeeded, forceCompact, microCompact } from './compact.js';
import { estimateHistoryTokens } from './tokens.js';
import { PermissionManager } from './permissions.js';
import { StreamingExecutor } from './streaming-executor.js';
import { optimizeHistory, CAPPED_MAX_TOKENS, ESCALATED_MAX_TOKENS } from './optimize.js';
import { recordUsage } from '../stats/tracker.js';
import { estimateCost } from '../pricing.js';
// ─── Main Entry Point ──────────────────────────────────────────────────────
/**
 * Run the agent loop.
 * Yields StreamEvents for the UI to render. Returns when the conversation ends.
 */
export async function* runAgent(config, initialPrompt) {
    const client = new ModelClient({
        apiUrl: config.apiUrl,
        chain: config.chain,
        debug: config.debug,
    });
    const capabilityMap = new Map();
    for (const cap of config.capabilities) {
        capabilityMap.set(cap.spec.name, cap);
    }
    const toolDefs = config.capabilities.map((c) => c.spec);
    const maxTurns = config.maxTurns ?? 100;
    const workDir = config.workingDir ?? process.cwd();
    const state = {
        history: [
            { role: 'user', content: initialPrompt },
        ],
        turnIndex: 0,
        abort: new AbortController(),
    };
    // ─── Reasoning-Action Cycle ────────────────────────────────────────────
    while (state.turnIndex < maxTurns) {
        state.turnIndex++;
        // 1. Call model
        const { content: responseParts, usage } = await callModel(client, config, state, toolDefs);
        // Emit usage
        yield {
            kind: 'usage',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            model: config.model,
        };
        // 2. Classify response parts
        const textParts = [];
        const invocations = [];
        for (const part of responseParts) {
            if (part.type === 'text') {
                textParts.push(part.text);
                yield { kind: 'text_delta', text: part.text };
            }
            else if (part.type === 'tool_use') {
                invocations.push(part);
            }
            else if (part.type === 'thinking') {
                yield { kind: 'thinking_delta', text: part.thinking };
            }
        }
        // 3. Append assistant response to history
        state.history.push({
            role: 'assistant',
            content: responseParts,
        });
        // 4. If no capability invocations, the agent is done
        if (invocations.length === 0) {
            yield { kind: 'turn_done', reason: 'completed' };
            return;
        }
        // 5. Execute capabilities
        const outcomes = await executeCapabilities(invocations, capabilityMap, workDir, state.abort, (evt) => { config.onEvent?.(evt); });
        // Emit capability results
        for (const [invocation, result] of outcomes) {
            yield {
                kind: 'capability_done',
                id: invocation.id,
                result,
            };
        }
        // 6. Append capability outcomes as user message
        const outcomeContent = outcomes.map(([invocation, result]) => ({
            type: 'tool_result',
            tool_use_id: invocation.id,
            content: result.output,
            is_error: result.isError,
        }));
        state.history.push({
            role: 'user',
            content: outcomeContent,
        });
        // Continue to next cycle...
    }
    yield { kind: 'turn_done', reason: 'max_turns' };
}
// ─── Model Call ────────────────────────────────────────────────────────────
async function callModel(client, config, state, tools) {
    const systemPrompt = config.systemInstructions.join('\n\n');
    return client.complete({
        model: config.model,
        messages: state.history,
        system: systemPrompt,
        tools,
        max_tokens: 16384,
        stream: true,
    }, state.abort.signal);
}
// ─── Capability Execution ──────────────────────────────────────────────────
async function executeCapabilities(invocations, handlers, workDir, abort, emitEvent, permissions) {
    // Partition into concurrent-safe and sequential
    const concurrent = [];
    const sequential = [];
    for (const inv of invocations) {
        const handler = handlers.get(inv.name);
        if (handler?.concurrent) {
            concurrent.push(inv);
        }
        else {
            sequential.push(inv);
        }
    }
    const results = [];
    const scope = {
        workingDir: workDir,
        abortSignal: abort.signal,
    };
    // Run concurrent capabilities in parallel
    if (concurrent.length > 0) {
        const batch = concurrent.map(async (inv) => {
            const result = await checkAndRun(inv, handlers, scope, permissions, emitEvent);
            return [inv, result];
        });
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
    }
    // Run sequential capabilities one at a time
    for (const inv of sequential) {
        const result = await checkAndRun(inv, handlers, scope, permissions, emitEvent);
        results.push([inv, result]);
    }
    return results;
}
async function checkAndRun(invocation, handlers, scope, permissions, emitEvent) {
    // Permission check
    if (permissions) {
        const decision = await permissions.check(invocation.name, invocation.input);
        if (decision.behavior === 'deny') {
            return {
                output: `Permission denied for ${invocation.name}: ${decision.reason || 'denied by policy'}`,
                isError: true,
            };
        }
        if (decision.behavior === 'ask') {
            const allowed = await permissions.promptUser(invocation.name, invocation.input);
            if (!allowed) {
                return {
                    output: `User denied permission for ${invocation.name}`,
                    isError: true,
                };
            }
        }
    }
    emitEvent({ kind: 'capability_start', id: invocation.id, name: invocation.name });
    return runSingleCapability(invocation, handlers, scope);
}
async function runSingleCapability(invocation, handlers, scope) {
    const handler = handlers.get(invocation.name);
    if (!handler) {
        return {
            output: `Unknown capability: ${invocation.name}`,
            isError: true,
        };
    }
    try {
        return await handler.execute(invocation.input, scope);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            output: `Error executing ${invocation.name}: ${message}`,
            isError: true,
        };
    }
}
// ─── Interactive Session ───────────────────────────────────────────────────
/**
 * Run a multi-turn interactive session.
 * Each user message triggers a full agent loop.
 * Returns the accumulated conversation history.
 */
export async function interactiveSession(config, getUserInput, onEvent, onAbortReady) {
    const client = new ModelClient({
        apiUrl: config.apiUrl,
        chain: config.chain,
        debug: config.debug,
    });
    const capabilityMap = new Map();
    for (const cap of config.capabilities) {
        capabilityMap.set(cap.spec.name, cap);
    }
    const toolDefs = config.capabilities.map((c) => c.spec);
    const maxTurns = config.maxTurns ?? 100;
    const workDir = config.workingDir ?? process.cwd();
    const permissions = new PermissionManager(config.permissionMode ?? 'default');
    const history = [];
    while (true) {
        const input = await getUserInput();
        if (input === null)
            break; // User wants to exit
        if (input === '')
            continue; // Empty input → re-prompt
        // Handle /compact command — force compaction without sending to model
        if (input === '/compact') {
            const beforeTokens = estimateHistoryTokens(history);
            const { history: compacted, compacted: didCompact } = await forceCompact(history, config.model, client, config.debug);
            if (didCompact) {
                history.length = 0;
                history.push(...compacted);
            }
            const afterTokens = estimateHistoryTokens(history);
            onEvent({ kind: 'text_delta', text: didCompact
                    ? `Compacted: ~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens\n`
                    : `History too short to compact (${beforeTokens.toLocaleString()} tokens, ${history.length} messages).\n`
            });
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        history.push({ role: 'user', content: input });
        const abort = new AbortController();
        onAbortReady?.(() => abort.abort());
        let turnCount = 0;
        let recoveryAttempts = 0;
        let maxTokensOverride;
        const lastActivity = Date.now();
        // Agent loop for this user message
        while (turnCount < maxTurns) {
            turnCount++;
            // ── Token optimization pipeline ──
            // 1. Strip thinking, budget tool results, time-based cleanup
            const optimized = optimizeHistory(history, {
                debug: config.debug,
                lastActivityTimestamp: lastActivity,
            });
            if (optimized !== history) {
                history.length = 0;
                history.push(...optimized);
            }
            // 2. Microcompact: clear old tool results to save tokens
            const microCompacted = microCompact(history, 8);
            if (microCompacted !== history) {
                history.length = 0;
                history.push(...microCompacted);
            }
            // Auto-compact: summarize history if approaching context limit
            const { history: compacted, compacted: didCompact } = await autoCompactIfNeeded(history, config.model, client, config.debug);
            if (didCompact) {
                history.length = 0;
                history.push(...compacted);
                if (config.debug) {
                    console.error(`[runcode] History compacted: ~${estimateHistoryTokens(history)} tokens`);
                }
            }
            const systemPrompt = config.systemInstructions.join('\n\n');
            let maxTokens = maxTokensOverride ?? CAPPED_MAX_TOKENS;
            let responseParts;
            let usage;
            let stopReason;
            // Create streaming executor for concurrent tool execution
            const streamExec = new StreamingExecutor({
                handlers: capabilityMap,
                scope: { workingDir: workDir, abortSignal: abort.signal },
                permissions,
                onStart: (id, name) => onEvent({ kind: 'capability_start', id, name }),
            });
            try {
                const result = await client.complete({
                    model: config.model,
                    messages: history,
                    system: systemPrompt,
                    tools: toolDefs,
                    max_tokens: maxTokens,
                    stream: true,
                }, abort.signal, 
                // Start concurrent tools as soon as their input is fully received
                (tool) => streamExec.onToolReceived(tool), 
                // Stream text/thinking deltas to UI in real-time
                (delta) => {
                    if (delta.type === 'text') {
                        onEvent({ kind: 'text_delta', text: delta.text });
                    }
                    else if (delta.type === 'thinking') {
                        onEvent({ kind: 'thinking_delta', text: delta.text });
                    }
                });
                responseParts = result.content;
                usage = result.usage;
                stopReason = result.stopReason;
            }
            catch (err) {
                const errMsg = err.message || '';
                const errLower = errMsg.toLowerCase();
                // ── Prompt too long recovery ──
                if (errLower.includes('prompt is too long') && recoveryAttempts < 3) {
                    recoveryAttempts++;
                    if (config.debug) {
                        console.error(`[runcode] Prompt too long — forcing compact (attempt ${recoveryAttempts})`);
                    }
                    const { history: compactedAgain } = await autoCompactIfNeeded(history, config.model, client, config.debug);
                    history.length = 0;
                    history.push(...compactedAgain);
                    continue; // Retry
                }
                // ── Transient error recovery (network, rate limit, server errors) ──
                const isTransient = errLower.includes('429') || errLower.includes('rate')
                    || errLower.includes('500') || errLower.includes('502') || errLower.includes('503')
                    || errLower.includes('timeout') || errLower.includes('econnrefused')
                    || errLower.includes('econnreset') || errLower.includes('fetch failed');
                if (isTransient && recoveryAttempts < 3) {
                    recoveryAttempts++;
                    const backoffMs = Math.pow(2, recoveryAttempts) * 1000;
                    if (config.debug) {
                        console.error(`[runcode] Transient error — retrying in ${backoffMs / 1000}s (attempt ${recoveryAttempts}): ${errMsg.slice(0, 100)}`);
                    }
                    onEvent({ kind: 'text_delta', text: `\n*Retrying (${recoveryAttempts}/3)...*\n` });
                    await new Promise(r => setTimeout(r, backoffMs));
                    continue;
                }
                onEvent({ kind: 'turn_done', reason: 'error', error: errMsg });
                break;
            }
            onEvent({
                kind: 'usage',
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                model: config.model,
            });
            // Record usage for stats tracking (runcode stats command)
            // Rough cost estimate: use typical pricing if unknown
            const costEstimate = estimateCost(config.model, usage.inputTokens, usage.outputTokens);
            recordUsage(config.model, usage.inputTokens, usage.outputTokens, costEstimate, 0);
            // ── Max output tokens recovery ──
            if (stopReason === 'max_tokens' && recoveryAttempts < 3) {
                recoveryAttempts++;
                if (maxTokensOverride === undefined) {
                    // First hit: escalate to 64K
                    maxTokensOverride = ESCALATED_MAX_TOKENS;
                    if (config.debug) {
                        console.error(`[runcode] Max tokens hit — escalating to ${maxTokensOverride}`);
                    }
                }
                // Append what we got + a continuation prompt (text already streamed)
                history.push({ role: 'assistant', content: responseParts });
                history.push({
                    role: 'user',
                    content: 'Continue where you left off. Do not repeat what you already said.',
                });
                continue; // Retry with higher limit
            }
            // Reset recovery counter on successful completion
            recoveryAttempts = 0;
            // Extract tool invocations (text/thinking already streamed in real-time)
            const invocations = [];
            for (const part of responseParts) {
                if (part.type === 'tool_use') {
                    invocations.push(part);
                }
            }
            history.push({ role: 'assistant', content: responseParts });
            // No more capabilities → done with this user message
            if (invocations.length === 0) {
                onEvent({ kind: 'turn_done', reason: 'completed' });
                break;
            }
            // Collect results — concurrent tools may already be running from streaming
            const results = await streamExec.collectResults(invocations);
            for (const [inv, result] of results) {
                onEvent({ kind: 'capability_done', id: inv.id, result });
            }
            // Append outcomes
            const outcomeContent = results.map(([inv, result]) => ({
                type: 'tool_result',
                tool_use_id: inv.id,
                content: result.output,
                is_error: result.isError,
            }));
            history.push({ role: 'user', content: outcomeContent });
        }
        if (turnCount >= maxTurns) {
            onEvent({ kind: 'turn_done', reason: 'max_turns' });
        }
    }
    return history;
}
// Cost estimation now uses shared pricing from src/pricing.ts
