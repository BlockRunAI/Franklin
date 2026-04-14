/**
 * Franklin Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 */
import { ModelClient } from './llm.js';
import { autoCompactIfNeeded, forceCompact, microCompact } from './compact.js';
import { estimateHistoryTokens, updateActualTokens, resetTokenAnchor, getAnchoredTokenCount, getContextWindow, setEstimationModel } from './tokens.js';
import { handleSlashCommand } from './commands.js';
import { reduceTokens } from './reduce.js';
import { PermissionManager } from './permissions.js';
import { StreamingExecutor } from './streaming-executor.js';
import { optimizeHistory, CAPPED_MAX_TOKENS, ESCALATED_MAX_TOKENS, getMaxOutputTokens } from './optimize.js';
import { classifyAgentError } from './error-classifier.js';
import { SessionToolGuard } from './tool-guard.js';
import { recordUsage } from '../stats/tracker.js';
import { recordSessionUsage } from '../stats/session-tracker.js';
import { estimateCost, OPUS_PRICING } from '../pricing.js';
import { routeRequest, parseRoutingProfile } from '../router/index.js';
import { recordOutcome } from '../router/local-elo.js';
import { createSessionId, appendToSession, updateSessionMeta, pruneOldSessions, } from '../session/storage.js';
/**
 * Atomically replace all elements in a history array.
 * Safer than `history.length = 0; history.push(...)` because if push throws
 * (e.g., OOM), the array is already in its new state — not empty.
 * Uses splice to do a single atomic operation on the array.
 */
function replaceHistory(target, replacement) {
    target.splice(0, target.length, ...replacement);
}
/**
 * Sanitize history: fix orphaned tool results AND inject missing results.
 * Inspired by Claude Code's yieldMissingToolResultBlocks + Hermes _sanitize_api_messages().
 *
 * Two problems this solves:
 * 1. Orphaned tool_results — results without matching tool_use calls (remove them)
 * 2. Missing tool_results — tool_use calls without matching results (inject stubs)
 *    This happens when the model response includes tool calls that weren't executed
 *    (e.g., abort mid-stream, error before tool execution). The API requires every
 *    tool_use to have a corresponding tool_result or it rejects the request.
 */
function sanitizeHistory(history) {
    // Collect all tool_use IDs from assistant messages
    const callIds = new Set();
    // Collect all tool_result IDs from user messages
    const resultIds = new Set();
    for (const msg of history) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'tool_use' && part.id) {
                    callIds.add(part.id);
                }
            }
        }
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'tool_result' && part.tool_use_id) {
                    resultIds.add(part.tool_use_id);
                }
            }
        }
    }
    // 1. Remove orphaned tool results (results without matching calls)
    const orphanedResults = new Set([...resultIds].filter(id => !callIds.has(id)));
    // 2. Find missing tool results (calls without matching results)
    const missingResults = new Set([...callIds].filter(id => !resultIds.has(id)));
    if (orphanedResults.size === 0 && missingResults.size === 0)
        return history;
    const result = [];
    for (let i = 0; i < history.length; i++) {
        const msg = history[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            // Remove orphaned tool results
            if (orphanedResults.size > 0) {
                const filtered = msg.content.filter(p => !(p.type === 'tool_result' && orphanedResults.has(p.tool_use_id)));
                if (filtered.length === 0)
                    continue; // Skip empty messages
                result.push({ ...msg, content: filtered });
            }
            else {
                result.push(msg);
            }
            continue;
        }
        result.push(msg);
        // After each assistant message with tool_use, check if the next message
        // contains all the required tool_results. If not, inject stubs.
        if (msg.role === 'assistant' && Array.isArray(msg.content) && missingResults.size > 0) {
            const toolUseIds = [];
            for (const part of msg.content) {
                if (part.type === 'tool_use' && missingResults.has(part.id)) {
                    toolUseIds.push(part.id);
                }
            }
            if (toolUseIds.length > 0) {
                // Check if the next message already has some of these results
                const nextMsg = history[i + 1];
                const nextResultIds = new Set();
                if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
                    for (const part of nextMsg.content) {
                        if (part.type === 'tool_result') {
                            nextResultIds.add(part.tool_use_id);
                        }
                    }
                }
                // Inject stub results for any tool_use IDs that are truly missing
                const stubParts = [];
                for (const id of toolUseIds) {
                    if (!nextResultIds.has(id)) {
                        stubParts.push({
                            type: 'tool_result',
                            tool_use_id: id,
                            content: '[Tool execution was interrupted — result not available]',
                            is_error: true,
                        });
                        missingResults.delete(id); // Don't inject twice
                    }
                }
                if (stubParts.length > 0) {
                    // If next message is a user message, prepend stubs to it
                    if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
                        // Will be handled when we process that message next
                        const existingContent = orphanedResults.size > 0
                            ? nextMsg.content.filter(p => !(p.type === 'tool_result' && orphanedResults.has(p.tool_use_id)))
                            : [...nextMsg.content];
                        // Replace the next message with merged content
                        history[i + 1] = { role: 'user', content: [...stubParts, ...existingContent] };
                    }
                    else {
                        // No user message follows — insert a new one with the stubs
                        result.push({ role: 'user', content: stubParts });
                    }
                }
            }
        }
    }
    return result;
}
/**
 * Detect media-related errors (image too large, too many images, PDF too large).
 * These can be recovered by stripping media blocks and retrying.
 */
