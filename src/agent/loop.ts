/**
 * Franklin Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 */

import { ModelClient } from './llm.js';
import { autoCompactIfNeeded, forceCompact, microCompact } from './compact.js';
import { estimateHistoryTokens, updateActualTokens, resetTokenAnchor, getAnchoredTokenCount, getContextWindow, setEstimationModel } from './tokens.js';
import { handleSlashCommand } from './commands.js';
import { loadBundledSkills, getSkillVars } from '../skills/bootstrap.js';
import { reduceTokens } from './reduce.js';
import { redactSecrets, stashSecretsToEnv, formatRedactionWarning } from './secret-redact.js';
import { PermissionManager } from './permissions.js';
import { StreamingExecutor } from './streaming-executor.js';
import { optimizeHistory, CAPPED_MAX_TOKENS, ESCALATED_MAX_TOKENS, getMaxOutputTokens } from './optimize.js';
import { classifyAgentError } from './error-classifier.js';
import { SessionToolGuard } from './tool-guard.js';
import { resetToolSessionState } from '../tools/index.js';
import { CORE_TOOL_NAMES, dynamicToolsEnabled } from '../tools/tool-categories.js';
import { createActivateToolCapability } from '../tools/activate.js';
import { recordUsage } from '../stats/tracker.js';
import { loadConfig } from '../commands/config.js';
import { recordSessionUsage } from '../stats/session-tracker.js';
import { appendAudit, extractLastUserPrompt } from '../stats/audit.js';
import { logger, setDebugMode } from '../logger.js';
import { runDataHygiene } from '../storage/hygiene.js';
import { isTestFixtureModel } from '../stats/test-fixture.js';
import { setSessionPersistenceDisabled } from '../session/storage.js';
import { estimateCost, OPUS_PRICING } from '../pricing.js';
import { maybeMidSessionExtract } from '../learnings/extractor.js';
import { extractMentions, buildEntityContext, loadEntities } from '../brain/store.js';
import { routeRequest, routeRequestAsync, resolveTierToModel, parseRoutingProfile, getFallbackChain, pickFreeFallback } from '../router/index.js';
import type { Tier, RoutingProfile } from '../router/index.js';
import { recordOutcome } from '../router/local-elo.js';
import { shouldPlan, getPlanningPrompt, getExecutorModel, isExecutorStuck, toolCallSignature } from './planner.js';
import { shouldVerify, runVerification } from './verification.js';
import {
  shouldCheckGrounding,
  checkGrounding,
  renderGroundingFollowup,
  buildGroundingRetryInstruction,
  extractMissingToolNames,
} from './evaluator.js';
import type { ToolChoice } from './llm.js';
import { augmentUserMessage, prefetchForIntent } from './intent-prefetch.js';
import { analyzeTurn, type TurnAnalysis } from './turn-analyzer.js';
import { evaluateTimeoutRetry } from './retry-policy.js';
import {
  MAX_AUTO_CONTINUATIONS_PER_TURN,
  buildContinuationPrompt,
  isAutoContinuationDisabled,
} from './continuation.js';
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

const EXTERNAL_WALL_FAILURE_PATTERN =
  /\b(?:401|403|429|5\d{2})\b|\bunauthor|\bforbid|\bWAF\b|\bcloudflare\b|\bfault filter\b|\bblocked\b|\binvalid (?:auth|api|token|key|bearer)\b/i;

export function isExternalWallFailure(toolName: string, output: string, isError?: boolean): boolean {
  if (toolName === 'WebFetch') {
    return isError === true || EXTERNAL_WALL_FAILURE_PATTERN.test(output);
  }
  if (toolName === 'Bash') {
    // Bash is a general-purpose local tool. Non-zero exits from tests,
    // builds, git, etc. are useful debugging signal, not proof that the
    // model is thrashing against an external auth/firewall wall.
    return output.length > 0 && EXTERNAL_WALL_FAILURE_PATTERN.test(output);
  }
  return false;
}

// ─── Pushback detection ───────────────────────────────────────────────────
// Formerly a pair of regex lists (PUSHBACK_STRONG / PUSHBACK_WEAK) plus a
// claim-on-prior-turn check — ~70 lines of keyword heuristics. Replaced by
// `turnAnalysis.isPushback` from `turn-analyzer.ts` (v3.8.27): the free
// classifier reads the user's actual phrasing AND the prior assistant
// reply and decides whether this turn is a correction. Zero keyword
// allowlist, works across languages and phrasings the regex never covered.

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
/**
 * True when the assistant's last emitted text segment ends with a question
 * mark (ASCII `?` or fullwidth `？`). Used to render an end-of-turn marker
 * so users don't read the post-question silence as "Franklin died." Trim
 * trailing whitespace + closing punctuation that doesn't change intent
 * (newlines, single closing quote/paren) before checking.
 */
function endedWithQuestion(parts: ContentPart[] | undefined): boolean {
  if (!parts || parts.length === 0) return false;
  // Walk back to the last text segment. Skip thinking/tool_use parts.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type !== 'text') continue;
    const text = (p as { text?: string }).text;
    if (typeof text !== 'string') return false;
    // Strip trailing whitespace + the ~3 closing chars that commonly
    // follow a question without changing it (")", "'", "\"", "*", ")",
    // "*", whitespace).
    const trimmed = text.replace(/[\s)\]'"*`)]+$/u, '');
    return /[?？]$/.test(trimmed);
  }
  return false;
}

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
 * Detect when the gateway leaked an upstream rate-limit / quota error as a
 * 200-OK text content block instead of a real HTTP error. The Anthropic
 * provider in particular surfaces per-day TPM exhaustion as a bracketed
 * "[Error: Too many tokens per day, please wait before trying again.]"
 * message glued into the assistant text channel, which then poisons grounding
 * checks and gets persisted to session history as if it were a real reply.
 *
 * Treat any assistant turn whose entire text payload is a single bracketed
 * `[Error: ...]` line — and contains no tool_use / thinking blocks — as a
 * masquerading transport error. The caller throws to let the existing
 * classifier + retry path take over.
 */
export function looksLikeGatewayErrorAsText(parts: ContentPart[]): { match: boolean; message: string } {
  if (parts.length === 0) return { match: false, message: '' };
  // Reject if any non-text content (real tool calls, real thinking) was emitted.
  const textParts: string[] = [];
  for (const p of parts) {
    if (p.type === 'tool_use') return { match: false, message: '' };
    if (p.type === 'text' && typeof (p as { text?: string }).text === 'string') {
      textParts.push((p as { text: string }).text);
    }
  }
  const joined = textParts.join('').trim();
  if (!joined) return { match: false, message: '' };
  // Pattern: `[Error: ...]` taking up the entire text payload, modulo
  // surrounding whitespace. Allow the bracket to be the whole message OR
  // the message to start with it (some gateways append a stray newline).
  const m = /^\[Error:\s*([^\]]+?)\]\s*$/.exec(joined);
  if (!m) return { match: false, message: '' };
  return { match: true, message: m[1].trim() };
}

/**
 * Domain check for the grounding-retry force-tool path. A specialized tool
 * (TradingMarket, DefiLlama*, jupiter*, base0x*, SearchX) should only be
 * pinned by tool_choice when the user prompt actually references that
 * tool's domain — otherwise we let the smart generator pick from any tool.
 *
 * The motivating bug: a real-estate question ("可以还价 20% 吗") had its
 * answer flagged as ungrounded for citing $/sqft figures. The cheap
 * evaluator model picked TradingMarket as the missing tool because it
 * was the first example in the evaluator prompt. Forcing TradingMarket
 * (a crypto-only tool) on a housing question made the retry useless.
 *
 * This function returns false for specialized tools when the prompt has
 * no matching domain keywords; the caller falls back to "any" tool.
 * General-purpose tools (WebSearch, ExaSearch, ExaAnswer, WebFetch,
 * ExaReadUrls) always pass — they're domain-agnostic.
 */
