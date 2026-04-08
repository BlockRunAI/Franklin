/**
 * runcode Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 * Original implementation with different architecture from any reference codebase.
 */

import { ModelClient } from './llm.js';
import { autoCompactIfNeeded, microCompact } from './compact.js';
import { estimateHistoryTokens, updateActualTokens, resetTokenAnchor, getAnchoredTokenCount, getContextWindow } from './tokens.js';
import { handleSlashCommand } from './commands.js';
import { reduceTokens } from './reduce.js';
import { PermissionManager } from './permissions.js';
import { StreamingExecutor } from './streaming-executor.js';
import { optimizeHistory, CAPPED_MAX_TOKENS, ESCALATED_MAX_TOKENS, getMaxOutputTokens } from './optimize.js';
import { recordUsage } from '../stats/tracker.js';
import { estimateCost } from '../pricing.js';
import {
  createSessionId,
  appendToSession,
  updateSessionMeta,
  pruneOldSessions,
} from '../session/storage.js';
import type {
  AgentConfig,
  CapabilityHandler,
  CapabilityInvocation,
  ContentPart,
  Dialogue,
  StreamEvent,
  UserContentPart,
} from './types.js';

// ─── Interactive Session ───────────────────────────────────────────────────

/**
 * Run a multi-turn interactive session.
 * Each user message triggers a full agent loop.
 * Returns the accumulated conversation history.
 */