function isMediaSizeError(msg) {
    return ((msg.includes('image exceeds') && msg.includes('maximum')) ||
        (msg.includes('image dimensions exceed')) ||
        /maximum of \d+ PDF pages/.test(msg) ||
        (msg.includes('image') && msg.includes('too large')) ||
        (msg.includes('PDF') && msg.includes('too large')));
}
/**
 * Strip image and document blocks from history, replacing with text placeholders.
 * Used for media error recovery — retry without the oversized media.
 */
function stripMediaFromHistory(history) {
    let stripped = false;
    const result = history.map(msg => {
        if (typeof msg.content === 'string' || !Array.isArray(msg.content))
            return msg;
        let modified = false;
        const cleaned = msg.content.map((part) => {
            if (part.type === 'image') {
                modified = true;
                stripped = true;
                return { type: 'text', text: '[image removed — too large for context]' };
            }
            if (part.type === 'document') {
                modified = true;
                stripped = true;
                return { type: 'text', text: '[document removed — too large for context]' };
            }
            // Also strip media nested inside tool_result content arrays
            if (part.type === 'tool_result' && Array.isArray(part.content)) {
                const cleanedContent = part.content.map((c) => {
                    if (c.type === 'image' || c.type === 'document') {
                        modified = true;
                        stripped = true;
                        return { type: 'text', text: `[${c.type} removed — too large for context]` };
                    }
                    return c;
                });
                return modified ? { ...part, content: cleanedContent } : part;
            }
            return part;
        });
        return modified ? { ...msg, content: cleaned } : msg;
    });
    return { history: stripped ? result : history, stripped };
}
/**
 * Calculate backoff delay with jitter to avoid thundering herd.
 * Base: exponential (2^attempt * 1000ms), jitter: ±25%.
 */
