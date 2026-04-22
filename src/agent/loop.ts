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
import { resetToolSessionState } from '../tools/index.js';
import { CORE_TOOL_NAMES, dynamicToolsEnabled } from '../tools/tool-categories.js';
import { createActivateToolCapability } from '../tools/activate.js';
import { recordUsage } from '../stats/tracker.js';
import { recordSessionUsage } from '../stats/session-tracker.js';
import { appendAudit, extractLastUserPrompt } from '../stats/audit.js';
import { estimateCost, OPUS_PRICING } from '../pricing.js';
import { maybeMidSessionExtract } from '../learnings/extractor.js';
import { extractMentions, buildEntityContext, loadEntities } from '../brain/store.js';
import { routeRequest, routeRequestAsync, parseRoutingProfile } from '../router/index.js';
import type { Tier, RoutingProfile } from '../router/index.js';
import { recordOutcome } from '../router/local-elo.js';
import { shouldPlan, getPlanningPrompt, getExecutorModel, isExecutorStuck, toolCallSignature } from './planner.js';
import { shouldVerify, runVerification } from './verification.js';
import {
  shouldCheckGrounding,
  checkGrounding,
  renderGroundingFollowup,
  buildGroundingRetryInstruction,
} from './evaluator.js';
import { augmentUserMessage, classifyIntent, prefetchForIntent } from './intent-prefetch.js';
import {
  createSessionId,
  appendToSession,
  updateSessionMeta,
  pruneOldSessions,
  loadSessionHistory,
  loadSessionMeta,
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

/**
 * Atomically replace all elements in a history array.
 * Safer than `history.length = 0; history.push(...)` because if push throws
 * (e.g., OOM), the array is already in its new state — not empty.
 * Uses splice to do a single atomic operation on the array.
 */
function replaceHistory(target: Dialogue[], replacement: Dialogue[]): void {
  target.splice(0, target.length, ...replacement);
}

// ─── Pushback detection ───────────────────────────────────────────────────
// Cheap models plough forward when users correct them. This detects common
// correction patterns so the agent can explicitly reset its approach.
//
// Precision-biased: we'd rather miss a real pushback than falsely trigger on
// casual disagreement ("But how do I deploy?"). False positives pollute the
// conversation and make the agent abandon working approaches unnecessarily.

// STRONG patterns: high-precision correction language. Fires even on short input.
const PUSHBACK_STRONG: RegExp[] = [
  /\b(that'?s?\s+(wrong|incorrect|not\s+right)|you'?re?\s+wrong)\b/i,
  /\b(i\s+(said|told\s+you)|not\s+what\s+i)\b/i,
  /^(stop|wrong|incorrect|try\s+again)\b/i,
  /^(不对|不是|错了|再试|重来)/,
];

// WEAK patterns: common correction starters that also appear in casual speech.
// Require a corroborating signal (see detectPushback) to count as pushback.
const PUSHBACK_WEAK: RegExp[] = [
  /^(but|however|actually|wait|no+\b|hmm)\b/i,
  /\b(we\s+are\s+using|the\s+correct|the\s+actual)\b/i,
  /^(但是|其实|等等|停)/,
];

/**
 * True if the last assistant turn made a concrete claim worth pushing back
 * against: executed a tool, wrote code, or produced a non-trivial answer.
 * Casual assistant chatter doesn't warrant treating a "but" as a correction.
 */
function lastAssistantHasClaim(history: Dialogue[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const p = part as { type?: string; text?: string };
        if (p.type === 'tool_use') return true;
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length >= 40) {
          return true;
        }
      }
      return false;
    }
    if (typeof msg.content === 'string' && msg.content.trim().length >= 40) return true;
    return false;
  }
  return false;
}

function detectPushback(input: string, history: Dialogue[]): boolean {
  // Only count as pushback if there's a prior assistant turn to push back against.
  if (history.length === 0) return false;
  if (!lastAssistantHasClaim(history)) return false;

  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return false;

  // Strong patterns: direct correction language — fire immediately.
  if (PUSHBACK_STRONG.some((re) => re.test(trimmed))) return true;

  // Weak patterns: only count if the message is short (< 120 chars) AND doesn't
  // also contain a fresh request. A weak starter followed by "can you also X"
  // or "please do Y" is scope addition, not correction.
  if (PUSHBACK_WEAK.some((re) => re.test(trimmed))) {
    if (trimmed.length > 120) return false;
    if (/\b(can you|could you|please|also|add|include)\b/i.test(trimmed)) return false;
    return true;
  }

  return false;
}

/**
 * Sanitize history: fix orphaned tool results AND inject missing results.
 *
 * Two problems this solves:
 * 1. Orphaned tool_results — results without matching tool_use calls (remove them)
 * 2. Missing tool_results — tool_use calls without matching results (inject stubs)
 *    This happens when the model response includes tool calls that weren't executed
 *    (e.g., abort mid-stream, error before tool execution). The API requires every
 *    tool_use to have a corresponding tool_result or it rejects the request.
 */
