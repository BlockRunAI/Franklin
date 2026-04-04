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
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, VERSION } from '../config.js';
import { createSessionId, appendToSession, updateSessionMeta, pruneOldSessions, listSessions, loadSessionHistory, } from '../session/storage.js';
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
    // Session persistence
    const sessionId = createSessionId();
    let turnCount = 0;
    pruneOldSessions(); // Cleanup old sessions on start
    while (true) {
        let input = await getUserInput();
        if (input === null)
            break; // User wants to exit
        if (input === '')
            continue; // Empty input → re-prompt
        // Handle /stash and /unstash — git stash management
        if (input === '/stash') {
            try {
                const { execSync } = await import('node:child_process');
                const result = execSync('git stash push -m "runcode auto-stash"', {
                    cwd: config.workingDir || process.cwd(), encoding: 'utf-8', timeout: 10000
                }).trim();
                onEvent({ kind: 'text_delta', text: result || 'No changes to stash.\n' });
            }
            catch (e) {
                onEvent({ kind: 'text_delta', text: `Stash error: ${e.message?.split('\n')[0]}\n` });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        if (input === '/unstash') {
            try {
                const { execSync } = await import('node:child_process');
                const result = execSync('git stash pop', {
                    cwd: config.workingDir || process.cwd(), encoding: 'utf-8', timeout: 10000
                }).trim();
                onEvent({ kind: 'text_delta', text: result || 'Stash applied.\n' });
            }
            catch (e) {
                onEvent({ kind: 'text_delta', text: `Unstash error: ${e.message?.split('\n')[0]}\n` });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /branch — show current branch or create new
        if (input === '/branch' || input.startsWith('/branch ')) {
            try {
                const { execSync } = await import('node:child_process');
                const cwd = config.workingDir || process.cwd();
                if (input === '/branch') {
                    const branches = execSync('git branch -v --no-color', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
                    onEvent({ kind: 'text_delta', text: `\`\`\`\n${branches}\n\`\`\`\n` });
                }
                else {
                    const branchName = input.slice(8).trim();
                    execSync(`git checkout -b ${branchName}`, { cwd, encoding: 'utf-8', timeout: 5000 });
                    onEvent({ kind: 'text_delta', text: `Created and switched to branch: **${branchName}**\n` });
                }
            }
            catch (e) {
                onEvent({ kind: 'text_delta', text: `Git error: ${e.message?.split('\n')[0] || 'unknown'}\n` });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /log — show recent git log
        if (input === '/log') {
            try {
                const { execSync } = await import('node:child_process');
                const log = execSync('git log --oneline -15 --no-color', {
                    cwd: config.workingDir || process.cwd(), encoding: 'utf-8', timeout: 5000
                }).trim();
                onEvent({ kind: 'text_delta', text: log ? `\`\`\`\n${log}\n\`\`\`\n` : 'No commits.\n' });
            }
            catch {
                onEvent({ kind: 'text_delta', text: 'Not a git repo.\n' });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /bug — open issue tracker
        if (input === '/bug') {
            onEvent({ kind: 'text_delta', text: 'Report issues at: https://github.com/BlockRunAI/runcode/issues\n' });
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /version — show version
        if (input === '/version') {
            onEvent({ kind: 'text_delta', text: `RunCode v${VERSION}\n` });
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /tasks — show task list (shortcut for Task list action)
        if (input === '/tasks') {
            input = 'List all current tasks using the Task tool.';
        }
        // Handle /doctor — diagnose setup issues
        if (input === '/doctor') {
            const checks = [];
            const { execSync } = await import('node:child_process');
            // Check git
            try {
                execSync('git --version', { stdio: 'pipe' });
                checks.push('✓ git available');
            }
            catch {
                checks.push('✗ git not found');
            }
            // Check rg
            try {
                execSync('rg --version', { stdio: 'pipe' });
                checks.push('✓ ripgrep available');
            }
            catch {
                checks.push('⚠ ripgrep not found (using native grep fallback)');
            }
            // Check wallet
            const walletFile = path.join(BLOCKRUN_DIR, 'wallet.json');
            checks.push(fs.existsSync(walletFile) ? '✓ wallet configured' : '⚠ no wallet — run: runcode setup');
            // Check config
            const configFile = path.join(BLOCKRUN_DIR, 'runcode-config.json');
            checks.push(fs.existsSync(configFile) ? '✓ config file exists' : '⚠ no config — using defaults');
            // Model & tokens
            checks.push(`✓ model: ${config.model}`);
            checks.push(`✓ history: ${history.length} messages, ~${estimateHistoryTokens(history).toLocaleString()} tokens`);
            checks.push(`✓ session: ${sessionId}`);
            checks.push(`✓ version: v${VERSION}`);
            onEvent({ kind: 'text_delta', text: `**Health Check**\n${checks.map(c => '  ' + c).join('\n')}\n` });
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /commit — rewrite as a prompt for the agent
        if (input === '/commit') {
            input = 'Review the current git diff and staged changes. Stage relevant files with `git add`, then create a commit with a concise message summarizing the changes. Do NOT push to remote.';
        }
        // Handle /review — ask agent to review current changes
        if (input === '/review') {
            input = 'Review the current git diff. For each changed file, check for: bugs, security issues, missing error handling, performance problems, and style issues. Provide a brief summary of findings.';
        }
        // Handle /fix — ask agent to fix the last error or issue
        if (input === '/fix') {
            input = 'Look at the most recent error or issue we discussed and fix it. Check the relevant files, identify the root cause, and apply the fix.';
        }
        // Handle /test — run project tests
        if (input === '/test') {
            input = 'Detect the project test framework (look for package.json scripts, pytest, etc.) and run the test suite. Show a summary of results.';
        }
        // Handle /explain <file> — explain code
        if (input.startsWith('/explain ')) {
            const target = input.slice(9).trim();
            input = `Read and explain the code in ${target}. Cover: what it does, key functions/classes, how it connects to the rest of the codebase.`;
        }
        // Handle /search <query> — search codebase
        if (input.startsWith('/search ')) {
            const query = input.slice(8).trim();
            input = `Search the codebase for "${query}" using Grep. Show the matching files and relevant code context.`;
        }
        // Handle /find <pattern> — find files
        if (input.startsWith('/find ')) {
            const pattern = input.slice(6).trim();
            input = `Find files matching the pattern "${pattern}" using Glob. Show the results.`;
        }
        // Handle /refactor <description> — code refactoring
        if (input.startsWith('/refactor ')) {
            const desc = input.slice(10).trim();
            input = `Refactor: ${desc}. Read the relevant code first, then make targeted changes. Explain each change.`;
        }
        // Handle /debug — analyze recent error
        if (input === '/debug') {
            input = 'Look at the most recent error in this session. Read the relevant source files, analyze the root cause, and suggest a fix with specific code changes.';
        }
        // Handle /init — initialize project context
        if (input === '/init') {
            input = 'Read the project structure: check package.json (or equivalent), README, and key config files. Summarize: what this project is, main language/framework, entry points, and how to run/test it.';
        }
        // Handle /todo — find TODOs in codebase
        if (input === '/todo') {
            input = 'Search the codebase for TODO, FIXME, HACK, and XXX comments using Grep. Show the results grouped by file.';
        }
        // Handle /deps — show project dependencies
        if (input === '/deps') {
            input = 'Read the project dependency file (package.json, requirements.txt, go.mod, Cargo.toml, etc.) and list key dependencies with their versions.';
        }
        // Handle /status — show git status
        if (input === '/status') {
            try {
                const { execSync } = await import('node:child_process');
                const status = execSync('git status --short --branch', {
                    cwd: config.workingDir || process.cwd(),
                    encoding: 'utf-8',
                    timeout: 5_000,
                }).trim();
                onEvent({ kind: 'text_delta', text: status ? `\`\`\`\n${status}\n\`\`\`\n` : 'No git status.\n' });
            }
            catch {
                onEvent({ kind: 'text_delta', text: 'Not a git repo.\n' });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /diff — show git diff of current changes
        if (input === '/diff') {
            try {
                const { execSync } = await import('node:child_process');
                const diff = execSync('git diff --stat && echo "---" && git diff', {
                    cwd: config.workingDir || process.cwd(),
                    encoding: 'utf-8',
                    timeout: 10_000,
                    maxBuffer: 512 * 1024,
                }).trim();
                onEvent({ kind: 'text_delta', text: diff ? `\`\`\`diff\n${diff}\n\`\`\`\n` : 'No changes.\n' });
            }
            catch {
                onEvent({ kind: 'text_delta', text: 'Not a git repository or git not available.\n' });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /context — show current session context info
        if (input === '/context') {
            const tokens = estimateHistoryTokens(history);
            const msgs = history.length;
            const model = config.model;
            const dir = config.workingDir || process.cwd();
            const mode = config.permissionMode || 'default';
            onEvent({ kind: 'text_delta', text: `**Session Context**\n` +
                    `  Model:      ${model}\n` +
                    `  Mode:       ${mode}\n` +
                    `  Messages:   ${msgs}\n` +
                    `  Tokens:     ~${tokens.toLocaleString()}\n` +
                    `  Session:    ${sessionId}\n` +
                    `  Directory:  ${dir}\n`
            });
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /plan — enter plan mode (restrict to read-only tools)
        if (input === '/plan') {
            if (config.permissionMode === 'plan') {
                onEvent({ kind: 'text_delta', text: 'Already in plan mode. Use /execute to exit.\n' });
            }
            else {
                config.permissionMode = 'plan';
                onEvent({ kind: 'text_delta', text: '**Plan mode active.** Tools restricted to read-only. Use /execute when ready to implement.\n' });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /execute — exit plan mode
        if (input === '/execute') {
            if (config.permissionMode !== 'plan') {
                onEvent({ kind: 'text_delta', text: 'Not in plan mode. Use /plan to enter.\n' });
            }
            else {
                config.permissionMode = 'default';
                onEvent({ kind: 'text_delta', text: '**Execution mode.** All tools enabled with permissions.\n' });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /sessions — list saved sessions
        if (input === '/sessions') {
            const sessions = listSessions();
            if (sessions.length === 0) {
                onEvent({ kind: 'text_delta', text: 'No saved sessions.\n' });
            }
            else {
                let text = `**${sessions.length} saved sessions:**\n\n`;
                for (const s of sessions.slice(0, 10)) {
                    const date = new Date(s.updatedAt).toLocaleString();
                    const dir = s.workDir ? ` — ${s.workDir.split('/').pop()}` : '';
                    text += `  ${s.id}  ${s.model}  ${s.turnCount} turns  ${date}${dir}\n`;
                }
                if (sessions.length > 10)
                    text += `  ... and ${sessions.length - 10} more\n`;
                text += '\nUse /resume <session-id> to continue a session.\n';
                onEvent({ kind: 'text_delta', text });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
        // Handle /resume <id> — restore session history
        if (input.startsWith('/resume ')) {
            const targetId = input.slice(8).trim();
            const restored = loadSessionHistory(targetId);
            if (restored.length === 0) {
                onEvent({ kind: 'text_delta', text: `Session "${targetId}" not found or empty.\n` });
            }
            else {
                history.length = 0;
                history.push(...restored);
                onEvent({ kind: 'text_delta', text: `Restored ${restored.length} messages from ${targetId}. Continue where you left off.\n` });
            }
            onEvent({ kind: 'turn_done', reason: 'completed' });
            continue;
        }
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
        appendToSession(sessionId, { role: 'user', content: input });
        turnCount++;
        const abort = new AbortController();
        onAbortReady?.(() => abort.abort());
        let loopCount = 0;
        let recoveryAttempts = 0;
        let maxTokensOverride;
        const lastActivity = Date.now();
        // Agent loop for this user message
        while (loopCount < maxTurns) {
            loopCount++;
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
                // ── User abort (Esc key) ──
                if (err.name === 'AbortError' || abort.signal.aborted) {
                    onEvent({ kind: 'turn_done', reason: 'aborted' });
                    break;
                }
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
                // Add recovery suggestions based on error type
                let suggestion = '';
                if (errLower.includes('429') || errLower.includes('rate')) {
                    suggestion = '\nTip: Try /model to switch to a different model, or wait a moment and /retry.';
                }
                else if (errLower.includes('balance') || errLower.includes('insufficient') || errLower.includes('402')) {
                    suggestion = '\nTip: Run `runcode balance` to check funds. Try /model free for free models.';
                }
                else if (errLower.includes('timeout') || errLower.includes('econnrefused')) {
                    suggestion = '\nTip: Check your network connection. Use /retry to try again.';
                }
                else if (errLower.includes('prompt is too long')) {
                    suggestion = '\nTip: Run /compact to compress conversation history.';
                }
                onEvent({ kind: 'turn_done', reason: 'error', error: errMsg + suggestion });
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
                // Save session on completed turn
                appendToSession(sessionId, { role: 'assistant', content: responseParts });
                updateSessionMeta(sessionId, {
                    model: config.model,
                    workDir: config.workingDir || process.cwd(),
                    turnCount,
                    messageCount: history.length,
                });
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
        if (loopCount >= maxTurns) {
            onEvent({ kind: 'turn_done', reason: 'max_turns' });
        }
    }
    return history;
}
// Cost estimation now uses shared pricing from src/pricing.ts