function isToolRelevantToPrompt(toolName: string, promptLower: string): boolean {
  // Crypto trading tools — need a ticker, "crypto", "coin", "swap", etc.
  if (/^(Trading|DefiLlama|Jupiter|Base0x|Base0xGasless)/i.test(toolName)) {
    return /\b(btc|eth|sol|xrp|doge|usdc|usdt|crypto|coin|token|defi|tvl|yield|swap|jupiter|uniswap|pump\.fun|solana|base chain|polygon|ethereum|币|代币|链上|做空|做多)\b/i.test(promptLower);
  }
  // X.com search — need an @handle, "twitter", "tweet", "X.com"
  if (/^SearchX$/i.test(toolName) || /^PostToX$/i.test(toolName)) {
    return /(@\w+|twitter|x\.com|tweet|推特)/i.test(promptLower);
  }
  // Image / video / music gen — need a creative-content request
  if (/^(ImageGen|VideoGen|MusicGen)$/i.test(toolName)) {
    return /\b(image|picture|photo|video|clip|music|song|generate|create|render|draw|画|图|视频|音乐|歌)\b/i.test(promptLower);
  }
  // General-purpose / file / shell tools — always relevant.
  return true;
}

/**
 * Detect a "stalled at intent" assistant turn: model emitted text-of-intent
 * (e.g. "Let me check Node.js…", "I'll start by running npm install") but
 * never bound a tool_use block. Coder-tuned models (qwen3-coder-*) and
 * NIM-hosted Llama-4-Maverick frequently end_turn after declaring an action,
 * stranding the agent loop with no progress.
 *
 * Returns true when the turn looks like a stall — caller should switch to a
 * tool-use-strong model and retry the same prompt instead of treating the
 * declared-but-unexecuted intent as the model's final answer.
 *
 * Conservative by design: only fires when the *tail* of the text shows
 * action-intent + the message is long enough to look like a real plan, so
 * legitimate short answers ("yes", "looks good") never get re-invoked.
 */
export function looksLikeStalledIntent(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 24) return false;
  // Look at the last ~400 chars only — intent-to-act lives near the end.
  const tail = trimmed.slice(-400).toLowerCase();
  // Strong "I'm about to do something" markers near the tail.
  const englishIntent =
    /\b(let me|let's|i'?ll|i will|i need to|first[,\s]+(?:i|let)|now let'?s|now i'?ll|next[,\s]+i'?ll)\b[\s\S]{0,80}\b(check|verify|run|test|inspect|look|examine|confirm|see|try|install|build|create|start|begin)\b/;
  const verifyMarkers =
    /\b(let'?s verify|let me check|let me run|let me inspect|let me test|let me look|let me see|let me try|let me start|i'?m going to|i'?ll start by|i'?ll first|i'?ll now)\b/;
  // CJK equivalents — Franklin sees plenty of zh sessions.
  const zhIntent = /(我来|让我|我需要|首先|现在我|下一步|让我们|我会|我将|接下来)/;
  const zhAction = /(检查|验证|运行|测试|查看|确认|看看|启动|创建|构建|安装|开始)/;
  if (englishIntent.test(tail)) return true;
  if (verifyMarkers.test(tail)) return true;
  if (zhIntent.test(tail) && zhAction.test(tail)) return true;
  return false;
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
 * Threshold for stripping inline base64 image data on session-disk
 * writes. Mirrors `streaming-executor.ts:PERSIST_THRESHOLD` so a Read of
 * a small icon (favicon-sized PNG, ~3 KB base64) round-trips through
 * resume intact, while a Read of a screenshot or generated artwork
 * (typically 200 KB+ base64) gets path-stubbed.
 */
const SESSION_IMAGE_STRIP_THRESHOLD = 50_000;

interface ToolResultImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

interface ToolResultTextBlock {
  type: 'text';
  text: string;
}

type ToolResultContentBlock = ToolResultTextBlock | ToolResultImageBlock | { type: string; [k: string]: unknown };

/**
 * Walk a Dialogue and replace large `image.source.data` (base64) blocks
 * inside `tool_result.content` arrays with a tiny placeholder. The
 * accompanying text block already names the file path so the model on
 * resume can re-Read it if it needs to see the image again. Returns a
 * shallow clone so the in-memory history (used for the rest of the
 * current turn) keeps the full image data.
 */
export function stripLargeImageData(message: Dialogue): Dialogue {
  if (!Array.isArray(message.content)) return message;
  let mutated = false;
  // Cast through `unknown` because Dialogue's content union doesn't expose
  // the tool_result shape with image blocks at the type level — they flow
  // in via the loop's outcome-building path. Runtime structure is what
  // matters here; we only mutate when we positively identify the shape.
  const newContent = (message.content as unknown[]).map((part) => {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: string }).type === 'tool_result' &&
      Array.isArray((part as { content?: unknown }).content)
    ) {
      const tr = part as { type: 'tool_result'; content: ToolResultContentBlock[]; [k: string]: unknown };
      let inner = tr.content;
      let innerMutated = false;
      const cleaned = inner.map((block) => {
        if (
          block &&
          typeof block === 'object' &&
          block.type === 'image' &&
          (block as ToolResultImageBlock).source?.type === 'base64' &&
          ((block as ToolResultImageBlock).source.data?.length ?? 0) > SESSION_IMAGE_STRIP_THRESHOLD
        ) {
          innerMutated = true;
          const sz = ((block as ToolResultImageBlock).source.data ?? '').length;
          return {
            type: 'text',
            text: `<image stripped from session log: ${(sz / 1024).toFixed(1)} KB base64. ` +
                  `See accompanying text block for the source path; re-Read to inline again.>`,
          } as ToolResultTextBlock;
        }
        return block;
      });
      if (innerMutated) {
        mutated = true;
        inner = cleaned;
        return { ...tr, content: inner };
      }
    }
    return part;
  });
  return mutated ? { ...message, content: newContent as Dialogue['content'] } : message;
}

/**
 * Format the user-facing "switching model" line. Includes the resolved
 * concrete model in parentheses when the user-facing alias (e.g.
 * `blockrun/auto`) differs from what was actually being called (e.g.
 * `anthropic/claude-sonnet-4.6`). Verified 2026-05-04 in a live session:
 * a payment fail surfaced as `*blockrun/auto failed — switching to
 * nvidia/qwen3-coder-480b*` with no hint of which concrete model
 * actually failed, and no hint of why. The reason label closes that gap.
 */