function sanitizeHistory(history: Dialogue[]): Dialogue[] {
  // Collect all tool_use IDs from assistant messages
  const callIds = new Set<string>();
  // Collect all tool_result IDs from user messages
  const resultIds = new Set<string>();

  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ((part as any).type === 'tool_use' && (part as any).id) {
          callIds.add((part as any).id);
        }
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ((part as any).type === 'tool_result' && (part as any).tool_use_id) {
          resultIds.add((part as any).tool_use_id);
        }
      }
    }
  }

  // 1. Remove orphaned tool results (results without matching calls)
  const orphanedResults = new Set([...resultIds].filter(id => !callIds.has(id)));

  // 2. Find missing tool results (calls without matching results)
  const missingResults = new Set([...callIds].filter(id => !resultIds.has(id)));

  if (orphanedResults.size === 0 && missingResults.size === 0) return history;

  const result: Dialogue[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Remove orphaned tool results
      if (orphanedResults.size > 0) {
        const filtered = (msg.content as any[]).filter(
          p => !(p.type === 'tool_result' && orphanedResults.has(p.tool_use_id))
        );
        if (filtered.length === 0) continue; // Skip empty messages
        result.push({ ...msg, content: filtered });
      } else {
        result.push(msg);
      }
      continue;
    }

    result.push(msg);

    // After each assistant message with tool_use, check if the next message
    // contains all the required tool_results. If not, inject stubs.
    if (msg.role === 'assistant' && Array.isArray(msg.content) && missingResults.size > 0) {
      const toolUseIds: string[] = [];
      for (const part of msg.content as any[]) {
        if (part.type === 'tool_use' && missingResults.has(part.id)) {
          toolUseIds.push(part.id);
        }
      }

      if (toolUseIds.length > 0) {
        // Check if the next message already has some of these results
        const nextMsg = history[i + 1];
        const nextResultIds = new Set<string>();
        if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
          for (const part of nextMsg.content as any[]) {
            if (part.type === 'tool_result') {
              nextResultIds.add(part.tool_use_id);
            }
          }
        }

        // Inject stub results for any tool_use IDs that are truly missing
        const stubParts: UserContentPart[] = [];
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
              ? (nextMsg.content as any[]).filter(
                  p => !(p.type === 'tool_result' && orphanedResults.has(p.tool_use_id))
                )
              : [...(nextMsg.content as any[])];
            // Replace the next message with merged content
            history[i + 1] = { role: 'user', content: [...stubParts, ...existingContent] };
          } else {
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
function isMediaSizeError(msg: string): boolean {
  return (
    (msg.includes('image exceeds') && msg.includes('maximum')) ||
    (msg.includes('image dimensions exceed')) ||
    /maximum of \d+ PDF pages/.test(msg) ||
    (msg.includes('image') && msg.includes('too large')) ||
    (msg.includes('PDF') && msg.includes('too large'))
  );
}

/**
 * Strip image and document blocks from history, replacing with text placeholders.
 * Used for media error recovery — retry without the oversized media.
 */
function stripMediaFromHistory(history: Dialogue[]): { history: Dialogue[]; stripped: boolean } {
  let stripped = false;
  const result = history.map(msg => {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) return msg;

    let modified = false;
    const cleaned = msg.content.map((part: any) => {
      if (part.type === 'image') {
        modified = true;
        stripped = true;
        return { type: 'text' as const, text: '[image removed — too large for context]' };
      }
      if (part.type === 'document') {
        modified = true;
        stripped = true;
        return { type: 'text' as const, text: '[document removed — too large for context]' };
      }
      // Also strip media nested inside tool_result content arrays
      if (part.type === 'tool_result' && Array.isArray(part.content)) {
        const cleanedContent = part.content.map((c: any) => {
          if (c.type === 'image' || c.type === 'document') {
            modified = true;
            stripped = true;
            return { type: 'text' as const, text: `[${c.type} removed — too large for context]` };
          }
          return c;
        });
        return modified ? { ...part, content: cleanedContent } : part;
      }
      return part;
    });

    return modified ? { ...msg, content: cleaned } : msg;
  }) as Dialogue[];

  return { history: stripped ? result : history, stripped };
}

/**
 * Calculate backoff delay with jitter to avoid thundering herd.
 * Base: exponential (2^attempt * 1000ms), jitter: ±25%.
 */
function getBackoffDelay(attempt: number, maxDelayMs = 32_000): number {
  const base = Math.min(Math.pow(2, attempt) * 1000, maxDelayMs);
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.max(500, Math.round(base + jitter));
}

/**
 * Identify models known to hallucinate tool calls (invented names, literal
 * `[TOOLCALL]` / `<tool_call>` text in answers) — they need the explicit
 * "Available tools" inventory appended to the system prompt. Strong frontier
 * models skip the nag so their prompt cache doesn't turn over.
 *
 * Exported so tests can pin the classification without a live API.
 */