function getBackoffDelay(attempt, maxDelayMs = 32_000) {
    const base = Math.min(Math.pow(2, attempt) * 1000, maxDelayMs);
    const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
    return Math.max(500, Math.round(base + jitter));
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
    const permissions = new PermissionManager(config.permissionMode ?? 'default', config.permissionPromptFn);
    const history = [];
    let lastUserInput = ''; // For /retry
    const originalModel = config.model; // Preserve original model/routing profile for recovery
    let turnFailedModels = new Set(); // Models that failed this turn (cleared each new turn)
    // Track models that failed with 402 (payment required) across turns.
    // These persist until the session ends — unlike transient errors, payment failures
    // will keep failing until the user adds funds. Map stores failure timestamp for future TTL.
    const paymentFailedModels = new Map(); // model → timestamp
    // Session persistence
    const sessionId = createSessionId();
    let turnCount = 0;
    let tokenBudgetWarned = false; // Emit token budget warning at most once per session
    let lastSessionActivity = Date.now();
    let lastRoutedModel = ''; // last model chosen by router (for local elo)
    let lastRoutedCategory = ''; // last category detected (for local elo)
    let sessionInputTokens = 0;
    let sessionOutputTokens = 0;
    let sessionCostUsd = 0;
    let sessionSavedVsOpus = 0;
    const toolGuard = new SessionToolGuard();
    const persistSessionMeta = () => {
        updateSessionMeta(sessionId, {
            model: config.model,
            workDir,
            turnCount,
            messageCount: history.length,
            inputTokens: sessionInputTokens,
            outputTokens: sessionOutputTokens,
            costUsd: sessionCostUsd,
            savedVsOpusUsd: sessionSavedVsOpus,
        });
    };
    const persistSessionMessage = (message) => {
        appendToSession(sessionId, message);
        persistSessionMeta();
    };
    pruneOldSessions(sessionId); // Cleanup old sessions on start, protect current
    persistSessionMeta();
    while (true) {
        let input = await getUserInput();
        if (input === null)
            break; // User wants to exit
        if (input === '')
            continue; // Empty input → re-prompt
        // ── Slash command dispatch ──
        if (input.startsWith('/')) {
            // /retry re-sends the last user message
            if (input === '/retry') {
                // Record retry as negative signal for local elo
                if (lastRoutedCategory && lastRoutedModel) {
                    recordOutcome(lastRoutedCategory, lastRoutedModel, 'retried');
                }
                if (!lastUserInput) {
                    onEvent({ kind: 'text_delta', text: 'No previous message to retry.\n' });
                    onEvent({ kind: 'turn_done', reason: 'completed' });
                    continue;
                }
                input = lastUserInput;
            }
            else {
                const cmdResult = await handleSlashCommand(input, {
                    history, config, client, sessionId, onEvent,
                });
                if (cmdResult.handled)
                    continue;
                if (cmdResult.rewritten)
                    input = cmdResult.rewritten;
            }
        }
        lastUserInput = input;
        history.push({ role: 'user', content: input });
        turnCount++;
        toolGuard.startTurn();
        persistSessionMessage({ role: 'user', content: input });
        // ── Model recovery: try original model at the start of each new turn ──
        // If we fell back to a free model last turn due to a transient error, try original again.
        // But DON'T reset if the original model had a payment failure — it will just fail again.
        if (config.model !== originalModel && !paymentFailedModels.has(originalModel)) {
            config.model = originalModel;
            config.onModelChange?.(originalModel);
        }
        turnFailedModels = new Set(); // Fresh slate for transient failures this turn
        const abort = new AbortController();
        onAbortReady?.(() => abort.abort());
        let loopCount = 0;
        let recoveryAttempts = 0;
        const MAX_RECOVERY_ATTEMPTS = 5; // Up from 3 — Claude Code uses 10, we split the difference
        let compactFailures = 0;
        let maxTokensOverride;
        const turnIdleReference = lastSessionActivity;
        lastSessionActivity = Date.now();
        // ── Tool call guardrails (inspired by hermes-agent) ──
        let turnToolCalls = 0; // Total tool calls this user turn
        const turnToolCounts = new Map(); // Per-tool-name counts this turn
        const readFileCache = new Set(); // Files already read (dedup)
        const MAX_TOOL_CALLS_PER_TURN = 25; // Hard cap per user turn
        const SAME_TOOL_WARN_THRESHOLD = 5; // Warn after N calls to same tool
        // Agent loop for this user message
        while (loopCount < maxTurns) {
            loopCount++;
            // Signal UI that a new LLM round is starting (shows spinner between tool results and next response)
            if (loopCount > 1) {
                onEvent({ kind: 'thinking_delta', text: '' });
            }
            // ── Token optimization pipeline ──
            // 1. Strip thinking, budget tool results, time-based cleanup (always — cheap)
            const optimized = optimizeHistory(history, {
                debug: config.debug,
                lastActivityTimestamp: loopCount === 1 ? turnIdleReference : lastSessionActivity,
            });
            if (optimized !== history) {
                replaceHistory(history, optimized);
            }
            // 2. Token reduction: age old results, normalize whitespace, trim verbose messages
            const reduced = reduceTokens(history, config.debug);
            if (reduced !== history) {
                replaceHistory(history, reduced);
            }
            // 3. Microcompact: clear old tool results to prevent context snowball
            if (history.length > 6) {
                const microCompacted = microCompact(history, 3);
                if (microCompacted !== history) {
                    replaceHistory(history, microCompacted);
                    resetTokenAnchor(); // History shrunk — resync token tracking
                }
            }
            // 3. Auto-compact: summarize history if approaching context limit
            // Circuit breaker: stop retrying after 3 consecutive failures
            if (compactFailures < 3) {
                try {
                    const { history: compacted, compacted: didCompact } = await autoCompactIfNeeded(history, config.model, client, config.debug);
                    if (didCompact) {
                        replaceHistory(history, compacted);
                        resetTokenAnchor();
                        compactFailures = 0;
                        if (config.debug) {
                            console.error(`[franklin] History compacted: ~${estimateHistoryTokens(history)} tokens`);
                        }
                    }
                }
                catch (compactErr) {
                    compactFailures++;
                    if (config.debug) {
                        console.error(`[franklin] Compaction failed (${compactFailures}/3): ${compactErr.message}`);
                    }
                }
            }
            // Inject ultrathink instruction when mode is active
            const systemParts = [...config.systemInstructions];
            if (config.ultrathink) {
                systemParts.push('# Ultrathink Mode\n' +
                    'You are in deep reasoning mode. Before responding to any request:\n' +
                    '1. Thoroughly analyze the problem from multiple angles\n' +
                    '2. Consider edge cases, failure modes, and second-order effects\n' +
                    '3. Challenge your initial assumptions before committing to an approach\n' +
                    '4. Think step by step — show your reasoning explicitly when it adds value\n' +
                    'Prioritize correctness and thoroughness over speed.');
            }
            const systemPrompt = systemParts.join('\n\n');
            const modelMaxOut = getMaxOutputTokens(config.model);
            let maxTokens = Math.min(maxTokensOverride ?? CAPPED_MAX_TOKENS, modelMaxOut);
            let responseParts = [];
            let usage;
            let stopReason;
            // Create streaming executor for concurrent tool execution
            const streamExec = new StreamingExecutor({
                handlers: capabilityMap,
                scope: { workingDir: workDir, abortSignal: abort.signal, onAskUser: config.onAskUser },
                permissions,
                guard: toolGuard,
                onStart: (id, name, preview) => onEvent({ kind: 'capability_start', id, name, preview }),
                onProgress: (id, text) => onEvent({ kind: 'capability_progress', id, text }),
                sessionId,
            });
            // ── Router: resolve routing profiles to concrete models ──
            const routingProfile = parseRoutingProfile(config.model);
            let resolvedModel = config.model;
            let routingTier;
            let routingConfidence;
            let routingSavings;
            if (routingProfile) {
                // Extract latest user text for classification
                const lastUser = [...history].reverse().find((m) => m.role === 'user');
                const userText = typeof lastUser?.content === 'string'
                    ? lastUser.content
                    : Array.isArray(lastUser?.content)
                        ? lastUser.content
                            .filter(p => p.type === 'text')
                            .map(p => p.text ?? '')
                            .join(' ')
                        : '';
                const routing = routeRequest(userText, routingProfile);
                resolvedModel = routing.model;
                routingTier = routing.tier;
                routingConfidence = routing.confidence;
                routingSavings = routing.savings;
                lastRoutedModel = routing.model;
                lastRoutedCategory = routing.signals[0] || '';
            }
            // Update token estimation model for more accurate byte-per-token ratio
            setEstimationModel(resolvedModel);
            // Safety net: handled in llm.ts resolveVirtualModel()
            // Sanitize: remove orphaned tool results that could confuse the API
            const sanitized = sanitizeHistory(history);
            if (sanitized.length !== history.length) {
                replaceHistory(history, sanitized);
            }
            try {
                const result = await client.complete({
                    model: resolvedModel,
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
                // ── Empty response recovery (inspired by Hermes _empty_content_retries) ──
                const hasText = responseParts.some(p => p.type === 'text' && p.text?.trim());
                const hasTools = responseParts.some(p => p.type === 'tool_use');
                const hasThinking = responseParts.some(p => p.type === 'thinking');
                if (!hasText && !hasTools && !hasThinking && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                    recoveryAttempts++;
                    if (config.debug) {
                        console.error(`[franklin] Empty response — retrying (${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);
                    }
                    onEvent({ kind: 'text_delta', text: `\n*Empty response — retrying (${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})...*\n` });
                    continue;
                }
            }
            catch (err) {
                // ── User abort (Esc key) ──
                if (err.name === 'AbortError' || abort.signal.aborted) {
                    // Save any partial response that was streamed before abort
                    if (responseParts && responseParts.length > 0) {
                        const partialAssistant = { role: 'assistant', content: responseParts };
                        history.push(partialAssistant);
                        persistSessionMessage(partialAssistant);
                    }
                    lastSessionActivity = Date.now();
                    persistSessionMeta();
                    onEvent({ kind: 'turn_done', reason: 'aborted' });
                    break;
                }
                const errMsg = err.message || '';
                const classified = classifyAgentError(errMsg);
                // ── Media size error recovery (strip images/PDFs + retry) ──
                if (isMediaSizeError(errMsg) && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                    recoveryAttempts++;
                    if (config.debug) {
                        console.error(`[franklin] Media too large — stripping and retrying (attempt ${recoveryAttempts})`);
                    }
                    const { history: stripped, stripped: didStrip } = stripMediaFromHistory(history);
                    if (didStrip) {
                        replaceHistory(history, stripped);
                        onEvent({ kind: 'text_delta', text: '\n*Media too large — retrying without images/documents...*\n' });
                        continue;
                    }
                    // No media to strip — fall through to other error handling
                }
                // ── Prompt too long recovery (reactive compaction) ──
                // Use forceCompact instead of autoCompactIfNeeded — the API already told us
                // the prompt is too long, so we must compact regardless of our threshold estimate.
                // This is the key insight from Claude Code: reactive compaction must FORCE compress.
                if (classified.category === 'context_limit' && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                    recoveryAttempts++;
                    if (config.debug) {
                        console.error(`[franklin] Prompt too long — force compacting (attempt ${recoveryAttempts})`);
                    }
                    onEvent({ kind: 'text_delta', text: '\n*Context limit hit — compacting conversation...*\n' });
                    const { history: compactedAgain } = await forceCompact(history, config.model, client, config.debug);
                    replaceHistory(history, compactedAgain);
                    resetTokenAnchor(); // History mutated — resync tracking
                    continue; // Retry
                }
                // ── Transient error recovery (network, rate limit, server errors) ──
                // Respect per-error maxRetries (e.g., 529/overloaded gets only 3 retries)
                const effectiveMaxRetries = classified.maxRetries ?? MAX_RECOVERY_ATTEMPTS;
                if (classified.isTransient && recoveryAttempts < effectiveMaxRetries) {
                    recoveryAttempts++;
                    const backoffMs = getBackoffDelay(recoveryAttempts);
                    if (config.debug) {
                        console.error(`[franklin] ${classified.label} error — retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${recoveryAttempts}/${effectiveMaxRetries}): ${errMsg.slice(0, 100)}`);
                    }
                    onEvent({
                        kind: 'text_delta',
                        text: `\n*Retrying (${recoveryAttempts}/${effectiveMaxRetries}) after ${classified.label} error...*\n`,
                    });
                    await new Promise(r => setTimeout(r, backoffMs));
                    continue;
                }
                // ── Payment failure: auto-fallback to free models ──
                // Track payment-failed models for the entire session — unlike transient errors,
                // 402s will keep failing until the user adds funds.
                if (classified.category === 'payment') {
                    turnFailedModels.add(config.model);
                    paymentFailedModels.set(config.model, Date.now());
                    // Record to local Elo so the router learns to avoid this model
                    if (lastRoutedCategory) {
                        recordOutcome(lastRoutedCategory, config.model, 'payment');
                    }
                    const FREE_MODELS = ['nvidia/qwen3-coder-480b', 'nvidia/nemotron-ultra-253b', 'nvidia/devstral-2-123b'];
                    const nextFree = FREE_MODELS.find(m => !turnFailedModels.has(m));
                    if (nextFree) {
                        const oldModel = config.model;
                        config.model = nextFree;
                        config.onModelChange?.(nextFree);
                        onEvent({ kind: 'text_delta', text: `\n*${oldModel} failed — switching to ${nextFree}*\n` });
                        continue; // Retry with next model
                    }
                }
                // ── Unrecoverable: show error with suggestion from classifier ──
                const suggestion = classified.suggestion ? `\nTip: ${classified.suggestion}` : '';
                onEvent({
                    kind: 'turn_done',
                    reason: 'error',
                    error: `[${classified.label}] ${errMsg}${suggestion}`,
                });
                lastSessionActivity = Date.now();
                persistSessionMeta();
                break;
            }
            // When API doesn't return input tokens (some models return 0), estimate from history
            const inputTokens = usage.inputTokens > 0
                ? usage.inputTokens
                : estimateHistoryTokens(history);
            // Anchor token tracking to actual API counts
            updateActualTokens(inputTokens, usage.outputTokens, history.length);
            const { contextUsagePct } = getAnchoredTokenCount(history);
            onEvent({
                kind: 'usage',
                inputTokens,
                outputTokens: usage.outputTokens,
                model: resolvedModel,
                calls: 1,
                tier: routingTier,
                confidence: routingConfidence,
                savings: routingSavings,
                contextPct: Math.round(contextUsagePct),
            });
            // Record usage for stats tracking (franklin stats command)
            const costEstimate = estimateCost(resolvedModel, inputTokens, usage.outputTokens, 1);
            recordUsage(resolvedModel, inputTokens, usage.outputTokens, costEstimate, 0);
            recordSessionUsage(resolvedModel, inputTokens, usage.outputTokens, costEstimate, routingTier);
            // Accumulate session-level totals for session meta
            sessionInputTokens += inputTokens;
            sessionOutputTokens += usage.outputTokens;
            sessionCostUsd += costEstimate;
            const opusCost = (inputTokens / 1_000_000) * OPUS_PRICING.input
                + (usage.outputTokens / 1_000_000) * OPUS_PRICING.output;
            sessionSavedVsOpus += Math.max(0, opusCost - costEstimate);
            // ── Max output tokens recovery ──
            if (stopReason === 'max_tokens' && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                recoveryAttempts++;
                if (maxTokensOverride === undefined) {
                    // First hit: escalate to 64K
                    maxTokensOverride = ESCALATED_MAX_TOKENS;
                    if (config.debug) {
                        console.error(`[franklin] Max tokens hit — escalating to ${maxTokensOverride}`);
                    }
                }
                // Append what we got + a continuation prompt (text already streamed)
                const partialAssistant = { role: 'assistant', content: responseParts };
                const continuationPrompt = {
                    role: 'user',
                    content: [
                        'Output token limit hit. Continue with these rules:',
                        '1. Resume directly — no apology, no recap of what you already said. Pick up mid-sentence if that is where the cut happened.',
                        '2. Do NOT repeat any text or code that was already output above.',
                        '3. Break remaining work into smaller pieces — use multiple tool calls if needed instead of one large output.',
                        '4. Skip extended reasoning for the continuation — focus on executing.',
                        '5. If you were in the middle of outputting code, finish the code block first.',
                    ].join('\n'),
                };
                history.push(partialAssistant);
                persistSessionMessage(partialAssistant);
                history.push(continuationPrompt);
                persistSessionMessage(continuationPrompt);
                lastSessionActivity = Date.now();
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
            const assistantMessage = { role: 'assistant', content: responseParts };
            history.push(assistantMessage);
            persistSessionMessage(assistantMessage);
            // No more capabilities → done with this user message
            if (invocations.length === 0) {
                lastSessionActivity = Date.now();
                persistSessionMeta();
                // Token budget warning — emit once per session when crossing 70%
                if (!tokenBudgetWarned) {
                    const { estimated } = getAnchoredTokenCount(history);
                    const contextWindow = getContextWindow(config.model);
                    const pct = (estimated / contextWindow) * 100;
                    if (pct >= 70) {
                        tokenBudgetWarned = true;
                        onEvent({
                            kind: 'text_delta',
                            text: `\n\n> **Token budget: ${pct.toFixed(0)}% used** (~${estimated.toLocaleString()} / ${(contextWindow / 1000).toFixed(0)}k tokens). Run \`/compact\` to free up space.\n`,
                        });
                    }
                }
                // Record success for local Elo learning (include tool call count for efficiency)
                if (lastRoutedCategory && lastRoutedModel) {
                    recordOutcome(lastRoutedCategory, lastRoutedModel, 'continued', turnToolCalls);
                }
                onEvent({ kind: 'turn_done', reason: 'completed' });
                break;
            }
            // Collect results — concurrent tools may already be running from streaming
            const results = await streamExec.collectResults(invocations);
            for (const [inv, result] of results) {
                onEvent({ kind: 'capability_done', id: inv.id, result });
            }
            // ── Tool call guardrails ──
            turnToolCalls += results.length;
            for (const [inv] of results) {
                const name = inv.name;
                turnToolCounts.set(name, (turnToolCounts.get(name) || 0) + 1);
                // Read file dedup: track paths already read
                if (name === 'Read' && inv.input.file_path) {
                    readFileCache.add(inv.input.file_path);
                }
            }
            // Refresh activity timestamp after tool execution
            lastSessionActivity = Date.now();
            // Append outcomes (with guardrail injections)
            const outcomeContent = results.map(([inv, result]) => {
                // Read file dedup: if this file was already read earlier in this turn,
                // replace content with a stub to save tokens
                if (inv.name === 'Read' && !result.isError) {
                    const fp = inv.input.file_path;
                    const count = results.filter(([i]) => i.name === 'Read' && i.input.file_path === fp).length;
                    if (count > 1 && inv !== results.filter(([i]) => i.name === 'Read' && i.input.file_path === fp).pop()?.[0]) {
                        return {
                            type: 'tool_result',
                            tool_use_id: inv.id,
                            content: `File already read in this turn. Refer to the other Read result for ${fp}.`,
                            is_error: false,
                        };
                    }
                }
                return {
                    type: 'tool_result',
                    tool_use_id: inv.id,
                    content: result.output,
                    is_error: result.isError,
                };
            });
            // ── Guardrail injections ──
            // Warn about same-tool repetition
            for (const [name, count] of turnToolCounts) {
                if (count === SAME_TOOL_WARN_THRESHOLD) {
                    outcomeContent.push({
                        type: 'tool_result',
                        tool_use_id: `guardrail-warn-${name}`,
                        content: `[SYSTEM] You have called ${name} ${count} times this turn. Stop and present your results now. Do not make more ${name} calls.`,
                        is_error: true,
                    });
                }
            }
            // Hard cap: stop the turn if too many tool calls
            if (turnToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
                outcomeContent.push({
                    type: 'tool_result',
                    tool_use_id: 'guardrail-cap',
                    content: `[SYSTEM] Tool call limit reached (${MAX_TOOL_CALLS_PER_TURN}). Present your results to the user NOW. Do not make any more tool calls.`,
                    is_error: true,
                });
            }
            const toolResultMessage = { role: 'user', content: outcomeContent };
            history.push(toolResultMessage);
            persistSessionMessage(toolResultMessage);
            // Hard stop: if cap exceeded, force end this agent loop iteration
            if (turnToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
                if (config.debug) {
                    console.error(`[franklin] Tool call cap hit: ${turnToolCalls} calls this turn`);
                }
                // Don't break — let the model respond one more time to summarize,
                // but inject the stop signal above so it knows to finish up.
            }
        }
        if (loopCount >= maxTurns) {
            lastSessionActivity = Date.now();
            persistSessionMeta();
            if (lastRoutedCategory && lastRoutedModel) {
                recordOutcome(lastRoutedCategory, lastRoutedModel, 'max_turns', turnToolCalls);
            }
            onEvent({ kind: 'turn_done', reason: 'max_turns' });
        }
    }
    return history;
}
// Cost estimation now uses shared pricing from src/pricing.ts