function formatModelSwitch(
  alias: string,
  resolved: string,
  reason: string,
  newModel: string,
): string {
  const oldDisplay = alias === resolved ? alias : `${alias} (${resolved})`;
  return `${oldDisplay} ${reason} — switching to ${newModel}`;
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
  // `blockrun/free` resolves to an NVIDIA model before the API call, so
  // catching the `nvidia/` prefix also catches the free-profile path.
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

  // Wire stderr-mirroring of log lines to the same flag the agent already
  // uses to gate verbose console output. File writes happen regardless.
  setDebugMode(!!config.debug);

  // In-process tests run interactiveSession() with model="local/test*"
  // and were creating real session files on the user's machine —
  // verified 19 of 33 metas (57.6%) were polluted on a real install.
  // Gate session persistence at the entry point so the rest of the
  // loop doesn't have to thread the flag through. Tests that genuinely
  // exercise the persistence path use a non-fixture model name like
  // `zai/glm-5.1` (mock-server-backed) so they keep writing.
  setSessionPersistenceDisabled(isTestFixtureModel(config.model));

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

  // ── Skills (file-loaded SKILL.md prompt-rewrite slash commands) ──
  // Bundled-only in Phase 1 of the skills MVP. User-global and project-local
  // discovery + the budget-cap-usd / cost-receipt enforcement contract land
  // in Phase 2 — see docs/plans/2026-04-29-franklin-skills-mvp-design.md.
  const skillBoot = loadBundledSkills();
  if (skillBoot.errors.length > 0 && config.debug) {
    for (const err of skillBoot.errors) {
      onEvent({ kind: 'text_delta', text: `[skills] ${err.path}: ${err.error}\n` });
    }
  }
  const skillRegistry = skillBoot.registry;
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
  // Carry over running totals from prior runs so resume preserves them — see
  // the `let sessionInputTokens` comment below.
  let resumedInputTokens = 0;
  let resumedOutputTokens = 0;
  let resumedCostUsd = 0;
  let resumedSavedVsOpusUsd = 0;
  if (config.resumeSessionId) {
    const prior = loadSessionHistory(config.resumeSessionId);
    if (prior.length > 0) {
      const sanitized = sanitizeHistory(prior);
      replaceHistory(history, sanitized);
      const meta = loadSessionMeta(config.resumeSessionId);
      if (meta) {
        turnCount = meta.turnCount ?? 0;
        // Pre-3.15.38 these fell on the floor — every resume reset the
        // running cost/token totals to zero, then `updateSessionMeta`
        // wrote the new (smaller) numbers back over the historical
        // values. Verified 2026-05-04 from a real session: efd5e412
        // had $2.65 + 200K input tokens accumulated, then a resume
        // rewrote the meta to {costUsd: 0, inputTokens: 0, ...}
        // before the user ran their next turn.
        resumedInputTokens = meta.inputTokens ?? 0;
        resumedOutputTokens = meta.outputTokens ?? 0;
        resumedCostUsd = meta.costUsd ?? 0;
        resumedSavedVsOpusUsd = meta.savedVsOpusUsd ?? 0;
      }
    }
  }
  let tokenBudgetWarned = false; // Emit token budget warning at most once per session
  let lastSessionActivity = Date.now();
  let lastRoutedModel = '';   // last model chosen by router (for local elo)
  let lastRoutedCategory = ''; // last category detected (for local elo)
  // Session-cumulative counters. Seeded from prior session meta on resume so
  // `franklin insights` and the status bar show the *true* session total
  // across every restart, not just what happened since the latest process
  // boot.
  let sessionInputTokens = resumedInputTokens;
  let sessionOutputTokens = resumedOutputTokens;
  let sessionCostUsd = resumedCostUsd;
  let sessionSavedVsOpus = resumedSavedVsOpusUsd;
  // Per-tool call counts aggregated across every turn. Session-scope, not
  // per-turn. Counts the *name* of each tool invocation only — no inputs,
  // outputs, or paths. Fed into opt-in telemetry at session end.
  const sessionToolCounts = new Map<string, number>();
  const toolGuard = new SessionToolGuard();
  const persistSessionMeta = () => {
    updateSessionMeta(sessionId, {
      model: config.model,
      workDir,
      // Pin the session's chain so `franklin --resume` can restore it
      // even after `franklin <chain>` shortcuts mutate the persisted
      // default. updateSessionMeta treats this field as sticky once
      // recorded — see storage.ts.
      chain: config.chain,
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
    // Strip large base64 image bytes before writing to session jsonl. The
    // tool_result wrap at line ~1788 inlines image data so vision models
    // can see it during the live turn — but PNG bytes can be ~600 KB
    // each, and the inline content bypasses persistLargeResult (which
    // only checks `result.output.length`). Verified 2026-05-05: a single
    // Read of `/tmp/mamba_hd_p9.png` produced an 850 KB session jsonl
    // line; a 5-turn session with multiple .png reads grew to 12 MB.
    // The model already saw the bytes in this turn's in-memory history,
    // so disk only needs the path reference for resume.
    appendToSession(sessionId, stripLargeImageData(message));
    persistSessionMeta();
  };
  pruneOldSessions(sessionId); // Cleanup old sessions on start, protect current
  // Trim ~/.blockrun/data + cost_log + remove legacy files + sweep
  // orphan tool-results dirs. Logs a summary if anything was actually
  // touched — pre-3.15.31 hygiene was completely silent and the only
  // way to verify it was running was poking disk yourself.
  const hygieneReport = runDataHygiene();
  const totalCleaned =
    hygieneReport.legacyFilesRemoved +
    hygieneReport.dataFilesTrimmed +
    hygieneReport.costLogRowsTrimmed +
    hygieneReport.orphanToolResultsRemoved +
    hygieneReport.brainJunkEntitiesRemoved +
    hygieneReport.oldTasksRemoved;
  if (totalCleaned > 0) {
    logger.info(
      `[franklin] Data hygiene: ${hygieneReport.legacyFilesRemoved} legacy, ${hygieneReport.dataFilesTrimmed} data files, ${hygieneReport.costLogRowsTrimmed} cost_log rows, ${hygieneReport.orphanToolResultsRemoved} orphan tool-results dirs, ${hygieneReport.brainJunkEntitiesRemoved} junk brain entities, ${hygieneReport.oldTasksRemoved} expired tasks cleaned`
    );
  }
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
          skillRegistry,
          skillVars: getSkillVars({ chain: config.chain }),
        });
        if (cmdResult.handled) continue;
        if (cmdResult.rewritten) input = cmdResult.rewritten;
      }
    }

    // ── Secret redaction at the input boundary ──
    // Catch GitHub PATs / API keys / private keys before they enter
    // history, get persisted, or hit the model. Detected values are
    // stashed on process.env (predictable name like GITHUB_TOKEN) so
    // subsequent Bash tool calls can still use them via `$GITHUB_TOKEN`
    // — the user keeps the convenience of "remember this credential"
    // without the chat-history exposure that just happened.
    const { redactedText, matches: secretMatches } = redactSecrets(input);
    if (secretMatches.length > 0) {
      const envVarsSet = stashSecretsToEnv(secretMatches);
      onEvent({
        kind: 'text_delta',
        text: formatRedactionWarning(secretMatches, envVarsSet),
      });
      input = redactedText;
    }

    lastUserInput = input;
    // Push the user's clean message; any harness-injected annotations
    // (pushback SYSTEM NOTE, prefetch context block) are applied AFTER
    // the turn analyzer runs so they get driven by model-decided flags
    // instead of keyword regex.
    history.push({ role: 'user', content: input });
    turnCount++;
    toolGuard.startTurn();
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
    let autoContinuationCount = 0;
    const MAX_RECOVERY_ATTEMPTS = 5;
    // Track per-model server-error streak so we can break out of a stuck
    // upstream and try the next model in the routing fallback chain instead
    // of burning all MAX_RECOVERY_ATTEMPTS retries on the same failure.
    const serverErrorsByModel = new Map<string, number>();
    const SERVER_ERROR_STREAK_BEFORE_SWITCH = 2;
    let compactFailures = 0;
    // Research-bloat compaction is fire-once per turn. A later turn can hit
    // the trigger organically after the first compact, but firing twice from
    // the same threshold would flap on every iteration once crossed.
    let bloatCompactedThisTurn = false;
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

    // When the previous round failed grounding and we're retrying, force the
    // model to actually call a tool this round instead of trusting it to
    // comply with a soft instruction. Single-shot — cleared after attached.
    // Set to `{ type: "tool", name: "X" }` if the evaluator named exactly
    // one available tool, else `{ type: "any" }` so the model picks.
    let forceToolChoiceNextRound: ToolChoice | null = null;

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
    // Hard break threshold for runaways. The cap above is soft — we
    // inject a "limit reached" tool_result once and let the model
    // close out. If it ignores that signal and keeps calling tools,
    // we force end the turn to prevent unbounded billing. Verified
    // on a real user log: one turn went 25 → 100 tool calls before
    // the loop ended via maxTurns (much later, much more expensive).
    const HARD_TOOL_CAP = MAX_TOOL_CALLS_PER_TURN * 2;
    let toolCapWarned = false;                          // Log + inject only once per turn
    const SAME_TOOL_WARN_THRESHOLD = 3;                 // Warn after N calls to same tool (lowered from 5 — search loops were wasting turns)
    // Repetition-based hard stop. 3.15.28 used a count-based threshold
    // (Bash called 6× → break) which incorrectly killed legitimate
    // exploratory data work — verified 2026-05-04 in a real Opus session
    // running data-engineering on GCS logs: 15 distinct gsutil/bq calls,
    // each producing new insights, would have been cut off at call 6.
    // 3.15.30 detects ACTUAL loops by tracking the (tool, input)
    // signature: only break when the model calls the SAME signature 3
    // times in one turn. Different inputs → exploration, allowed.
    const SAME_SIGNATURE_HARD_STOP = 3;
    // Tracks which tool names have already had a warn injected this turn.
    // Without it, every call past threshold pushes another [SYSTEM] STOP
    // tool_result into the model's context — same shape bug as the cap
    // spam fixed in 3.15.24, just in a sibling guardrail.
    const sameToolWarned = new Set<string>();
    // Tracks how many times each (tool, input)-signature has been called
    // this turn. Different inputs → different signatures → exploration.
    const turnSignatureCounts = new Map<string, number>();

    // ── No-progress guardrail: kill infinite tiny-response loops ──
    let consecutiveTinyResponses = 0;                    // Count of consecutive calls with <10 output tokens
    const MAX_TINY_RESPONSES = 2;                        // Break after N tiny responses — if 2 calls return near-empty, something is wrong

    // ── Turn cost accumulator ──
    // Surfaced in cap-exceeded messages so the user sees what the wasted
    // turn actually cost ("$0.05 spent before this turn was killed") instead
    // of just "tool limit exceeded". sessionCostUsd is too coarse — it
    // includes earlier productive turns the user got real value from.
    let turnCostUsd = 0;

    // ── Failed-external-call guardrail ──
    // The signature loop guard only catches exact-input repeats. It misses
    // "thrashing exploration": model calls Bash 17 different ways trying to
    // fix a 401 against the same dead endpoint. Verified 2026-05-05 in a
    // real session: glm-5.1 burned 50 calls / $0.05 trying every auth
    // variation against api.querit.ai (Cloudflare WAF blocked them all)
    // before the signature guard finally fired on the first exact repeat.
    // We count consecutive Bash/WebFetch calls whose output looks like a
    // network/auth failure; reset on any non-failed external call. Five
    // failures in a row is a wall, not exploration.
    let consecutiveFailedExternal = 0;
    const MAX_CONSECUTIVE_FAILED_EXTERNAL = 5;
    const EXTERNAL_TOOL_NAMES = new Set(['Bash', 'WebFetch']);

    // ── Turn analysis (one classifier call, drives routing + prefetch) ──
    // Single LLM pass that answers every routing-adjacent question the
    // harness needs BEFORE the main model runs: tier, ticker intent,
    // pushback, planning need, live-data signal. Replaces what used to be
    // two separate classifier calls (router + prefetch) plus keyword rule
    // engines for pushback / shouldPlan. Safe-defaults on any failure so
    // the main flow never blocks on it.
    let turnAnalysis: TurnAnalysis | null = null;
    try {
      // Anchor 1: the user's current message (already in lastUserInput).
      // Anchor 2: first chunk of the previous assistant reply — gives the
      // analyzer enough context to resolve deictic follow-ups like "那 AAPL 呢".
      const lastAssistantText = (() => {
        const prior = [...history.slice(0, -1)].reverse()
          .find((m: Dialogue) => m.role === 'assistant');
        if (!prior) return '';
        if (typeof prior.content === 'string') return prior.content;
        if (!Array.isArray(prior.content)) return '';
        return (prior.content as Array<{ type: string; text?: string }>)
          .filter(p => p.type === 'text')
          .map(p => p.text ?? '')
          .join(' ');
      })();
      // Anchor 3: the very first user message in this session (session goal).
      const sessionGoal = (() => {
        const first = history.find((m: Dialogue) => m.role === 'user');
        if (!first) return '';
        return typeof first.content === 'string' ? first.content : '';
      })();
      turnAnalysis = await analyzeTurn(input, {
        lastAssistantText,
        sessionGoal,
        client,
      });
    } catch {
      // Analyzer is best-effort; ignore.
    }

    // ── Pushback annotation ─────────────────────────────────────────
    // If the analyzer judged this turn as a user correction of the
    // previous answer, inject a SYSTEM NOTE into the user message so the
    // model resets its approach rather than doubling down. Replaces the
    // former PUSHBACK_STRONG / PUSHBACK_WEAK regex lists — model-decided,
    // no keyword allowlist to rot.
    if (turnAnalysis?.isPushback) {
      const lastIdx = history.length - 1;
      const last = history[lastIdx];
      if (last && last.role === 'user' && typeof last.content === 'string') {
        history[lastIdx] = {
          role: 'user',
          content: `${last.content}\n\n[SYSTEM NOTE] The user is correcting you. Your previous response was wrong or off-target. Do NOT continue the previous approach. Re-read the conversation, identify what specifically the user is correcting, and change your strategy. If the user pointed out a fact (e.g. "we are using X"), treat that fact as ground truth and rebuild your answer around it.`,
        };
      }
    }

    // ── Proactive prefetch ────────────────────────────────────────────
    // Uses the intent the analyzer already extracted. Skips the separate
    // prefetch-classifier call that previously ran here.
    try {
      if (turnAnalysis?.intent) {
        const prefetch = await prefetchForIntent(turnAnalysis.intent, client);
        if (prefetch && prefetch.anyOk) {
          if (config.showPrefetchStatus !== false) {
            onEvent({ kind: 'text_delta', text: `\n${prefetch.statusLine}\n\n` });
          }
          const lastIdx = history.length - 1;
          const last = history[lastIdx];
          if (last && last.role === 'user' && typeof last.content === 'string') {
            history[lastIdx] = augmentUserMessage(last.content, prefetch);
          }
        }
      }
    } catch {
      // Prefetch is best-effort — never block the main loop.
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
          // Capture pre-compaction size so we can surface "saved X%" to the
          // user. Without this, the per-turn input-token count would silently
          // drop from e.g. 215K → 9K and look like a metric bug.
          const beforeTokens = estimateHistoryTokens(history);
          const { history: compacted, compacted: didCompact } =
            await autoCompactIfNeeded(history, config.model, client, config.debug);
          if (didCompact) {
            replaceHistory(history, compacted);
            resetTokenAnchor();
            compactFailures = 0;
            const afterTokens = estimateHistoryTokens(history);
            const pct = beforeTokens > 0
              ? Math.round((1 - afterTokens / beforeTokens) * 100)
              : 0;
            // Visible to the user — explains the upcoming token-count drop
            // in the next turn footer and frames it as a feature, not a bug.
            onEvent({
              kind: 'text_delta',
              text: `\n*🗜 Auto-compacted: ~${(beforeTokens / 1000).toFixed(0)}K → ~${(afterTokens / 1000).toFixed(0)}K tokens (saved ${pct}%)*\n\n`,
            });
            logger.info(`[franklin] History compacted: ~${afterTokens} tokens`);
          }
        } catch (compactErr) {
          compactFailures++;
          logger.warn(`[franklin] Compaction failed (${compactFailures}/3): ${(compactErr as Error).message}`);
        }
      }

      // ── Research-bloat compaction (fires before context-window) ──
      // The window-based trigger above only fires near 172K tokens for a
      // 200K-context model. Research sessions burn money long before that:
      // verified 2026-05-05 in a real audit, a glm-5.1 session hit
      // $0.18 / 177 calls / 3.17M cumulative input — average per-call input
      // grew to 17.9K because every tool result kept replaying. Top-spend
      // session in the same log: $6.67 on gemini-2.5-flash in 121 calls,
      // never approached its 1M-token compaction threshold. Compact here
      // when the turn has accumulated lots of tool calls AND real spend,
      // even though the context window isn't close to full.
      //
      // Thresholds tightened in 3.15.71. Original 3.15.69 used
      // (>30 calls AND >$0.05) — verified too loose against a real
      // franklin-shorts edit session: 16 deepseek-v4-pro calls for
      // $0.055 ended naturally before the trigger fired, even though
      // by call #4 the per-call input was already 13K tokens (worth
      // compacting). Lowering to (>15 AND >$0.03) catches sessions
      // where input-replay tax has clearly started biting; the
      // fire-once-per-turn flag still bounds the worst case at one
      // extra summary call (~$0.005).
      if (
        !bloatCompactedThisTurn &&
        compactFailures < 3 &&
        turnToolCalls > 15 &&
        turnCostUsd > 0.03
      ) {
        try {
          const beforeTokens = estimateHistoryTokens(history);
          const { history: compacted, compacted: didCompact } =
            await forceCompact(history, config.model, client, config.debug);
          if (didCompact) {
            replaceHistory(history, compacted);
            resetTokenAnchor();
            bloatCompactedThisTurn = true;
            const afterTokens = estimateHistoryTokens(history);
            const pct = beforeTokens > 0
              ? Math.round((1 - afterTokens / beforeTokens) * 100)
              : 0;
            onEvent({
              kind: 'text_delta',
              text: `\n*🗜 Research-bloat compact: ${turnToolCalls} tool calls / $${turnCostUsd.toFixed(4)} this turn — summarizing ~${(beforeTokens / 1000).toFixed(0)}K → ~${(afterTokens / 1000).toFixed(0)}K tokens (saved ${pct}%)*\n\n`,
            });
            logger.info(`[franklin] Research-bloat compacted at ${turnToolCalls} calls / $${turnCostUsd.toFixed(4)}: ~${afterTokens} tokens`);
          }
        } catch (compactErr) {
          // Don't increment compactFailures — that gate is for the
          // window-based path. A failed bloat compact just means we keep
          // going at the higher per-call cost; not catastrophic.
          logger.warn(`[franklin] Bloat compaction failed: ${(compactErr as Error).message}`);
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
      // Uses the tier already decided by the turn-analyzer — one LLM call
      // up-front rather than a separate classifier here. Fallback to the
      // stand-alone classifier if analyzer wasn't available.
      const routingProfile = parseRoutingProfile(config.model);
      let resolvedModel = config.model;
      let routingTier: Tier | undefined;
      let routingConfidence: number | undefined;
      let routingSavings: number | undefined;
      if (routingProfile) {
        const routing = turnAnalysis
          ? resolveTierToModel(turnAnalysis.tier, routingProfile)
          : await routeRequestAsync(lastUserInput || '', routingProfile);
        resolvedModel = routing.model;
        routingTier = routing.tier;
        routingConfidence = routing.confidence;
        routingSavings = routing.savings;
        lastRoutedModel = routing.model;
        lastRoutedCategory = routing.category || '';
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
      // `needsPlanning` flag comes from turn-analyzer (one-word LLM decision
      // on the user's original prompt). shouldPlan still guards env / profile /
      // ultrathink / per-session overrides — those are operator policy, not
      // model decisions.
      if (loopCount === 1 && !planActive && routingProfile &&
          shouldPlan(
            routingProfile,
            !!(config as { ultrathink?: boolean }).ultrathink,
            !!(config as unknown as Record<string, unknown>).planDisabled,
            turnAnalysis?.needsPlanning ?? false,
          )) {
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
          '"<tool_call>", raw JSON function-call objects like {"type":"function","name":"Tool","parameters":{}}, ' +
          'or similar tokens in your text — call tools via the proper API only. ' +
          'If the user asks you to echo a token, marker, or string, echo it as plain text; ' +
          'do not call Wallet or any other tool unless the user explicitly asks for that tool-backed information.';
      }

      // Safety net: handled in llm.ts resolveVirtualModel()

      // Sanitize: remove orphaned tool results that could confuse the API
      const sanitized = sanitizeHistory(history);
      if (sanitized.length !== history.length) {
        replaceHistory(history, sanitized);
      }

      // Consume any pending forced tool_choice from the previous round's
      // grounding-retry decision. `tool_choice` is dropped automatically in
      // llm.ts if `tools` ended up empty, so it's safe to attach here.
      const callToolChoice = forceToolChoiceNextRound;
      forceToolChoiceNextRound = null;

      // Wall-clock start of the model call. Used by the recordUsage call
      // a few hundred lines below so franklin-stats.json captures real
      // latency. Verified 2026-05-05: `franklin stats` reported
      // `avgLat=0.0s` for every model across 5300+ requests because the
      // agent-loop callsite always passed 0 for latencyMs (proxy path
      // already measured correctly). `franklin insights` couldn't surface
      // "this model is consistently slow" or "fallback was faster" until
      // this was fixed.
      const llmCallStartedAt = Date.now();
      try {
        const result = await client.complete(
          {
            model: resolvedModel,
            messages: history,
            system: callSystemPrompt,
            tools: callToolDefs,
            max_tokens: callMaxTokens,
            stream: true,
            ...(callToolChoice ? { tool_choice: callToolChoice } : {}),
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
          const EMPTY_FALLBACK_MODELS = ['nvidia/qwen3-coder-480b', 'nvidia/glm-4.7', 'zai/glm-5.1'];
          const nextModel = EMPTY_FALLBACK_MODELS.find(m => m !== config.model && !turnFailedModels.has(m));
          if (nextModel && recoveryAttempts < 2) {
            recoveryAttempts++;
            turnFailedModels.add(config.model);
            const oldModel = config.model;
            config.model = nextModel;
            config.onModelChange?.(nextModel, 'system');
            const switchLine = formatModelSwitch(oldModel, resolvedModel, 'returned empty', nextModel);
            logger.warn(`[franklin] ${switchLine}`);
            onEvent({ kind: 'text_delta', text: `\n*${switchLine}*\n` });
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

        // ── Stalled-intent recovery ──
        // The model emitted text declaring an action ("Let me check Node.js…")
        // but never bound a tool_use block, so the agent loop has nothing to
        // execute. Verified 2026-05-06 in a Franklin session on
        // nvidia/qwen3-coder-480b: assistant said "First, I need to check if
        // Node.js and npm are available" then end_turn'd with no Bash call.
        // Coder-tuned models routinely treat declaring intent as completing
        // their turn. Same fix as empty-response: switch to a tool-use-strong
        // model and retry the same prompt — re-prompting the same model is
        // deterministic waste because the stall is a model-behavior trait.
        if (!hasTools && hasText) {
          const tailText = responseParts
            .filter(p => p.type === 'text')
            .map(p => (p as { text?: string }).text ?? '')
            .join('\n');
          if (looksLikeStalledIntent(tailText)) {
            // Tool-use-strong fallbacks. Ordered cheap → premium so a free
            // tier still gets a Kimi/Haiku attempt before paying for GPT-5.
            // Excludes nvidia/* and *-coder-* — they're the source population.
            const TOOL_USE_FALLBACK_MODELS = [
              'anthropic/claude-haiku-4.5',
              'moonshot/kimi-k2',
              'openai/gpt-5',
              'anthropic/claude-sonnet-4.6',
            ];
            const nextModel = TOOL_USE_FALLBACK_MODELS.find(
              m => m !== config.model && !turnFailedModels.has(m),
            );
            if (nextModel && recoveryAttempts < 2) {
              recoveryAttempts++;
              turnFailedModels.add(config.model);
              const oldModel = config.model;
              config.model = nextModel;
              config.onModelChange?.(nextModel, 'system');
              const switchLine = formatModelSwitch(
                oldModel,
                resolvedModel,
                'declared intent without tool_use',
                nextModel,
              );
              logger.warn(`[franklin] ${switchLine}`);
              onEvent({ kind: 'text_delta', text: `\n*${switchLine}*\n` });
              continue;
            }
          }
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
          logger.warn(`[franklin] Media too large — stripping and retrying (attempt ${recoveryAttempts})`);
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
          logger.warn(`[franklin] Prompt too long — force compacting (attempt ${recoveryAttempts})`);
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
        if (classified.category === 'timeout' && recoveryAttempts < effectiveMaxRetries) {
          const retryDecision = evaluateTimeoutRetry(history, resolvedModel);
          if (!retryDecision.retry) {
            // Before surfacing the timeout error, try auto-continuation:
            // for tasks too big to finish in one streaming turn (multi-file
            // scaffolds, dashboard builds), inject a chunking-instruction
            // prompt and let the model take one narrow next step. Capped at
            // MAX_AUTO_CONTINUATIONS_PER_TURN — if the chunked attempt also
            // times out, fall through to the normal error path.
            if (
              !isAutoContinuationDisabled() &&
              autoContinuationCount < MAX_AUTO_CONTINUATIONS_PER_TURN
            ) {
              autoContinuationCount++;
              recoveryAttempts++;
              const continuationPrompt = buildContinuationPrompt();
              history.push(continuationPrompt);
              persistSessionMessage(continuationPrompt);
              logger.warn(
                `[franklin] Stream timeout on ${resolvedModel} — auto-continuing with chunked-task prompt`
              );
              onEvent({
                kind: 'text_delta',
                text: '\n*Task too big for one streaming turn — auto-continuing with a smaller chunk...*\n',
              });
              lastSessionActivity = Date.now();
              continue;
            }

            const tokenText = retryDecision.estimatedInputTokens.toLocaleString();
            const costText = retryDecision.estimatedReplayCostUsd > 0
              ? ` and at least $${retryDecision.estimatedReplayCostUsd.toFixed(4)} in input charges`
              : '';
            logger.warn(
              `[franklin] Timeout retry skipped for ${resolvedModel}: ` +
              `~${tokenText} input tokens, replayCost=$${retryDecision.estimatedReplayCostUsd.toFixed(4)}`
            );
            onEvent({
              kind: 'turn_done',
              reason: 'error',
              error:
                `[${classified.label}] ${errMsg}\n` +
                `Tip: Automatic retry skipped to avoid re-sending ~${tokenText} input tokens${costText}. ` +
                'Use /retry if you want to run another full attempt.',
            });
            lastSessionActivity = Date.now();
            persistSessionMeta();
            break;
          }
        }

        if (classified.isTransient && recoveryAttempts < effectiveMaxRetries) {
          // Server-error streak guard: if the same model 5xx's twice in a row
          // it's almost always an upstream incident, not a blip. Switch to
          // the next routing fallback instead of waiting out 5 backoffs on a
          // dead provider — same idea as the payment-failure auto-fallback
          // below, but for transient server errors. Skipped for non-server
          // transients (rate limits, network blips) where retry is the right
          // call. Also skipped when the user picked a concrete model — they
          // explicitly chose this one, so we shouldn't silently swap.
          if (classified.category === 'server' && parseRoutingProfile(config.model)) {
            const streak = (serverErrorsByModel.get(resolvedModel) ?? 0) + 1;
            serverErrorsByModel.set(resolvedModel, streak);
            if (streak >= SERVER_ERROR_STREAK_BEFORE_SWITCH) {
              const fallbackChain = getFallbackChain(routingTier ?? 'MEDIUM',
                parseRoutingProfile(config.model) ?? 'auto');
              const nextModel = fallbackChain.find(m =>
                m !== resolvedModel && (serverErrorsByModel.get(m) ?? 0) < SERVER_ERROR_STREAK_BEFORE_SWITCH
              );
              if (nextModel) {
                config.model = nextModel;
                config.onModelChange?.(nextModel, 'system');
                recoveryAttempts = 0;
                onEvent({
                  kind: 'text_delta',
                  text: `\n*${resolvedModel} keeps 5xx'ing (${streak} in a row) — switching to ${nextModel}*\n`,
                });
                continue;
              }
              // No alternative left in the fallback chain — fall through to
              // the normal retry path so we at least exhaust attempts before
              // surrender.
            }
          }

          recoveryAttempts++;
          // Honor an upstream Retry-After (parsed from the response by
          // llm.ts when 429+ Retry-After is present) over our own
          // exponential backoff. Verified 2026-05-04: a 429 with
          // Retry-After=30s was retried after ~1.5s exponential backoff
          // → got 429 again → burned the rate_limit retry budget. Cap at
          // 30s so the agent never feels "frozen" — anything longer
          // falls back to a different model instead.
          const upstreamWaitMs = classified.retryAfterMs;
          const honorUpstream = typeof upstreamWaitMs === 'number' && upstreamWaitMs <= 30_000;
          const backoffMs = honorUpstream ? upstreamWaitMs : getBackoffDelay(recoveryAttempts);
          logger.warn(
            `[franklin] ${classified.label} error — retrying in ${(backoffMs / 1000).toFixed(1)}s (attempt ${recoveryAttempts}/${effectiveMaxRetries})${honorUpstream ? ' (upstream Retry-After)' : ''}: ${errMsg.slice(0, 100)}`
          );
          // Surface the actual error + model so the user can see which model
          // is failing and what the upstream said. Old "Retrying after Server
          // error" was uninformative — users couldn't tell whether to wait,
          // /retry, or /model-switch.
          const errSnippet = errMsg.replace(/\s+/g, ' ').slice(0, 100);
          onEvent({
            kind: 'text_delta',
            text: `\n*Retrying ${recoveryAttempts}/${effectiveMaxRetries} on ${resolvedModel} — ${classified.label}: ${errSnippet}*\n`,
          });
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }

        // ── Payment failure: auto-fallback to free models ──
        // Track payment-failed models for the entire session — unlike transient errors,
        // 402s will keep failing until the user adds funds. Also handles
        // payment_rejected (signature verified-and-rejected by gateway):
        // same fallback path, but the suggestion text in classifier guides
        // the user toward clock-skew / chain-mismatch fixes rather than
        // "add funds."
        if (classified.category === 'payment' || classified.category === 'payment_rejected') {
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
          const nextFree = pickFreeFallback(lastRoutedCategory, turnFailedModels);
          if (nextFree) {
            const oldModel = config.model;
            config.model = nextFree;
            config.onModelChange?.(nextFree, 'system');
            const reason = `failed [${classified.label}]`;
            onEvent({
              kind: 'text_delta',
              text: `\n*${formatModelSwitch(oldModel, resolvedModel, reason, nextFree)}*\n`,
            });
            continue; // Retry with next model
          }
        }

        // ── Rate-limit / quota: auto-fallback to a different provider ──
        // Per-day TPM caps (Anthropic) won't clear in this session; per-second
        // limits already had their backoff retry above and still failed. In
        // both cases, the productive next move is to run the same turn on a
        // model from a different provider rather than thrash on the failing
        // one. Mirror the payment fallback shape: mark the model as failed
        // for this turn and pick the next free model that hasn't failed yet.
        if (classified.category === 'rate_limit') {
          turnFailedModels.add(config.model);
          if (lastRoutedCategory) {
            recordOutcome(lastRoutedCategory, config.model, 'rate_limit');
          }
          const nextFree = pickFreeFallback(lastRoutedCategory, turnFailedModels);
          if (nextFree) {
            const oldModel = config.model;
            config.model = nextFree;
            config.onModelChange?.(nextFree, 'system');
            // Reset retry counter — the new model gets its own retry budget.
            recoveryAttempts = 0;
            onEvent({
              kind: 'text_delta',
              text: `\n*${formatModelSwitch(oldModel, resolvedModel, 'rate-limited', nextFree)}*\n`,
            });
            continue;
          }
        }

        // ── Unrecoverable: show error with suggestion from classifier ──
        // For rate_limit specifically, augment the classifier's generic
        // suggestion with an explicit "all free models exhausted — switch
        // to a paid model" hint when we got here because pickFreeFallback
        // returned null. Verified 2026-05-04: the screenshot's session
        // ended with a bare "[RateLimit] API error: 429" because every
        // free model had already been ruled out earlier in the turn —
        // the user had a funded wallet but no signal that paid models
        // were the way out.
        let suggestion = classified.suggestion ? `\nTip: ${classified.suggestion}` : '';
        if (classified.category === 'rate_limit' && turnFailedModels.size > 0) {
          suggestion = `\nTip: All free models tried this turn are rate-limited. Switch to a paid model with /model anthropic/claude-sonnet-4.6 (or any other paid model) and retry — your wallet handles it. Or wait ~60s and /retry the same turn.`;
        }
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

      // Record usage for stats tracking (franklin stats command).
      // Pass the fallback flag so franklin-stats.json's totalFallbacks +
      // per-model fallbackCount stay in sync with the audit log a few
      // lines below — same `turnFailedModels.size > 0` predicate, same
      // turn. Without this, stats showed 0 fallbacks across 5150 real
      // requests on a machine that visibly hit fallback paths in
      // franklin-debug.log; `franklin insights` was therefore useless
      // for spotting a hot routing chain.
      const costEstimate = estimateCost(resolvedModel, inputTokens, usage.outputTokens, 1);
      const llmLatencyMs = Date.now() - llmCallStartedAt;
      recordUsage(resolvedModel, inputTokens, usage.outputTokens, costEstimate, llmLatencyMs, turnFailedModels.size > 0);

      // ── Circuit breakers: prevent infinite-loop wallet drain ──
      // Per-turn $-cap was removed in v3.11.0 — runaway loops are caught by
      // MAX_TOOL_CALLS_PER_TURN (25) and MAX_TINY_RESPONSES (2) above; the
      // wallet balance itself is the ultimate ceiling. Batch callers that
      // need a hard $ ceiling can still pass `config.maxSpendUsd` (handled
      // a few lines below).
      //
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
      // Capture tool names invoked in this assistant turn. The AuditEntry
      // interface has had a `toolCalls?: string[]` slot since 3.15.11, but
      // nothing populated it — verified 2026-05-04 in a real Opus session
      // where 14 audit rows showed `tools=[]` despite Bash being called
      // every turn (the session jsonl had the tool_use blocks; the audit
      // just lost them). Now we pull names off responseParts so post-hoc
      // analytics can answer "what tools fired most often last week" from
      // ~/.blockrun/franklin-audit.jsonl alone.
      const turnToolNames: string[] = [];
      for (const p of responseParts) {
        if (p.type === 'tool_use') {
          const name = (p as { name?: string }).name;
          if (typeof name === 'string') turnToolNames.push(name);
        }
      }

      appendAudit({
        ts: Date.now(),
        sessionId,
        model: resolvedModel,
        inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costEstimate,
        // Any failed model this turn means the model that finally
        // succeeded was a fallback. Without this, audit log read 0%
        // fallbacks across 4k entries — useless for diagnosing whether
        // the routing chain is healthy or hot.
        fallback: turnFailedModels.size > 0,
        source: 'agent',
        workDir,
        prompt: extractLastUserPrompt(history),
        toolCalls: turnToolNames.length > 0 ? turnToolNames : undefined,
        routingTier,
      });

      // Accumulate session-level totals for session meta
      sessionInputTokens += inputTokens;
      sessionOutputTokens += usage.outputTokens;
      sessionCostUsd += costEstimate;
      turnCostUsd += costEstimate;
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
          logger.warn(`[franklin] Max tokens hit — escalating to ${maxTokensOverride}`);
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

      // ── Gateway error masquerading as text (BlockRun → Anthropic TPM) ──
      // Some upstreams swallow rate-limit / quota errors and emit them as a
      // single bracketed text block on a 200 OK. Persisting that as a real
      // assistant reply poisons history (the next turn sees an "answer" that
      // is actually a transport error) and triggers grounding-check retries
      // that hit the same wall. Detect, throw into the classifier, and let
      // the existing recovery flow handle it.
      const gatewayErr = looksLikeGatewayErrorAsText(responseParts);
      if (gatewayErr.match) {
        logger.error(
          `[franklin] Gateway returned an error text in lieu of an answer (${resolvedModel}): ${gatewayErr.message}`
        );
        throw new Error(gatewayErr.message);
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

              // Hard enforcement: set tool_choice so the model can't fabricate
              // citations in lieu of running tools (the round-2 failure mode
              // from the Tampa→Miami log). If the evaluator named exactly one
              // available tool AND that tool's domain matches the user's
              // prompt, pin to it; otherwise force "any" tool use and let
              // the generator pick the right one.
              //
              // Domain validation guards against the cheap evaluator model
              // hallucinating a wrong specialized tool (e.g., suggesting
              // TradingMarket for a real-estate question because the prompt
              // listed it as the first example tool). Specialized tools —
              // crypto trading, DeFi, swap quotes, X.com search — only get
              // pinned when their domain keywords appear in the user prompt;
              // otherwise we drop down to "any tool" and let the smart
              // generator model decide based on tool descriptions.
              const namedTools = extractMissingToolNames(gResult);
              const availableNames = new Set(buildCallToolDefs().map(t => t.name));
              const matched = namedTools.filter(n => availableNames.has(n));
              const promptForDomainCheck = (lastUserInput || '').toLowerCase();
              if (matched.length === 1 && isToolRelevantToPrompt(matched[0], promptForDomainCheck)) {
                forceToolChoiceNextRound = { type: 'tool', name: matched[0] };
              } else if (availableNames.size > 0) {
                forceToolChoiceNextRound = { type: 'any' };
              }

              onEvent({
                kind: 'text_delta',
                text: forceToolChoiceNextRound
                  ? `\n\n*Ungrounded claims detected — forcing tool use (${forceToolChoiceNextRound.type === 'tool' ? forceToolChoiceNextRound.name : 'any'}) and retrying...*\n\n`
                  : '\n\n*Ungrounded claims detected — retrying with required tool calls...*\n\n',
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
        // End-of-turn marker for question-shaped responses. Real-world UX
        // problem 2026-05-06: agent finishes a turn with "要我查一下 X 吗?"
        // and stops; the user reads the silence as "Franklin died" twice in
        // one hour. The Ink input box is already on screen but it's easy to
        // miss after a long output scroll. A single trailing italic line
        // makes the wait state explicit. Only fires when the model's last
        // emitted text ends with `?` or `？` so non-question turns don't
        // get a noisy hint.
        if (endedWithQuestion(responseParts)) {
          onEvent({ kind: 'text_delta', text: '\n*▸ awaiting your reply (or type a new message)*\n' });
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
      for (const [inv, result] of results) {
        const name = inv.name;
        turnToolCounts.set(name, (turnToolCounts.get(name) || 0) + 1);
        // Track (tool, input)-signature for the loop detector below.
        // Identical signatures → real loop. Different inputs → exploration.
        const sig = toolCallSignature(name, inv.input);
        turnSignatureCounts.set(sig, (turnSignatureCounts.get(sig) || 0) + 1);
        // Session-scope aggregate (drives telemetry opt-in export).
        sessionToolCounts.set(name, (sessionToolCounts.get(name) || 0) + 1);

        // Read file dedup: track paths already read
        if (name === 'Read' && inv.input.file_path) {
          readFileCache.add(inv.input.file_path as string);
        }

        // Failed-external-call streak: count consecutive Bash/WebFetch calls
        // whose output indicates a network/auth wall. Reset on any non-failed
        // external call so legitimate retry-then-succeed paths aren't punished.
        if (EXTERNAL_TOOL_NAMES.has(name)) {
          const looksFailed = isExternalWallFailure(
            name,
            typeof result.output === 'string' ? result.output : '',
            result.isError,
          );
          if (looksFailed) consecutiveFailedExternal++;
          else consecutiveFailedExternal = 0;
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
          // Vision attachments: if a tool returned image bytes (e.g. Read on a
          // .png), wrap them into Anthropic-native tool_result.content so
          // vision-capable models can actually see the image. The gateway
          // preserves these blocks end-to-end via the tool_result side channel.
          if (result.images && result.images.length > 0) {
            const content: Array<
              | { type: 'text'; text: string }
              | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
            > = [{ type: 'text', text: result.output }];
            for (const img of result.images) {
              content.push({
                type: 'image',
                source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
              });
            }
            return {
              type: 'tool_result' as const,
              tool_use_id: inv.id,
              content,
              is_error: result.isError,
            };
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
      // Warn about same-tool repetition — fire once per tool name per turn.
      // Re-injecting on every subsequent call (the pre-3.15.28 behavior)
      // just spammed the model's context: Opus-4.7 verified to ignore 4
      // sequential "STOP" messages and keep calling Bash. Cleaner contract:
      // one nudge at the threshold, and the loop detector below catches
      // genuine stuck loops via input-signature repetition (3.15.30
      // replaced 3.15.28's count-based hard stop — that broke legitimate
      // exploratory data work where 15 distinct gsutil/bq calls were
      // each producing new insights).
      for (const [name, count] of turnToolCounts) {
        if (count === SAME_TOOL_WARN_THRESHOLD && !sameToolWarned.has(name)) {
          sameToolWarned.add(name);
          outcomeContent.push({
            type: 'tool_result' as const,
            tool_use_id: `guardrail-warn-${name}`,
            content: `[SYSTEM] You have called ${name} ${count} times this turn. Stop and present your results now. Do not make more ${name} calls — if you need different data, switch tools or ask the user.`,
            is_error: true,
          });
        }
      }

      // True loop detector: same (tool, input) signature repeated.
      // Catches the actual failure mode (model retrying the exact same
      // call hoping for a different result) without misfiring on
      // legitimate exploration where each call has different input.
      let stuckSignature: { sig: string; count: number } | null = null;
      for (const [sig, count] of turnSignatureCounts) {
        if (count >= SAME_SIGNATURE_HARD_STOP) {
          stuckSignature = { sig, count };
          break;
        }
      }

      // Hard cap: nudge the model to stop. Inject once per turn —
      // re-injecting on every iteration past the cap is just noise
      // and clutters the model's context with repeated stop signals.
      if (turnToolCalls >= MAX_TOOL_CALLS_PER_TURN && !toolCapWarned) {
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

      // Cap signaling: warn once per turn (was firing every iteration
      // past the cap — verified on a real user log, one turn produced
      // 76 sequential warnings 25→100). Hard break at 2× cap stops a
      // runaway model that ignores the soft stop signal above.
      if (turnToolCalls >= MAX_TOOL_CALLS_PER_TURN && !toolCapWarned) {
        toolCapWarned = true;
        logger.warn(`[franklin] Tool call cap hit: ${turnToolCalls} calls this turn (soft cap ${MAX_TOOL_CALLS_PER_TURN}, hard cap ${HARD_TOOL_CAP})`);
      }
      // Format spend-so-far for cap messages — surfacing the dollar amount
      // tells the user the real impact ("$0.05 wasted") instead of just
      // "tool limit exceeded" which doesn't convey severity.
      const spendNote = turnCostUsd > 0
        ? `${turnToolCalls} tool calls, $${turnCostUsd.toFixed(4)} spent this turn`
        : `${turnToolCalls} tool calls this turn`;

      if (turnToolCalls >= HARD_TOOL_CAP) {
        logger.error(`[franklin] Hard tool cap exceeded (${turnToolCalls}) — ending turn to prevent runaway`);
        onEvent({
          kind: 'text_delta',
          text: `\n\n⚠️ Runaway loop stopped: ${spendNote}, hit hard cap of ${HARD_TOOL_CAP}. Try rephrasing or use \`/model\` to switch.\n`,
        });
        onEvent({ kind: 'turn_done', reason: 'cap_exceeded' });
        break;
      }
      // Signature-based hard stop (3.15.30). The original 3.15.28 fired
      // on count alone (Bash 6× → break), which incorrectly killed
      // legitimate data-engineering work — the same Opus-4.7 session
      // verified at 2026-05-04 13:36 was making 15 distinct gsutil/bq
      // calls, each producing new insights. Now we only break when the
      // SAME (tool, input) signature has been called 3× — the actual
      // failure mode of "model retrying the exact same call hoping
      // something changes". Different inputs = exploration, allowed.
      if (stuckSignature) {
        const toolName = stuckSignature.sig.split('::')[0];
        logger.error(`[franklin] Signature-loop hard stop: \`${toolName}\` called with identical input ${stuckSignature.count} times this turn — ending turn`);
        onEvent({
          kind: 'text_delta',
          text: `\n\n⚠️ Loop stopped: ${spendNote} before \`${toolName}\` repeated the same input ${stuckSignature.count}×. Rephrase what you need, or try \`/model\` to switch.\n`,
        });
        onEvent({ kind: 'turn_done', reason: 'cap_exceeded' });
        break;
      }
      // Thrashing-against-a-wall hard stop (3.15.69). Catches the case
      // where each call is structurally distinct (different headers, methods,
      // auth schemes, query params) but every one returns 4xx/5xx/WAF.
      // Verified 2026-05-05: glm-5.1 burned 50 calls / $0.05 cycling through
      // ~17 curl variants against Cloudflare-blocked api.querit.ai — every
      // input distinct so the signature guard above couldn't help.
      if (consecutiveFailedExternal >= MAX_CONSECUTIVE_FAILED_EXTERNAL) {
        logger.error(`[franklin] Failed-external-call streak: ${consecutiveFailedExternal} consecutive Bash/WebFetch calls returned auth/network errors — ending turn`);
        onEvent({
          kind: 'text_delta',
          text: `\n\n⚠️ Hitting a wall: ${consecutiveFailedExternal} consecutive external calls returned auth/firewall errors (${spendNote}). The endpoint or credentials likely don't work. Try a different approach, or use \`/model\` to switch.\n`,
        });
        onEvent({ kind: 'turn_done', reason: 'cap_exceeded' });
        break;
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