export function isWeakModel(model: string): boolean {
  const m = model.toLowerCase();
  // NVIDIA-hosted open models have been observed confabulating tool calls.
  // `blockrun/free` and `blockrun/eco` resolve to nvidia/nemotron-ultra in
  // llm.ts, so catching the `nvidia/` prefix also catches those paths.
  if (m.startsWith('nvidia/')) return true;
  if (m.includes('nemotron-ultra')) return true;
  if (m.includes('qwen3-coder')) return true;
  // GLM-4* is weak; GLM-5+ is capable enough to skip the nag.
  if (/^zai\/glm-4/.test(m)) return true;
  // DeepSeek's smaller / quantized SKUs tend to role-play tools too.
  if (/deepseek[-_/](r1|v3|chat)-?(lite|mini|tiny)/.test(m)) return true;
  return false;
}

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
  // Clear module-level tool caches left over from a prior session in the same
  // process. Matters when Franklin is used as a library or driven by tests
  // that call interactiveSession() more than once — stale fileReadTracker /
  // fetchCache / backgroundTasks entries from the previous run would otherwise
  // fool Edit/Write into skipping the read-before-edit check or serve cached
  // webfetch content fetched under the previous session's intent.
  resetToolSessionState();

  const client = new ModelClient({
    apiUrl: config.apiUrl,
    chain: config.chain,
    debug: config.debug,
  });

  // ── Dynamic tool visibility ──
  // Register ActivateTool before building the capability map so the agent
  // can always reach the meta-tool. When FRANKLIN_DYNAMIC_TOOLS=0 is set,
  // `activeTools` is seeded with every registered name — behaves as the
  // pre-3.8.9 static registry.
  const capabilityMap = new Map<string, CapabilityHandler>();
  for (const cap of config.capabilities) {
    capabilityMap.set(cap.spec.name, cap);
  }
  const activeTools: Set<string> = new Set();
  const dynamicTools = dynamicToolsEnabled();
  if (dynamicTools) {
    for (const name of CORE_TOOL_NAMES) {
      if (capabilityMap.has(name)) activeTools.add(name);
    }
  } else {
    for (const cap of config.capabilities) activeTools.add(cap.spec.name);
  }
  const activateToolCap = createActivateToolCapability({ activeTools, allTools: capabilityMap });
  capabilityMap.set(activateToolCap.spec.name, activateToolCap);
  if (dynamicTools) activeTools.add(activateToolCap.spec.name);

  const allToolDefs = [...capabilityMap.values()].map(c => c.spec);
  const buildCallToolDefs = () =>
    dynamicTools ? allToolDefs.filter(t => activeTools.has(t.name)) : allToolDefs;
  const buildActiveCapabilityMap = () =>
    dynamicTools
      ? new Map([...capabilityMap.entries()].filter(([name]) => activeTools.has(name)))
      : capabilityMap;

  const maxTurns = config.maxTurns ?? 15;
  const workDir = config.workingDir ?? process.cwd();
  const permissions = new PermissionManager(
    config.permissionMode ?? 'default',
    config.permissionPromptFn
  );
  const history: Dialogue[] = [];
  let lastUserInput = ''; // For /retry
  config.baseModel = config.model; // User's intended model — /model command updates this
  let turnFailedModels = new Set<string>(); // Models that failed this turn (cleared each new turn)
  // Track models that failed with 402 (payment required) across turns.
  // These persist until the session ends — unlike transient errors, payment failures
  // will keep failing until the user adds funds. Map stores failure timestamp for future TTL.
  const paymentFailedModels = new Map<string, number>(); // model → timestamp

  // Plan-then-execute: session-level disable flag lives on config (set by /noplan command)

  // Session persistence — reuse existing session ID when resuming, else create new
  const sessionId = config.resumeSessionId || createSessionId();
  let turnCount = 0;

  // Resume: hydrate history from the saved JSONL transcript.
  // Sanitize to drop any orphaned tool_use / tool_result pairs from a crash.
  if (config.resumeSessionId) {
    const prior = loadSessionHistory(config.resumeSessionId);
    if (prior.length > 0) {
      const sanitized = sanitizeHistory(prior);
      replaceHistory(history, sanitized);
      const meta = loadSessionMeta(config.resumeSessionId);
      if (meta) {
        turnCount = meta.turnCount ?? 0;
      }
    }
  }
  let tokenBudgetWarned = false; // Emit token budget warning at most once per session
  let lastSessionActivity = Date.now();
  let lastRoutedModel = '';   // last model chosen by router (for local elo)
  let lastRoutedCategory = ''; // last category detected (for local elo)
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let sessionCostUsd = 0;
  let sessionSavedVsOpus = 0;
  // Per-tool call counts aggregated across every turn. Session-scope, not
  // per-turn. Counts the *name* of each tool invocation only — no inputs,
  // outputs, or paths. Fed into opt-in telemetry at session end.
  const sessionToolCounts = new Map<string, number>();
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
      ...(config.sessionChannel !== undefined ? { channel: config.sessionChannel } : {}),
      ...(sessionToolCounts.size > 0
        ? { toolCallCounts: Object.fromEntries(sessionToolCounts) }
        : {}),
    });
  };
  const persistSessionMessage = (message: Dialogue) => {
    appendToSession(sessionId, message);
    persistSessionMeta();
  };
  pruneOldSessions(sessionId); // Cleanup old sessions on start, protect current
  persistSessionMeta();

  // Flush session meta on SIGINT/SIGTERM so mid-stream Ctrl+C doesn't
  // leave a stale .meta.json (wrong turnCount/messageCount/cost).
  const exitFlush = () => {
    try { persistSessionMeta(); } catch { /* best effort */ }
  };
  process.once('SIGINT', exitFlush);
  process.once('SIGTERM', exitFlush);

  while (true) {
    let input = await getUserInput();
    if (input === null) break; // User wants to exit
    if (input === '') continue; // Empty input → re-prompt

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
      } else {
        const cmdResult = await handleSlashCommand(input, {
          history, config, client, sessionId, onEvent,
        });
        if (cmdResult.handled) continue;
        if (cmdResult.rewritten) input = cmdResult.rewritten;
      }
    }

    // ── Pushback detection ──
    // When the user corrects us ("no", "but", "actually", "wrong"), we must throw
    // away the previous plan and reconsider — not continue the failing approach.
    // Without this signal, cheap models tend to plough forward with the same bad idea.
    const pushbackSignal = detectPushback(input, history);
    const effectiveInput = pushbackSignal
      ? `${input}\n\n[SYSTEM NOTE] The user is correcting you. Your previous response was wrong or off-target. Do NOT continue the previous approach. Re-read the conversation, identify what specifically the user is correcting, and change your strategy. If the user pointed out a fact (e.g. "we are using X"), treat that fact as ground truth and rebuild your answer around it.`
      : input;

    lastUserInput = input;
    history.push({ role: 'user', content: effectiveInput });
    turnCount++;
    toolGuard.startTurn();
    // Persist the user's original message, not the injected SYSTEM NOTE scaffold.
    // Resumed sessions should show what the user typed, not our internal prompt engineering.
    persistSessionMessage({ role: 'user', content: input });

    // ── Model recovery: try original model at the start of each new turn ──
    // If we fell back to a free model last turn due to a transient error, try original again.
    // But DON'T reset if the original model had a payment failure — it will just fail again.
    const baseModel = config.baseModel ?? config.model;
    if (config.model !== baseModel && !paymentFailedModels.has(baseModel)) {
      config.model = baseModel;
      config.onModelChange?.(baseModel, 'system');
    }
    turnFailedModels = new Set<string>(); // Fresh slate for transient failures this turn

    // ── Brain auto-recall (computed once per user turn) ──
    // Scan the new user message plus the previous assistant reply (so
    // cross-turn references like "that company we discussed" still resolve)
    // for entity mentions, and build the context string. The inner agent
    // loop can iterate many times (planner + executor steps); the user's
    // input doesn't change between those iterations, so caching here saves
    // loadEntities + loadObservations + loadRelations on every re-entry.
    let turnBrainContext = '';
    try {
      const lastAssistantBeforeThisTurn = [...history.slice(0, -1)]
        .reverse()
        .find((m: Dialogue) => m.role === 'assistant');
      const flatten = (d: Dialogue | undefined): string => {
        if (!d) return '';
        if (typeof d.content === 'string') return d.content;
        if (!Array.isArray(d.content)) return '';
        return (d.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text')
          .map(p => p.text ?? '')
          .join(' ');
      };
      const scanText = input + '\n' + flatten(lastAssistantBeforeThisTurn);
      if (scanText.trim().length > 0) {
        const entities = loadEntities();
        if (entities.length > 0) {
          const mentioned = extractMentions(scanText, entities);
          if (mentioned.length > 0) {
            turnBrainContext = buildEntityContext(mentioned, entities) ?? '';
          }
        }
      }
    } catch {
      /* brain is optional — never block a turn on recall */
    }

    const abort = new AbortController();
    onAbortReady?.(() => abort.abort());
    let loopCount = 0;
    let recoveryAttempts = 0;
    const MAX_RECOVERY_ATTEMPTS = 5;
    let compactFailures = 0;
    let maxTokensOverride: number | undefined;
    const turnIdleReference = lastSessionActivity;
    lastSessionActivity = Date.now();

    // ── Grounding retry state (per turn) ──
    // When the post-response evaluator finds UNGROUNDED claims, we inject a
    // corrective user message and re-enter the loop so the generator can
    // answer again with the missing tool calls. 1-retry cap: if round 2
    // still UNGROUNDED, ship the annotated response and let the user
    // decide — avoids pathological loops, caps wall-clock cost.
    let groundingRetryCount = 0;
    const MAX_GROUNDING_RETRIES = 1;

    // ── Plan-then-execute state (per turn) ──
    let planActive = false;
    let planPlannerModel = '';
    let planExecutorModel = '';
    let planEscalationCount = 0;
    let planConsecutiveErrors = 0;
    let lastToolSig = '';  // For same-tool repeat detection

    // ── Tool call guardrails (inspired by hermes-agent) ──
    let turnToolCalls = 0;                              // Total tool calls this user turn
    const turnToolCounts = new Map<string, number>();    // Per-tool-name counts this turn
    const readFileCache = new Set<string>();             // Files already read (dedup)
    const MAX_TOOL_CALLS_PER_TURN = 25;                 // Hard cap per user turn
    const SAME_TOOL_WARN_THRESHOLD = 3;                 // Warn after N calls to same tool (lowered from 5 — search loops were wasting turns)

    // ── No-progress guardrail: kill infinite tiny-response loops ──
    let consecutiveTinyResponses = 0;                    // Count of consecutive calls with <10 output tokens
    const MAX_TINY_RESPONSES = 2;                        // Break after N tiny responses — if 2 calls return near-empty, something is wrong
    let turnSpend = 0;                                   // Cost spent this user turn (USD)
    const MAX_TURN_SPEND_USD = 0.25;                    // Hard circuit breaker per user message (lowered — user wallets are real money)

    // ── Proactive prefetch ────────────────────────────────────────────
    // Before the main model gets a chance to answer a live-world question
    // from stale training data, the harness detects ticker / price / news
    // intent and fetches the data itself. Result is prepended to the user's
    // message so the model sees it as ground truth for this turn. This
    // makes the answer tool-grounded regardless of the model's willingness
    // to call tools on its own — important for models with strong
    // refusal priors on financial data.
    try {
      const intent = await classifyIntent(input, client);
      if (intent) {
        const prefetch = await prefetchForIntent(intent, client);
        if (prefetch && prefetch.anyOk) {
          if (config.showPrefetchStatus !== false) {
            onEvent({ kind: 'text_delta', text: `\n${prefetch.statusLine}\n\n` });
          }
          // Augment the last user message in history (NOT lastUserInput,
          // which /retry restores — that should remain the user's original).
          const lastIdx = history.length - 1;
          const last = history[lastIdx];
          if (last && last.role === 'user' && typeof last.content === 'string') {
            history[lastIdx] = augmentUserMessage(last.content, prefetch);
          }
        }
      }
    } catch {
      // Prefetch is best-effort — if the classifier or any fetch trips,
      // fall through and let the main loop do its own thing.
    }

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
          const { history: compacted, compacted: didCompact } =
            await autoCompactIfNeeded(history, config.model, client, config.debug);
          if (didCompact) {
            replaceHistory(history, compacted);
            resetTokenAnchor();
            compactFailures = 0;
            if (config.debug) {
              console.error(`[franklin] History compacted: ~${estimateHistoryTokens(history)} tokens`);
            }
          }
        } catch (compactErr) {
          compactFailures++;
          if (config.debug) {
            console.error(`[franklin] Compaction failed (${compactFailures}/3): ${(compactErr as Error).message}`);
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

      // ── Dynamic tool visibility hint ──
      // When the core/on-demand split is active, tell every model up front
      // that its tool list is intentionally small and that extras can be
      // pulled via ActivateTool. Kept byte-stable across turns (no tool
      // names inlined) so the prompt cache still holds.
      if (dynamicTools && allToolDefs.length > activeTools.size) {
        systemParts.push(
          '# Tool Inventory\n' +
          'Your current tool list is intentionally minimal. Additional tools ' +
          '(web search, image/video/music generation, trading, content, brain ' +
          'recall, etc.) are available on demand. Call `ActivateTool()` with ' +
          'no arguments to see what is available, then call `ActivateTool({ ' +
          '"names": ["<name>"] })` to enable the ones you need. Activated ' +
          'tools become visible on the next turn.',
        );
      }

      // ── Context awareness injection ──
      // Tell the model how full its context window is so it can self-regulate.
      // At high usage, nudge it to be concise and avoid unnecessary tool calls.
      //
      // IMPORTANT: this text is appended to the system prompt, which carries a
      // prompt-cache breakpoint on Anthropic. Including the exact percentage
      // invalidated the cache on every turn (the string differed by a digit).
      // Bucketing the signal to coarse bands (>50 / >65 / >80) keeps the text
      // byte-identical across many consecutive turns, so the cache actually
      // holds. The model doesn't need 3% precision to self-regulate.
      const { contextUsagePct: preCallPct } = getAnchoredTokenCount(history);
      if (preCallPct > 80) {
        systemParts.push(
          '# Context Window Status\nContext window is critically full (>80%). ' +
          'Be extremely concise. Avoid re-reading files already in context. ' +
          'Prioritize completing the current task over exploring new questions.',
        );
      } else if (preCallPct > 65) {
        systemParts.push(
          '# Context Window Status\nContext window is more than two-thirds full (>65%). ' +
          'Be concise in responses. Avoid unnecessary tool calls. ' +
          'Do not re-read files you already have in context.',
        );
      } else if (preCallPct > 50) {
        systemParts.push(
          '# Context Window Status\nContext window has crossed the halfway mark (>50%). ' +
          'Prefer concise responses and batch tool calls when possible.',
        );
      }

      // ── Brain auto-recall (computed once per user turn above) ──
      if (turnBrainContext) systemParts.push(turnBrainContext);

      const systemPrompt = systemParts.join('\n\n');
      const modelMaxOut = getMaxOutputTokens(config.model);
      let maxTokens = Math.min(maxTokensOverride ?? CAPPED_MAX_TOKENS, modelMaxOut);
      let responseParts: ContentPart[] = [];
      let usage: { inputTokens: number; outputTokens: number };
      let stopReason: string;

      // Create streaming executor for concurrent tool execution
      const activeCapabilityMap = buildActiveCapabilityMap();
      const streamExec = new StreamingExecutor({
        handlers: activeCapabilityMap,
        scope: {
          workingDir: workDir,
          abortSignal: abort.signal,
          onAskUser: config.onAskUser,
          parentContext: {
            goal: lastUserInput?.slice(0, 200),
            recentFiles: [...readFileCache].slice(-10),
          },
        },
        permissions,
        guard: toolGuard,
        onStart: (id, name, preview) => onEvent({ kind: 'capability_start', id, name, preview }),
        onProgress: (id, text) => onEvent({ kind: 'capability_progress', id, text }),
        sessionId,
      });

      // ── Router: resolve routing profiles to concrete models ──
      const routingProfile = parseRoutingProfile(config.model);
      let resolvedModel = config.model;
      let routingTier: Tier | undefined;
      let routingConfidence: number | undefined;
      let routingSavings: number | undefined;
      if (routingProfile) {
        // Extract latest user text for classification
        const lastUser = [...history].reverse().find((m: Dialogue) => m.role === 'user');
        const userText = typeof lastUser?.content === 'string'
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? (lastUser!.content as Array<{ type: string; text?: string }>)
                .filter(p => p.type === 'text')
                .map(p => p.text ?? '')
                .join(' ')
            : '';
        const routing = await routeRequestAsync(userText, routingProfile);
        resolvedModel = routing.model;
        routingTier = routing.tier;
        routingConfidence = routing.confidence;
        routingSavings = routing.savings;
        lastRoutedModel = routing.model;
        lastRoutedCategory = routing.signals[0] || '';
        // Surface the routing decision so users know which concrete model
        // just got picked. Without this the status bar reads "auto" and
        // users have no idea what's actually running — or worse, they
        // believe they're stuck on the last-seen concrete name.
        if (loopCount === 1) {
          onEvent({
            kind: 'text_delta',
            text: `*Auto → ${routing.model}*\n\n`,
          });
        }
      }

      // Update token estimation model for more accurate byte-per-token ratio
      setEstimationModel(resolvedModel);

      // ── Plan-then-execute: detect and activate ──
      if (loopCount === 1 && !planActive && routingProfile &&
          shouldPlan(routingTier, routingProfile, lastUserInput, !!(config as { ultrathink?: boolean }).ultrathink, !!(config as unknown as Record<string, unknown>).planDisabled)) {
        planActive = true;
        planPlannerModel = resolvedModel;
        planExecutorModel = getExecutorModel(routingProfile);
        onEvent({ kind: 'text_delta', text: '\n*Planning...*\n' });
      }

      // Plan-then-execute: override model on execution iterations
      if (planActive && loopCount > 1) {
        resolvedModel = planExecutorModel;
      }

      // Build per-call tool defs, max_tokens, and system prompt
      // (planning calls get no tools + short output + planning prompt)
      // Dynamic visibility: `buildCallToolDefs()` returns only the active set
      // (core + any the agent pulled via ActivateTool). Re-evaluated every
      // turn so newly activated tools take effect immediately.
      let callToolDefs = buildCallToolDefs();
      let callMaxTokens = maxTokens;
      let callSystemPrompt = systemPrompt;
      if (planActive && loopCount === 1) {
        callToolDefs = [];  // No tools during planning
        callMaxTokens = 2048;  // Short plan output
        callSystemPrompt = systemPrompt + '\n\n' + getPlanningPrompt();
      }

      // ── Hallucination guard for weak models ──
      // Weak / free models (nemotron-ultra, GLM-4, qwen coder, free-profile
      // resolves) have been observed inventing tool names (e.g. MixtureOfAgents)
      // and emitting literal `[TOOLCALL]` / `<tool_call>` text pretending to
      // call tools. Give them an explicit inventory + an anti-roleplay hint.
      // Skipped for strong models to keep their prompt cache warm.
      if (isWeakModel(resolvedModel) && callToolDefs.length > 0) {
        const names = callToolDefs.map(t => t.name).join(', ');
        callSystemPrompt = callSystemPrompt +
          '\n\n# Available tools\n' +
          `You have exactly these tools: ${names}.\n` +
          'Do not invent other tool names. Do not emit literal "[TOOLCALL]", ' +
          '"<tool_call>", or similar tokens in your text — call tools via the ' +
          'proper API only. If no tool fits, explain plainly in prose.';
      }

      // Safety net: handled in llm.ts resolveVirtualModel()

      // Sanitize: remove orphaned tool results that could confuse the API
      const sanitized = sanitizeHistory(history);
      if (sanitized.length !== history.length) {
        replaceHistory(history, sanitized);
      }

      try {
        const result = await client.complete(
          {
            model: resolvedModel,
            messages: history,
            system: callSystemPrompt,
            tools: callToolDefs,
            max_tokens: callMaxTokens,
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

        // ── Empty response recovery ──
        // If the model returns nothing, DON'T just retry the same model with the same input.
        // That's deterministic waste. Instead: switch to a different model — then give up and tell the user.
        const hasText = responseParts.some(p => p.type === 'text' && (p as any).text?.trim());
        const hasTools = responseParts.some(p => p.type === 'tool_use');
        const hasThinking = responseParts.some(p => p.type === 'thinking');
        if (!hasText && !hasTools && !hasThinking) {
          const EMPTY_FALLBACK_MODELS = ['nvidia/qwen3-coder-480b', 'nvidia/nemotron-ultra-253b', 'zai/glm-5.1'];
          const nextModel = EMPTY_FALLBACK_MODELS.find(m => m !== config.model && !turnFailedModels.has(m));
          if (nextModel && recoveryAttempts < 2) {
            recoveryAttempts++;
            turnFailedModels.add(config.model);
            const oldModel = config.model;
            config.model = nextModel;
            config.onModelChange?.(nextModel, 'system');
            if (config.debug) {
              console.error(`[franklin] ${oldModel} returned empty — switching to ${nextModel}`);
            }
            onEvent({ kind: 'text_delta', text: `\n*${oldModel} returned empty — switching to ${nextModel}*\n` });
            continue;
          }
          // No fallback available OR already tried 2 models — give up, tell the user.
          onEvent({
            kind: 'text_delta',
            text: `\n\n⚠️ The model returned an empty response and fallback models didn't help. This usually means the model is rate-limited or confused. Try rephrasing your question or switching model with \`/model\`.\n`,
          });
          onEvent({ kind: 'turn_done', reason: 'no_progress' });
          break;
        }
      } catch (err) {
        // ── User abort (Esc key) ──
        if ((err as Error).name === 'AbortError' || abort.signal.aborted) {
          // Save any partial response that was streamed before abort
          if (responseParts && responseParts.length > 0) {
            const partialAssistant = { role: 'assistant' as const, content: responseParts };
            history.push(partialAssistant);
            persistSessionMessage(partialAssistant);
          }
          lastSessionActivity = Date.now();
          persistSessionMeta();
          onEvent({ kind: 'turn_done', reason: 'aborted' });
          break;
        }

        const errMsg = (err as Error).message || '';
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
        if (classified.category === 'context_limit' && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
          recoveryAttempts++;
          if (config.debug) {
            console.error(`[franklin] Prompt too long — force compacting (attempt ${recoveryAttempts})`);
          }
          onEvent({ kind: 'text_delta', text: '\n*Context limit hit — compacting conversation...*\n' });
          const { history: compactedAgain } =
            await forceCompact(history, config.model, client, config.debug);
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
            console.error(
              `[franklin] ${classified.label} error — retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${recoveryAttempts}/${effectiveMaxRetries}): ${errMsg.slice(0, 100)}`
            );
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
          // Bound the Map so long sessions don't leak. LRU-evict oldest by timestamp.
          if (paymentFailedModels.size > 100) {
            const oldest = [...paymentFailedModels.entries()].sort((a, b) => a[1] - b[1])[0];
            if (oldest) paymentFailedModels.delete(oldest[0]);
          }
          // Record to local Elo so the router learns to avoid this model
          if (lastRoutedCategory) {
            recordOutcome(lastRoutedCategory, config.model, 'payment');
          }
          const FREE_MODELS = ['nvidia/qwen3-coder-480b', 'nvidia/nemotron-ultra-253b', 'nvidia/devstral-2-123b'];
          const nextFree = FREE_MODELS.find(m => !turnFailedModels.has(m));
          if (nextFree) {
            const oldModel = config.model;
            config.model = nextFree;
            config.onModelChange?.(nextFree, 'system');
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

      // ── Circuit breakers: prevent infinite-loop wallet drain ──
      turnSpend += costEstimate;
      if (turnSpend > MAX_TURN_SPEND_USD) {
        onEvent({
          kind: 'text_delta',
          text: `\n\n⚠️ Turn spend limit reached ($${turnSpend.toFixed(3)} > $${MAX_TURN_SPEND_USD}). Stopping to protect your wallet. Try again with a clearer prompt or a different model.\n`,
        });
        onEvent({ kind: 'turn_done', reason: 'budget' });
        break;
      }
      // Count a response as "no progress" only if it made no meaningful output:
      // no tool call, and no text content longer than a few chars. A short but
      // legitimate response (e.g. "done" or a compact tool_use) resets the counter.
      const madeProgress =
        responseParts.some(p => p.type === 'tool_use') ||
        responseParts.some(p => p.type === 'text' && ((p as { text?: string }).text?.trim().length ?? 0) > 3);
      if (!madeProgress) {
        consecutiveTinyResponses++;
        if (consecutiveTinyResponses >= MAX_TINY_RESPONSES) {
          onEvent({
            kind: 'text_delta',
            text: `\n\n⚠️ Model returned ${consecutiveTinyResponses} non-productive responses in a row (${resolvedModel} may be rate-limited or confused). Stopping to save tokens. Try a different model with \`/model\` or rephrase your message.\n`,
          });
          onEvent({ kind: 'turn_done', reason: 'no_progress' });
          break;
        }
      } else {
        consecutiveTinyResponses = 0;
      }
      recordSessionUsage(resolvedModel, inputTokens, usage.outputTokens, costEstimate, routingTier);
      appendAudit({
        ts: Date.now(),
        sessionId,
        model: resolvedModel,
        inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costEstimate,
        source: 'agent',
        workDir,
        prompt: extractLastUserPrompt(history),
        routingTier,
      });

      // Accumulate session-level totals for session meta
      sessionInputTokens += inputTokens;
      sessionOutputTokens += usage.outputTokens;
      sessionCostUsd += costEstimate;
      const opusCost = (inputTokens / 1_000_000) * OPUS_PRICING.input
        + (usage.outputTokens / 1_000_000) * OPUS_PRICING.output;
      sessionSavedVsOpus += Math.max(0, opusCost - costEstimate);

      // ── Max-spend guard ──
      // Session-level cost ceiling. Batch/scripted callers pass this to bound a
      // single run ("spend at most $0.50 for today's digest"); interactive
      // users can pass it to feel safe walking away. Hits as soon as accumulated
      // cost crosses the cap — the last call that tipped us over still runs,
      // but no further API calls are made.
      const maxSpend = (config as { maxSpendUsd?: number }).maxSpendUsd;
      if (typeof maxSpend === 'number' && Number.isFinite(maxSpend) && maxSpend > 0 &&
          sessionCostUsd >= maxSpend) {
        onEvent({
          kind: 'text_delta',
          text: `\n\n_Max-spend reached: $${sessionCostUsd.toFixed(4)} ≥ cap $${maxSpend.toFixed(2)}. ` +
            `Stopping session — further calls would exceed the budget._\n`,
        });
        persistSessionMeta();
        onEvent({ kind: 'turn_done', reason: 'budget' });
        return history;
      }

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
        // Append what we got + a continuation prompt with last-line anchor
        const partialAssistant = { role: 'assistant' as const, content: responseParts };

        // Extract last line of output to give the model a concrete resume point
        const textParts = responseParts.filter(p => p.type === 'text');
        const lastTextBlock = textParts[textParts.length - 1];
        let lastLineAnchor = '';
        if (lastTextBlock && lastTextBlock.type === 'text') {
          const lastLine = lastTextBlock.text.split('\n').filter(l => l.trim()).pop() ?? '';
          if (lastLine.length > 10) {
            lastLineAnchor = `\nYour output ended with: "${lastLine.slice(0, 120)}"\nResume immediately after that point.`;
          }
        }

        const continuationPrompt = {
          role: 'user',
          content: [
            'Output token limit hit. Continue:',
            '1. Resume exactly where you stopped — your prior output is visible above.',
            '2. Do NOT repeat, summarize, or recap anything already output.',
            '3. If mid-code-block, continue the same block without restarting.',
            '4. Prefer tool calls (Write, Edit) over large text output — they are more token-efficient.',
            '5. Be concise — skip explanations, focus on completing the work.',
            lastLineAnchor,
          ].filter(l => l).join('\n'),
        } as const;
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
      const invocations: CapabilityInvocation[] = [];
      for (const part of responseParts) {
        if (part.type === 'tool_use') {
          invocations.push(part);
        }
      }

      const assistantMessage = { role: 'assistant' as const, content: responseParts };
      history.push(assistantMessage);
      persistSessionMessage(assistantMessage);

      // ── Plan-then-execute: transition from planning to execution ──
      if (planActive && loopCount === 1 && invocations.length === 0) {
        // Planning call completed — inject execution kickoff
        const execKickoff: Dialogue = {
          role: 'user',
          content: 'Execute the plan above step by step. Use tools to complete each step. After each step, briefly state what you did and move to the next.',
        };
        history.push(execKickoff);
        persistSessionMessage(execKickoff);
        onEvent({ kind: 'text_delta', text: `\n*Executing with ${planExecutorModel}...*\n` });
        continue; // Next iteration uses the cheap executor model
      }

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

        // ── Verification gate: run adversarial checks on substantial CODE work ──
        // Fires when the agent Edit/Write/Bash-ed enough to warrant running
        // the build + tests. Complements the grounding check below, which
        // covers read-heavy answers this verifier misses.
        if (shouldVerify(turnToolCalls, turnToolCounts, lastUserInput || '')) {
          try {
            const vResult = await runVerification(history, capabilityMap, client, {
              model: config.model,
              workDir,
              abortSignal: abort.signal,
              onEvent: (e) => { if (e.kind === 'text_delta' && e.text) onEvent({ kind: 'text_delta', text: e.text }); },
            });

            if (vResult.verdict === 'FAIL' && vResult.issues.length > 0) {
              // Inject verification feedback — agent will see this and continue fixing
              const feedbackMsg: Dialogue = {
                role: 'user',
                content: `[VERIFICATION FAILED]\n${vResult.summary}\n\nFix the issues above and verify your fixes work.`,
              };
              history.push(feedbackMsg);
              persistSessionMessage(feedbackMsg);
              onEvent({ kind: 'text_delta', text: `\n⚠️ *Verification found issues — fixing...*\n` });
              continue; // Re-enter the loop to fix issues
            }

            if (vResult.verdict === 'PASS') {
              onEvent({ kind: 'text_delta', text: '\n✓ *Verified*\n' });
            }
          } catch {
            // Verification errors never block the main flow
          }
        }

        // ── Grounding gate: check that factual claims trace to tool calls ──
        // Fires on any substantive answer to a non-trivial question. Catches
        // the failure mode the code-verifier misses: model answers a
        // "what's X / should I buy Y" question from memory instead of
        // calling the live tools.
        //
        // On UNGROUNDED: inject a corrective user message (GAN-style feedback)
        // and re-enter the loop so the generator can answer again with the
        // right tools. Up to MAX_GROUNDING_RETRIES attempts — after that,
        // annotate and ship so the user can decide.
        try {
          const assistantText = responseParts
            .filter(p => p.type === 'text' && typeof (p as { text?: string }).text === 'string')
            .map(p => (p as { text: string }).text)
            .join('');
          if (shouldCheckGrounding(lastUserInput || '', assistantText)) {
            const gResult = await checkGrounding(lastUserInput, history, assistantText, client, {
              abortSignal: abort.signal,
            });

            if (gResult.verdict === 'UNGROUNDED' && groundingRetryCount < MAX_GROUNDING_RETRIES) {
              groundingRetryCount++;
              const retryMsg = buildGroundingRetryInstruction(gResult, lastUserInput);
              const feedbackMsg: Dialogue = { role: 'user', content: retryMsg };
              history.push(feedbackMsg);
              persistSessionMessage(feedbackMsg);
              onEvent({
                kind: 'text_delta',
                text: '\n\n*Ungrounded claims detected — retrying with required tool calls...*\n\n',
              });
              continue; // Re-enter outer loop — generator will produce a new response.
            }

            // Either the verdict is acceptable (GROUNDED / PARTIAL / SKIPPED)
            // or we've hit the retry cap with UNGROUNDED still outstanding.
            // In both cases, surface the followup if one applies and exit.
            const followup = renderGroundingFollowup(gResult);
            if (followup) {
              onEvent({ kind: 'text_delta', text: followup });
            }
          }
        } catch {
          // Grounding check is best-effort — never block the main flow.
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
        // Session-scope aggregate (drives telemetry opt-in export).
        sessionToolCounts.set(name, (sessionToolCounts.get(name) || 0) + 1);

        // Read file dedup: track paths already read
        if (name === 'Read' && inv.input.file_path) {
          readFileCache.add(inv.input.file_path as string);
        }
      }

      // Refresh activity timestamp after tool execution
      lastSessionActivity = Date.now();

      // Mid-session learning extraction
      // Runs in background — never blocks the conversation
      const { estimated: currentTokens } = getAnchoredTokenCount(history);
      maybeMidSessionExtract(history, currentTokens, turnToolCalls, sessionId, client);

      // Append outcomes (with guardrail injections)
      const outcomeContent: UserContentPart[] = results.map(
        ([inv, result]) => {
          // Read file dedup: if this file was already read earlier in this turn,
          // replace content with a stub to save tokens
          if (inv.name === 'Read' && !result.isError) {
            const fp = inv.input.file_path as string;
            const count = results.filter(([i]) => i.name === 'Read' && i.input.file_path === fp).length;
            if (count > 1 && inv !== results.filter(([i]) => i.name === 'Read' && i.input.file_path === fp).pop()?.[0]) {
              return {
                type: 'tool_result' as const,
                tool_use_id: inv.id,
                content: `File already read in this turn. Refer to the other Read result for ${fp}.`,
                is_error: false,
              };
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: inv.id,
            content: result.output,
            is_error: result.isError,
          };
        }
      );

      // ── Guardrail injections ──
      // Warn about same-tool repetition — escalate on every call past threshold
      for (const [name, count] of turnToolCounts) {
        if (count >= SAME_TOOL_WARN_THRESHOLD) {
          const escalation = count === SAME_TOOL_WARN_THRESHOLD
            ? `[SYSTEM] You have called ${name} ${count} times this turn. Stop and present your results now. Do not make more ${name} calls.`
            : `[SYSTEM] STOP. You have now called ${name} ${count} times — more searching is not producing new information. Answer the user with what you already have. If the answer truly requires a different approach, use a DIFFERENT tool or ask the user.`;
          outcomeContent.push({
            type: 'tool_result' as const,
            tool_use_id: `guardrail-warn-${name}-${count}`,
            content: escalation,
            is_error: true,
          });
        }
      }

      // Hard cap: stop the turn if too many tool calls
      if (turnToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
        outcomeContent.push({
          type: 'tool_result' as const,
          tool_use_id: 'guardrail-cap',
          content: `[SYSTEM] Tool call limit reached (${MAX_TOOL_CALLS_PER_TURN}). Present your results to the user NOW. Do not make any more tool calls.`,
          is_error: true,
        });
      }

      const toolResultMessage = { role: 'user' as const, content: outcomeContent };
      history.push(toolResultMessage);
      persistSessionMessage(toolResultMessage);

      // ── Plan-then-execute: stuck detection ──
      if (planActive && loopCount > 1) {
        const hasErrors = results.some(([, r]) => r.isError);
        planConsecutiveErrors = hasErrors ? planConsecutiveErrors + 1 : 0;

        // Check for same-tool repeat (model calling the exact same thing twice)
        const currentSig = results.length === 1
          ? toolCallSignature(results[0][0].name, results[0][0].input)
          : '';
        const sameToolRepeat = currentSig !== '' && currentSig === lastToolSig;
        lastToolSig = currentSig;

        if (isExecutorStuck(planConsecutiveErrors, sameToolRepeat)) {
          if (planEscalationCount < 2) {
            planEscalationCount++;
            // One-shot escalation: next iteration uses the planner model
            resolvedModel = planPlannerModel;
            const escalation: Dialogue = {
              role: 'user',
              content: '[ESCALATION] The executor got stuck on repeated errors. You are a stronger model. Review what happened and either fix the approach or continue from where execution stopped.',
            };
            history.push(escalation);
            persistSessionMessage(escalation);
            onEvent({ kind: 'text_delta', text: '\n*Escalating to stronger model...*\n' });
          } else {
            // Abandon plan — strong model finishes the task directly
            planActive = false;
            onEvent({ kind: 'text_delta', text: '\n*Plan abandoned — switching to full model...*\n' });
          }
        }
      }

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