export async function interactiveSession(
  config: AgentConfig,
  getUserInput: () => Promise<string | null>,
  onEvent: (event: StreamEvent) => void,
  onAbortReady?: (abort: () => void) => void
): Promise<Dialogue[]> {
  const client = new ModelClient({
    apiUrl: config.apiUrl,
    chain: config.chain,
    debug: config.debug,
  });

  const capabilityMap = new Map<string, CapabilityHandler>();
  for (const cap of config.capabilities) {
    capabilityMap.set(cap.spec.name, cap);
  }

  const toolDefs = config.capabilities.map((c) => c.spec);
  const maxTurns = config.maxTurns ?? 100;
  const workDir = config.workingDir ?? process.cwd();
  const permissions = new PermissionManager(
    config.permissionMode ?? 'default',
    config.permissionPromptFn
  );
  const history: Dialogue[] = [];
  let lastUserInput = ''; // For /retry

  // Session persistence
  const sessionId = createSessionId();
  let turnCount = 0;
  let tokenBudgetWarned = false; // Emit token budget warning at most once per session
  pruneOldSessions(sessionId); // Cleanup old sessions on start, protect current

  while (true) {
    let input = await getUserInput();
    if (input === null) break; // User wants to exit
    if (input === '') continue; // Empty input → re-prompt

    // ── Slash command dispatch ──
    if (input.startsWith('/')) {
      // /retry re-sends the last user message
      if (input === '/retry') {
        if (!lastUserInput) {
          onEvent({ kind: 'text_delta', text: 'No previous message to retry.\n' });
          onEvent({ kind: 'turn_done', reason: 'completed' });
          continue;
        }
        input = lastUserInput;
      } else {
        const cmdResult = await handleSlashCommand(input, {
          history, config, client, sessionId, onEvent,
        });
        if (cmdResult.handled) continue;
        if (cmdResult.rewritten) input = cmdResult.rewritten;
      }
    }

    lastUserInput = input;
    history.push({ role: 'user', content: input });
    appendToSession(sessionId, { role: 'user', content: input });
    turnCount++;

    const abort = new AbortController();
    onAbortReady?.(() => abort.abort());
    let loopCount = 0;
    let recoveryAttempts = 0;
    let compactFailures = 0;
    let maxTokensOverride: number | undefined;
    let lastActivity = Date.now();

    // Agent loop for this user message
    while (loopCount < maxTurns) {
      loopCount++;

      // ── Token optimization pipeline ──
      // 1. Strip thinking, budget tool results, time-based cleanup (always — cheap)
      const optimized = optimizeHistory(history, {
        debug: config.debug,
        lastActivityTimestamp: lastActivity,
      });
      if (optimized !== history) {
        history.length = 0;
        history.push(...optimized);
      }

      // 2. Token reduction: age old results, normalize whitespace, trim verbose messages
      const reduced = reduceTokens(history, config.debug);
      if (reduced !== history) {
        history.length = 0;
        history.push(...reduced);
      }

      // 3. Microcompact: clear old tool results to prevent context snowball
      if (history.length > 6) {
        const microCompacted = microCompact(history, 3);
        if (microCompacted !== history) {
          history.length = 0;
          history.push(...microCompacted);
          resetTokenAnchor(); // History shrunk — resync token tracking
        }
      }

      // 3. Auto-compact: summarize history if approaching context limit
      // Circuit breaker: stop retrying after 3 consecutive failures
      if (compactFailures < 3) {
        try {
          const { history: compacted, compacted: didCompact } =
            await autoCompactIfNeeded(history, config.model, client, config.debug);
          if (didCompact) {
            history.length = 0;
            history.push(...compacted);
            resetTokenAnchor();
            compactFailures = 0;
            if (config.debug) {
              console.error(`[runcode] History compacted: ~${estimateHistoryTokens(history)} tokens`);
            }
          }
        } catch (compactErr) {
          compactFailures++;
          if (config.debug) {
            console.error(`[runcode] Compaction failed (${compactFailures}/3): ${(compactErr as Error).message}`);
          }
        }
      }

      // Inject ultrathink instruction when mode is active
      const systemParts = [...config.systemInstructions];
      if ((config as { ultrathink?: boolean }).ultrathink) {
        systemParts.push(
          '# Ultrathink Mode\n' +
          'You are in deep reasoning mode. Before responding to any request:\n' +
          '1. Thoroughly analyze the problem from multiple angles\n' +
          '2. Consider edge cases, failure modes, and second-order effects\n' +
          '3. Challenge your initial assumptions before committing to an approach\n' +
          '4. Think step by step — show your reasoning explicitly when it adds value\n' +
          'Prioritize correctness and thoroughness over speed.'
        );
      }
      const systemPrompt = systemParts.join('\n\n');
      const modelMaxOut = getMaxOutputTokens(config.model);
      let maxTokens = Math.min(maxTokensOverride ?? CAPPED_MAX_TOKENS, modelMaxOut);
      let responseParts: ContentPart[] = [];
      let usage: { inputTokens: number; outputTokens: number };
      let stopReason: string;

      // Create streaming executor for concurrent tool execution
      const streamExec = new StreamingExecutor({
        handlers: capabilityMap,
        scope: { workingDir: workDir, abortSignal: abort.signal, onAskUser: config.onAskUser },
        permissions,
        onStart: (id, name, preview) => onEvent({ kind: 'capability_start', id, name, preview }),
        onProgress: (id, text) => onEvent({ kind: 'capability_progress', id, text }),
      });

      try {
        const result = await client.complete(
          {
            model: config.model,
            messages: history,
            system: systemPrompt,
            tools: toolDefs,
            max_tokens: maxTokens,
            stream: true,
          },
          abort.signal,
          // Start concurrent tools as soon as their input is fully received
          (tool) => streamExec.onToolReceived(tool),
          // Stream text/thinking deltas to UI in real-time
          (delta) => {
            if (delta.type === 'text') {
              onEvent({ kind: 'text_delta', text: delta.text });
            } else if (delta.type === 'thinking') {
              onEvent({ kind: 'thinking_delta', text: delta.text });
            }
          }
        );
        responseParts = result.content;
        usage = result.usage;
        stopReason = result.stopReason;
      } catch (err) {
        // ── User abort (Esc key) ──
        if ((err as Error).name === 'AbortError' || abort.signal.aborted) {
          // Save any partial response that was streamed before abort
          if (responseParts && responseParts.length > 0) {
            history.push({ role: 'assistant', content: responseParts });
            appendToSession(sessionId, { role: 'assistant', content: responseParts });
          }
          onEvent({ kind: 'turn_done', reason: 'aborted' });
          break;
        }

        const errMsg = (err as Error).message || '';
        const errLower = errMsg.toLowerCase();

        // ── Prompt too long recovery ──
        if (errLower.includes('prompt is too long') && recoveryAttempts < 3) {
          recoveryAttempts++;
          if (config.debug) {
            console.error(`[runcode] Prompt too long — forcing compact (attempt ${recoveryAttempts})`);
          }
          const { history: compactedAgain } =
            await autoCompactIfNeeded(history, config.model, client, config.debug);
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
        } else if (errLower.includes('balance') || errLower.includes('insufficient') || errLower.includes('402')
          || errLower.includes('payment') || errLower.includes('verification failed')) {
          // Auto-fallback to free model on payment failure
          // Use qwen3-coder: better instruction following than nemotron for coding tasks
          const FREE_MODEL = 'nvidia/qwen3-coder-480b';
          if (config.model !== FREE_MODEL && recoveryAttempts < 1) {
            recoveryAttempts++;
            const oldModel = config.model;
            config.model = FREE_MODEL;
            onEvent({ kind: 'text_delta', text: `\n*Payment failed on ${oldModel} — switching to free model (${FREE_MODEL})*\n` });
            continue; // Retry with free model
          }
          suggestion = '\nTip: Run `runcode balance` to check funds. Try /model free for free models.';
        } else if (errLower.includes('timeout') || errLower.includes('econnrefused')) {
          suggestion = '\nTip: Check your network connection. Use /retry to try again.';
        } else if (errLower.includes('prompt is too long')) {
          suggestion = '\nTip: Run /compact to compress conversation history.';
        }
        onEvent({ kind: 'turn_done', reason: 'error', error: errMsg + suggestion });
        break;
      }

      // When API doesn't return input tokens (some models return 0), estimate from history
      const inputTokens = usage.inputTokens > 0
        ? usage.inputTokens
        : estimateHistoryTokens(history);

      // Anchor token tracking to actual API counts
      updateActualTokens(inputTokens, usage.outputTokens, history.length);

      onEvent({
        kind: 'usage',
        inputTokens,
        outputTokens: usage.outputTokens,
        model: config.model,
        calls: 1,
      });

      // Record usage for stats tracking (runcode stats command)
      const costEstimate = estimateCost(config.model, inputTokens, usage.outputTokens, 1);
      recordUsage(config.model, inputTokens, usage.outputTokens, costEstimate, 0);

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
      const invocations: CapabilityInvocation[] = [];
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

        onEvent({ kind: 'turn_done', reason: 'completed' });
        break;
      }

      // Collect results — concurrent tools may already be running from streaming
      const results = await streamExec.collectResults(invocations);

      for (const [inv, result] of results) {
        onEvent({ kind: 'capability_done', id: inv.id, result });
      }

      // Refresh activity timestamp after tool execution
      lastActivity = Date.now();

      // Append outcomes
      const outcomeContent: UserContentPart[] = results.map(
        ([inv, result]) => ({
          type: 'tool_result' as const,
          tool_use_id: inv.id,
          content: result.output,
          is_error: result.isError,
        })
      );

      history.push({ role: 'user', content: outcomeContent });
    }

    if (loopCount >= maxTurns) {
      onEvent({ kind: 'turn_done', reason: 'max_turns' });
    }
  }

  return history;
}

// Cost estimation now uses shared pricing from src/pricing.ts
