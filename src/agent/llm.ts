/**
 * LLM Client for Franklin
 * Calls BlockRun API directly with x402 payment handling and streaming.
 * Original implementation — not derived from any existing codebase.
 */

import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import { USER_AGENT, type Chain } from '../config.js';
import { appendSettlementRow } from '../stats/cost-log.js';
import { routeRequest, parseRoutingProfile } from '../router/index.js';
import type {
  Dialogue,
  CapabilityDefinition,
  ContentPart,
  CapabilityInvocation,
  TextSegment,
  ThinkingSegment,
} from './types.js';
import { ThinkTagStripper } from './think-tag-stripper.js';
import { isNemotronProseModel, stripNemotronProse } from './nemotron-prose-stripper.js';

// Reasoning-tier models the gateway routes to that reject `tool_choice`
// outright. Pattern: OpenAI o1/o3 family + DeepSeek's reasoner variant.
// Add new entries as their 400 errors appear in real sessions; this is
// a known-bad allowlist, not a guess. Wildcard substring match keeps it
// resilient to model-revision suffixes (`o1-mini`, `o3-2026-04`, etc.).
const MODELS_WITHOUT_TOOL_CHOICE_SUBSTR = [
  'deepseek-reasoner',
  'openai/o1',
  'openai/o3',
];

function modelDoesNotSupportToolChoice(model: string): boolean {
  if (!model) return false;
  return MODELS_WITHOUT_TOOL_CHOICE_SUBSTR.some(s => model.includes(s));
}

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Anthropic-compatible tool_choice. Forwarded as-is through the proxy and on
 * to the backend (Anthropic / OpenAI / Gemini gateways translate as needed).
 *
 * - `auto`  — model decides (default if omitted)
 * - `any`   — must call SOME tool, model picks which
 * - `tool`  — must call the specifically named tool
 * - `none`  — must not call any tool
 *
 * Used by the grounding-retry path in `loop.ts`: when the evaluator catches
 * an ungrounded answer that should have invoked tools, the next round sets
 * `tool_choice` to force tool use rather than relying on a soft instruction
 * the model can defy by fabricating citations.
 */
export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

export interface ModelRequest {
  model: string;
  messages: Dialogue[];
  system?: string;
  tools?: CapabilityDefinition[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  tool_choice?: ToolChoice;
}

export interface StreamChunk {
  kind: 'content_block_start' | 'content_block_delta' | 'content_block_stop'
      | 'message_start' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  payload: Record<string, unknown>;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClientOptions {
  apiUrl: string;
  chain: Chain;
  debug?: boolean;
}

function parseTimeoutEnv(name: string): number | null {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Convert an x402 `details.amount` field (USDC in micro-units, 6 decimals)
 * to a USD float. Mirrors the SDK's `appendCostLog` math so the agent
 * loop, the proxy, and `cost_log.jsonl` all agree to the cent.
 */
function paymentAmountToUsd(amount: string | number | undefined): number {
  if (amount === undefined || amount === null) return 0;
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return 0;
  return n / 1e6;
}

/**
 * Replace Unicode box-drawing characters with their ASCII equivalents.
 *
 * Models occasionally emit U+2502 (`│`) and U+2500 (`─`) in markdown tables
 * — sometimes mixed with ASCII `|` / `-` in the same table. No markdown
 * renderer parses the mix, and the "table" displays as run-on text. Verified
 * 2026-05-06 in a real session: opus-4.7 emitted a CRCL fundamentals table
 * with `│` data rows and `|` separator, ignoring the system-prompt nudge
 * added in 3.15.76. The unconditional swap fixes the rendering at the
 * streaming boundary so every downstream surface (user terminal, conversation
 * history, audit log) gets the corrected version.
 *
 * Trade: the rare case where a user genuinely wants box-drawing in output
 * (e.g. asking what U+2502 looks like) loses fidelity. Acceptable — that
 * case has no real-world frequency, the broken-tables case has weekly.
 */
export function sanitizeTableUnicode(s: string): string {
  if (!s) return s;
  return s.replace(/│/g, '|').replace(/─/g, '-');
}

function getModelRequestTimeoutMs(): number {
  // 180s budget for *time-to-headers* (the gateway flushes SSE headers only
  // once the upstream model emits its first token). Reasoning-class models
  // (zai/glm-*, nemotron *-reasoning, deepseek-r*, gpt-5-codex, anthropic
  // extended-thinking) routinely take 60–120s to first token on cache-cold
  // prompts or when the gateway is under load — the old 45s default cut
  // those off and wasted USDC on retries that hit the same wall. 180s is
  // generous enough for any realistic first-token latency, still bounded
  // enough that genuinely dead requests surface within ~6 min after the
  // single timeout retry.
  return (
    parseTimeoutEnv('FRANKLIN_MODEL_REQUEST_TIMEOUT_MS') ??
    parseTimeoutEnv('FRANKLIN_MODEL_IDLE_TIMEOUT_MS') ??
    180_000
  );
}

function getModelStreamIdleTimeoutMs(): number {
  return (
    parseTimeoutEnv('FRANKLIN_MODEL_STREAM_IDLE_TIMEOUT_MS') ??
    parseTimeoutEnv('FRANKLIN_MODEL_IDLE_TIMEOUT_MS') ??
    90_000
  );
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const forward = () => child.abort(parent.reason);
  parent.addEventListener('abort', forward, { once: true });
  return () => parent.removeEventListener('abort', forward);
}

function createModelTimeoutError(stage: 'request' | 'stream', model: string, timeoutMs: number): Error {
  return new Error(`Model ${stage} timed out after ${timeoutMs}ms on ${model}`);
}

async function withAbortableTimeout<T>(
  work: () => Promise<T>,
  controller: AbortController,
  timeoutError: Error,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return work();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try { controller.abort(timeoutError); } catch { /* ignore */ }
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Extract the most human-readable message from an error body.
 * Some gateways wrap provider errors multiple times, e.g.
 * `{"error":{"message":"{\"error\":{\"message\":\"...\"}}"}}`.
 * Peel those layers so the UI doesn't show raw nested JSON.
 */
export function extractApiErrorMessage(errorBody: string): string {
  const visited = new Set<unknown>();

  const walk = (value: unknown, depth = 0): string | null => {
    // Some providers wrap the real message under error.message as a JSON
    // string, which adds another object/string hop. Allow a few layers of
    // nesting without risking runaway recursion.
    if (depth > 8 || visited.has(value)) return null;
    if (value && (typeof value === 'object' || typeof value === 'string')) {
      visited.add(value);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        try {
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed = JSON.parse(trimmed);
            const nested = walk(parsed, depth + 1);
            if (nested) return nested;
          }
        } catch { /* plain string — use as-is below */ }
      }
      return trimmed || null;
    }

    if (!value || typeof value !== 'object') return null;

    const obj = value as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'reason']) {
      if (key in obj) {
        const nested = walk(obj[key], depth + 1);
        if (nested) return nested;
      }
    }

    return null;
  };

  const extracted = walk(errorBody) ?? errorBody;
  return extracted.replace(/\s+/g, ' ').trim();
}

// ─── Anthropic Prompt Caching ─────────────────────────────────────────────

/**
 * Apply Anthropic prompt caching using the `system_and_3` strategy.
 * Pattern from nousresearch/hermes-agent `agent/prompt_caching.py`.
 *
 * Places 4 cache_control breakpoints (Anthropic's max):
 *   1. System prompt (stable across all turns)
 *   2-4. Last 3 non-system messages (rolling window)
 *
 * Also caches the last tool definition (tools are stable across turns).
 *
 * This keeps the cache warm: each new turn extends the cached prefix rather
 * than invalidating it. Multi-turn conversations see ~75% input token savings
 * on Anthropic models.
 */
/**
 * True if the given Anthropic model accepts the `thinking: { type: 'enabled' }`
 * API flag (so-called *extended thinking*). Models using *adaptive thinking*
 * (Opus 4.7 and later) reject that flag — the behavior is built in and not
 * opt-in via API. Keeping the allowlist explicit, not derived from a regex,
 * so a future model that happens to include "opus" in its name doesn't
 * silently re-enable extended thinking on a model that can't handle it.
 *
 * Exported so tests can pin this decision without a live API.
 */
export function modelHasExtendedThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Excluded: Opus 4.7+ uses adaptive thinking; sending `thinking: enabled`
  // causes the API to 400.
  if (m.includes('opus-4.7') || m.includes('opus-4-7')) return false;
  return (
    m.includes('opus-4.6') || m.includes('opus-4-6') ||
    m.includes('opus-4.5') || m.includes('opus-4-5') ||
    m.includes('opus-4.1') || m.includes('opus-4-1') ||
    m.includes('sonnet-4') ||
    m.includes('sonnet-3.7')
  );
}

/**
 * Classify an unparseable tool-call JSON failure so the user and the model
 * get an actionable message instead of a single generic line. Exported for
 * direct unit testing — the happy path hits it only on stream error.
 */
export function classifyToolCallFailure(
  toolName: string,
  rawInput: string,
  signal: AbortSignal | undefined,
  model: string,
): string {
  if (signal?.aborted) {
    return `[Tool call to ${toolName} was canceled before the input finished streaming. ` +
      `Previous response kept. Resubmit the last message to retry.]`;
  }
  const charsReceived = rawInput.length;
  // If we have almost nothing, the stream stopped early (timeout / model cut off).
  // If we have a lot but it's still invalid, the model produced malformed JSON.
  if (charsReceived < 8) {
    return `[Tool call to ${toolName} was interrupted mid-stream (only ${charsReceived} chars received) — ` +
      `likely a model timeout or rate limit on ${model}. Try \`/model <other>\` or resubmit.]`;
  }
  const looksTruncated = !rawInput.trimEnd().endsWith('}');
  if (looksTruncated) {
    return `[Model ${model} cut off mid tool call (${charsReceived} chars received, JSON not closed). ` +
      `Try \`/model <stronger>\` or shorten the prompt.]`;
  }
  const preview = rawInput.slice(0, 120).replace(/\s+/g, ' ');
  return `[Tool call to ${toolName} had malformed JSON input (${charsReceived} chars). ` +
    `Preview: ${preview}${rawInput.length > 120 ? '…' : ''} — ` +
    `this is usually a model output bug; try \`/model <other>\` or retry.]`;
}

export function isRoleplayedJsonToolCallText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.type === 'function' &&
      typeof parsed.name === 'string' &&
      ('parameters' in parsed || 'arguments' in parsed)
    );
  } catch {
    return false;
  }
}

function applyAnthropicPromptCaching(
  payload: Record<string, unknown>,
  request: ModelRequest
): Record<string, unknown> {
  const out = { ...payload };
  const cacheMarker = { type: 'ephemeral' as const };

  // 1. System prompt → wrap as array with cache_control on the text block
  if (typeof request.system === 'string' && request.system.length > 0) {
    out['system'] = [
      { type: 'text', text: request.system, cache_control: cacheMarker },
    ];
  }

  // 2. Tools → cache_control on the last tool (stable across turns)
  if (request.tools && request.tools.length > 0) {
    const toolsCopy = request.tools.map(t => ({ ...t }));
    (toolsCopy[toolsCopy.length - 1] as Record<string, unknown>)['cache_control'] = cacheMarker;
    out['tools'] = toolsCopy;
  }

  // 3. Messages → rolling cache_control on last 3 messages (user/assistant).
  // System is a separate field in ModelRequest, so all messages here are non-system.
  // Strategy: mark the last 3 messages so the cached prefix extends as the
  // conversation grows. Older cached prefixes expire after 5 min but newer
  // ones keep the cache warm.
  if (request.messages && request.messages.length > 0) {
    const messagesCopy = request.messages.map(m => ({ ...m }));
    // Mark last 3 messages (or fewer if history is shorter)
    const start = Math.max(0, messagesCopy.length - 3);
    for (let idx = start; idx < messagesCopy.length; idx++) {
      const msg = messagesCopy[idx];
      if (typeof msg.content === 'string') {
        (messagesCopy[idx] as Record<string, unknown>)['content'] = [
          { type: 'text', text: msg.content, cache_control: cacheMarker },
        ];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const contentCopy = msg.content.map(c => ({ ...(c as unknown as Record<string, unknown>) }));
        // cache_control goes on the last content block
        contentCopy[contentCopy.length - 1]['cache_control'] = cacheMarker;
        (messagesCopy[idx] as Record<string, unknown>)['content'] = contentCopy;
      }
    }
    out['messages'] = messagesCopy;
  }

  return out;
}

// ─── Client ────────────────────────────────────────────────────────────────

export class ModelClient {
  private apiUrl: string;
  private chain: Chain;
  private debug: boolean;
  private walletAddress = '';
  private cachedBaseWallet: { privateKey: string; address: string } | null = null;
  private cachedSolanaWallet: { privateKey: string; address: string } | null = null;
  private walletCacheTime = 0;
  /**
   * USDC actually charged on the most recent x402 settlement, parsed
   * from `details.amount` (micro-USDC → USD). Reset to 0 at the start
   * of every `streamCompletion`, written by `signBasePayment` /
   * `signSolanaPayment`. Callers read it via `getLastPaidUsd()` after
   * the stream completes so franklin-stats.json records the real wallet
   * charge instead of a token-catalog estimate.
   */
  private lastPaidUsd = 0;
  private static WALLET_CACHE_TTL = 30 * 60 * 1000; // 30 min TTL

  constructor(opts: LLMClientOptions) {
    this.apiUrl = opts.apiUrl;
    this.chain = opts.chain;
    this.debug = opts.debug ?? false;
  }

  /**
   * Stream a completion from the BlockRun API.
   * Yields parsed SSE chunks as they arrive.
   * Handles x402 payment automatically on 402 responses.
   */
  /**
   * Resolve virtual routing profiles (blockrun/auto, blockrun/free) to
   * concrete models. This is the final safety net — if the router in
   * loop.ts didn't resolve it (e.g. old global install without router),
   * we resolve it here before hitting the API. Legacy blockrun/eco and
   * blockrun/premium fall through the unknown-key path to the same
   * default model.
   */
  private resolveVirtualModel(model: string): string {
    if (!model.startsWith('blockrun/')) return model;

    try {
      const profile = parseRoutingProfile(model);
      if (profile) {
        const result = routeRequest('', profile);
        if (result?.model && !result.model.startsWith('blockrun/')) {
          return result.model;
        }
      }
    } catch {
      // Router not available (e.g. old build) — use hardcoded fallback table
    }

    // Static fallback when the router module isn't loadable. Defaults to a
    // FREE model so users aren't silently charged. The unknown-key path also
    // falls through to qwen, so legacy `blockrun/eco` / `blockrun/premium`
    // strings (now retired routing profiles) end up at the same place
    // without needing dedicated entries.
    const FALLBACKS: Record<string, string> = {
      'blockrun/auto': 'nvidia/qwen3-coder-480b',
      'blockrun/free': 'nvidia/qwen3-coder-480b',
    };
    return FALLBACKS[model] || 'nvidia/qwen3-coder-480b';
  }

  /**
   * USDC actually charged for the most recent stream. 0 if no payment
   * was made (free model / cached / pre-stream error). Callers should
   * read this after the stream finishes — before that it carries the
   * value from a previous call.
   */
  getLastPaidUsd(): number {
    return this.lastPaidUsd;
  }

  async *streamCompletion(
    request: ModelRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    // Reset the per-call charge tracker. signBasePayment / signSolanaPayment
    // will set it when the gateway demands a 402 settlement.
    this.lastPaidUsd = 0;
    // Resolve virtual models before any API call
    const resolvedModel = this.resolveVirtualModel(request.model);
    if (resolvedModel !== request.model) {
      request = { ...request, model: resolvedModel };
    }

    const isAnthropic = request.model.startsWith('anthropic/');
    const isGLM = request.model.startsWith('zai/') || request.model.includes('glm');
    const isGeminiThinkingRequired =
      request.model.startsWith('google/gemini-3.1') ||
      request.model.startsWith('google/gemini-2.5-pro');

    // Build the request payload, injecting model-specific optimizations
    let requestPayload: Record<string, unknown> = { ...request, stream: true };

    // Safety: tool_choice without tools causes upstream 400. Strip rather
    // than reject so callers don't have to coordinate the two fields.
    if (
      requestPayload['tool_choice'] !== undefined &&
      (!Array.isArray(requestPayload['tools']) || (requestPayload['tools'] as unknown[]).length === 0)
    ) {
      delete requestPayload['tool_choice'];
    }

    // Models that don't support `tool_choice` (reasoning-only families).
    // Verified 2026-05-04 from a real session: grounding-retry forced
    // tool_choice on a request that ended up on deepseek-reasoner, which
    // returned `400 Invalid request: deepseek-reasoner does not support
    // this tool_choice`. Same shape applies to OpenAI o1 / o3 and
    // similar restricted reasoning models. Strip silently — the agent
    // loop's grounding-retry contract already tolerates the field
    // disappearing (it'll re-evaluate next turn).
    if (requestPayload['tool_choice'] !== undefined && modelDoesNotSupportToolChoice(request.model)) {
      delete requestPayload['tool_choice'];
    }

    // ── GLM-specific optimizations ───────────────────────────────────────────
    // GLM models work best with temperature=0.8 per official zai spec.
    // Enable thinking mode only for explicit reasoning variants (-thinking-).
    if (isGLM) {
      if (requestPayload['temperature'] === undefined) {
        requestPayload['temperature'] = 0.8;
      }
      // Only enable thinking for models that explicitly ship reasoning mode
      if (request.model.includes('-thinking-')) {
        requestPayload['thinking'] = { type: 'enabled' };
      }
    }

    // Gemini Pro reasoning models reject a missing/zero thinking budget. Normalize
    // the gateway default so fallback routing doesn't fail with "Budget 0 is invalid."
    if (isGeminiThinkingRequired) {
      // The gateway's streaming path currently drops Gemini's thinking budget;
      // non-streaming preserves it. We convert the JSON response back into the
      // same internal chunks below so callers keep one code path.
      requestPayload['stream'] = false;
      const maxOut = request.max_tokens ?? 16_384;
      const budgetTokens = Math.min(maxOut, 8_192);
      const thinking = requestPayload['thinking'];
      if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
        requestPayload['thinking'] = {
          ...thinking,
          type: 'enabled',
          budget_tokens: budgetTokens,
        };
      } else {
        requestPayload['thinking'] = {
          type: 'enabled',
          budget_tokens: budgetTokens,
        };
      }
    }

    if (isAnthropic) {
      // ─ Anthropic extended thinking ──────────────────────────────────────
      // Enable the `thinking` API block only for models that accept it.
      // Claude Opus 4.7 and newer use *adaptive* thinking (built-in, no API
      // flag); passing the extended-thinking flag to them makes Anthropic
      // reject the request. See `modelHasExtendedThinking` for the allowlist.
      if (modelHasExtendedThinking(request.model)) {
        const maxOut = (request.max_tokens ?? 16_384);
        requestPayload['thinking'] = {
          type: 'enabled',
          budget_tokens: Math.min(maxOut, 16_384), // Cap thinking budget — most benefit comes from first few K tokens
        };
        // Extended thinking requires temperature=1 on Anthropic API
        requestPayload['temperature'] = 1;
      }

      // ─ Anthropic prompt caching: `system_and_3` strategy ─────────────────
      // 4 cache_control breakpoints (Anthropic max):
      //   1. System prompt (stable across turns)
      //   2-4. Last 3 non-system messages (rolling window)
      //
      // This keeps the cache warm across turns: each new turn extends the
      // cache instead of invalidating it. ~75% input token savings on
      // multi-turn conversations. Pattern adopted from nousresearch/hermes-agent.
      requestPayload = applyAnthropicPromptCaching(requestPayload, request);
    }

    // ── GPT-5 / Codex: use "developer" role for system prompt ──────────────
    // OpenAI GPT models give stronger instruction-following weight to the
    // "developer" role. Move the top-level system prompt into messages[0]
    // with role "developer" instead of the default "system".
    const isGPT5OrCodex = request.model.includes('gpt-5') || request.model.includes('codex');
    if (isGPT5OrCodex && typeof request.system === 'string' && request.system.length > 0) {
      const systemRole = 'developer';
      const existingMessages = (requestPayload['messages'] as unknown[]) || [];
      requestPayload['messages'] = [
        { role: systemRole, content: request.system },
        ...existingMessages,
      ];
      delete requestPayload['system'];
    }

    const body = JSON.stringify(requestPayload);

    const endpoint = `${this.apiUrl}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'x402-agent-handles-auth',
      'User-Agent': USER_AGENT,
    };

    // Enable prompt caching + extended thinking betas for Anthropic models
    if (isAnthropic) {
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    if (this.debug) {
      console.error(`[franklin] POST ${endpoint} model=${request.model}`);
    }

    const requestTimeoutMs = getModelRequestTimeoutMs();
    const streamTimeoutMs = getModelStreamIdleTimeoutMs();
    const requestController = new AbortController();
    const unlinkAbort = linkAbortSignal(signal, requestController);

    try {
      let response = await withAbortableTimeout(
        () => fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: requestController.signal,
        }),
        requestController,
        createModelTimeoutError('request', request.model, requestTimeoutMs),
        requestTimeoutMs,
      );

      // Handle x402 payment
      if (response.status === 402) {
        if (this.debug) console.error('[franklin] Payment required — signing...');
        const paymentHeader = await this.signPayment(response, request.model);
        if (!paymentHeader) {
          yield { kind: 'error', payload: { message: 'Payment signing failed' } };
          return;
        }

        response = await withAbortableTimeout(
          () => fetch(endpoint, {
            method: 'POST',
            headers: { ...headers, ...paymentHeader },
            body,
            signal: requestController.signal,
          }),
          requestController,
          createModelTimeoutError('request', request.model, requestTimeoutMs),
          requestTimeoutMs,
        );
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown error');
        let message = extractApiErrorMessage(errorBody);

        // 429 with Retry-After header: tag the error message so the
        // classifier can extract and the loop can honor it. Verified
        // 2026-05-04 in a live session: a 429 fired with the loop's
        // exponential backoff (~1-2s) but the upstream's actual
        // Retry-After window was ~30s — the agent retried prematurely
        // and burned its rate_limit retry budget. Anthropic + most
        // gateways send Retry-After as either seconds (integer) or an
        // HTTP-date; we only honor the seconds form (the date form is
        // rare in practice and harder to validate against clock skew).
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (Number.isFinite(seconds) && seconds > 0 && seconds <= 600) {
              message = `${message} [retry-after-ms=${seconds * 1000}]`;
            }
          }
        }

        // Runtime tool_choice retry. The static allowlist at line ~35
        // catches the case where the request goes directly to a model
        // whose name contains `deepseek-reasoner` / `openai/o1` /
        // `openai/o3`. But the gateway sometimes ALIASES a different
        // model name to a reasoner backend — verified 2026-05-04 in a
        // live session: a request for `deepseek/deepseek-v4-pro`
        // returned `400 Invalid request: 400 deepseek-reasoner does not
        // support this tool_choice`, because the gateway routed v4-pro
        // to a deepseek-reasoner upstream. The static allowlist can't
        // know that. Catch the error, drop tool_choice, re-fire once.
        // No payment re-sign needed — original 402 already settled, and
        // the gateway treats this as the same logical request.
        const lc = message.toLowerCase();
        const looksLikeToolChoiceReject =
          response.status === 400 &&
          lc.includes('tool_choice') &&
          (lc.includes('not support') || lc.includes('unsupported') || lc.includes('does not support'));

        if (looksLikeToolChoiceReject && requestPayload['tool_choice'] !== undefined) {
          delete requestPayload['tool_choice'];
          const retryBody = JSON.stringify(requestPayload);
          if (this.debug) {
            console.error(`[franklin] tool_choice rejected by upstream; retrying without it (model=${request.model})`);
          }
          response = await withAbortableTimeout(
            () => fetch(endpoint, {
              method: 'POST',
              headers,
              body: retryBody,
              signal: requestController.signal,
            }),
            requestController,
            createModelTimeoutError('request', request.model, requestTimeoutMs),
            requestTimeoutMs,
          );
          if (response.status === 402) {
            const paymentHeader = await this.signPayment(response, request.model);
            if (!paymentHeader) {
              yield { kind: 'error', payload: { message: 'Payment signing failed' } };
              return;
            }
            response = await withAbortableTimeout(
              () => fetch(endpoint, {
                method: 'POST',
                headers: { ...headers, ...paymentHeader },
                body: retryBody,
                signal: requestController.signal,
              }),
              requestController,
              createModelTimeoutError('request', request.model, requestTimeoutMs),
              requestTimeoutMs,
            );
          }
          if (!response.ok) {
            const retryBodyText = await response.text().catch(() => 'unknown error');
            yield {
              kind: 'error',
              payload: { status: response.status, message: extractApiErrorMessage(retryBodyText) },
            };
            return;
          }
          // Successful retry — fall through to SSE parsing below.
        } else {
          yield {
            kind: 'error',
            payload: { status: response.status, message },
          };
          return;
        }
      }

      if (requestPayload['stream'] === false) {
        yield* this.parseNonStreamingMessage(response, request.model);
        return;
      }

      // Parse SSE stream
      yield* this.parseSSEStream(response, requestController, streamTimeoutMs, request.model);
    } finally {
      unlinkAbort();
    }
  }

  private async *parseNonStreamingMessage(
    response: Response,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const parsed = await response.json() as Record<string, unknown>;
    yield { kind: 'message_start', payload: { message: parsed } };

    const content = Array.isArray(parsed['content']) ? parsed['content'] as Record<string, unknown>[] : [];
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      yield { kind: 'content_block_start', payload: { index, content_block: block } };

      if (block.type === 'text' && typeof block.text === 'string') {
        yield {
          kind: 'content_block_delta',
          payload: { index, delta: { type: 'text_delta', text: block.text } },
        };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        yield {
          kind: 'content_block_delta',
          payload: { index, delta: { type: 'thinking_delta', thinking: block.thinking } },
        };
        if (typeof block.signature === 'string') {
          yield {
            kind: 'content_block_delta',
            payload: { index, delta: { type: 'signature_delta', signature: block.signature } },
          };
        }
      } else if (block.type === 'tool_use') {
        yield {
          kind: 'content_block_delta',
          payload: { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } },
        };
      }

      yield { kind: 'content_block_stop', payload: { index } };
    }

    yield {
      kind: 'message_delta',
      payload: {
        delta: { stop_reason: parsed['stop_reason'] ?? 'end_turn' },
        usage: parsed['usage'] ?? {},
      },
    };
    yield { kind: 'message_stop', payload: {} };

    if (this.debug) {
      console.error(`[franklin] Parsed non-streaming response for ${model}`);
    }
  }

  /**
   * Non-streaming completion for simple requests.
   */
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
    onToolReady?: (tool: CapabilityInvocation) => void,
    onStreamDelta?: (delta: { type: 'text' | 'thinking'; text: string }) => void
  ): Promise<{ content: ContentPart[]; usage: CompletionUsage; stopReason: string }> {
    const collected: ContentPart[] = [];
    let usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = 'end_turn';

    // Accumulate from stream
    let currentText = '';
    let currentThinking = '';
    let currentThinkingSignature = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    const textEmission: { mode: 'undecided' | 'stream' | 'hold' } = { mode: 'undecided' };
    const isNemotronProse = isNemotronProseModel(request.model);
    // Split inline <think>…</think> emitted by reasoning models (nemotron,
    // deepseek-r1, qwq, etc.) that use the text field instead of the native
    // thinking block. Thinking emitted this way is display-only — we don't
    // store it in history (Anthropic thinking blocks require signatures).
    // Reset per text block.
    let textStripper = new ThinkTagStripper();
    // One-shot observability: log when a weak model starts role-playing tool
    // calls as literal text tokens. We don't rewrite the stream — the
    // system-prompt guard in loop.ts is responsible for preventing this.
    // Debug-only because the user already sees the literal text in the UI.
    let toolCallRoleplayWarned = false;
    const appendText = (text: string) => {
      if (!text) return;

      // Sanitize Unicode box-drawing chars to ASCII pipe/dash. 3.15.76's
      // system-prompt nudge asked models not to emit U+2502 / U+2500 in
      // tables — opus-4.7 ignored it 2026-05-06, shipped a CRCL analysis
      // table where data rows used `│` and the separator used `|`. No
      // markdown renderer parses that mix; the table displayed as run-on
      // text. Normalize at the streaming boundary so the user, the model
      // history (next turn the model sees its own corrected output), and
      // the audit log all match.
      text = sanitizeTableUnicode(text);

      currentText += text;
      if (textEmission.mode === 'undecided') {
        const trimmed = currentText.trimStart();
        if (!trimmed) return;

        // Nemotron Omni leaks reasoning prose into the text channel without
        // <think> tags. Hold the buffer for end-of-stream stripping.
        textEmission.mode = isNemotronProse || trimmed.startsWith('{') ? 'hold' : 'stream';
        if (textEmission.mode === 'stream') {
          onStreamDelta?.({ type: 'text', text: currentText });
        }
        return;
      }

      if (textEmission.mode === 'stream') {
        onStreamDelta?.({ type: 'text', text });
      }
    };

    for await (const chunk of this.streamCompletion(request, signal)) {
      switch (chunk.kind) {
        case 'content_block_start': {
          const block = chunk.payload as Record<string, unknown>;
          const cblock = block['content_block'] as Record<string, unknown> | undefined;
          if (cblock?.type === 'tool_use') {
            currentToolId = (cblock.id as string) || '';
            currentToolName = (cblock.name as string) || '';
            currentToolInput = '';
          } else if (cblock?.type === 'thinking') {
            currentThinking = '';
            currentThinkingSignature = '';
          } else if (cblock?.type === 'text') {
            currentText = '';
            textEmission.mode = 'undecided';
            textStripper = new ThinkTagStripper();
          }
          break;
        }
        case 'content_block_delta': {
          const delta = chunk.payload['delta'] as Record<string, unknown> | undefined;
          if (!delta) break;
          if (delta.type === 'text_delta') {
            const raw = (delta.text as string) || '';
            if (!toolCallRoleplayWarned) {
              // Only scan the last ~15 chars of already-emitted text plus the
              // new delta — enough to catch a token straddling the chunk
              // boundary (`[TOOLCALL]`=10, `<tool_calls>`=12) without the
              // O(N²) blowup of re-scanning the whole accumulated text on
              // every delta.
              const window = currentText.slice(-15) + raw;
              if (/\[TOOLCALL\]|<tool_calls?>/i.test(window)) {
                toolCallRoleplayWarned = true;
                if (this.debug) {
                  console.error(
                    `[franklin] Model ${request.model} emitted a tool-call ` +
                    'roleplay token ([TOOLCALL] / <tool_call>) in its text. ' +
                    'This is a model hallucination; real tool calls arrive ' +
                    'as tool_use blocks, not text.',
                  );
                }
              }
            }
            for (const seg of textStripper.push(raw)) {
              if (seg.type === 'text') {
                appendText(seg.text);
              } else if (seg.text) {
                onStreamDelta?.({ type: 'thinking', text: seg.text });
              }
            }
          } else if (delta.type === 'thinking_delta') {
            const text = (delta.thinking as string) || '';
            currentThinking += text;
            if (text) onStreamDelta?.({ type: 'thinking', text });
          } else if (delta.type === 'signature_delta') {
            // Accumulate signature for multi-turn thinking continuity
            currentThinkingSignature += (delta.signature as string) || '';
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += (delta.partial_json as string) || '';
          }
          break;
        }
        case 'content_block_stop': {
          if (currentToolId) {
            let parsedInput: Record<string, unknown> = {};
            let inputParseError = false;
            try {
              parsedInput = JSON.parse(currentToolInput || '{}');
            } catch (parseErr) {
              // Incomplete JSON from stream abort or model error.
              // Mark as error so the executor returns an error result
              // instead of silently invoking the tool with empty/wrong params.
              inputParseError = true;
              if (this.debug) {
                console.error(`[franklin] Malformed tool input JSON for ${currentToolName}: ${(parseErr as Error).message}`);
                console.error(`[franklin] Raw input was: ${currentToolInput.slice(0, 200)}`);
              }
            }

            if (inputParseError) {
              // Don't invoke the tool — add a classified text block so the
              // user (and the model) can see the specific cause. Prior streamed
              // text is already in `collected` from earlier content_block_stop
              // events, so partial work survives.
              collected.push({
                type: 'text',
                text: classifyToolCallFailure(
                  currentToolName,
                  currentToolInput,
                  signal,
                  request.model,
                ),
              } as TextSegment);
            } else {
              const toolInvocation = {
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
                input: parsedInput,
              } as CapabilityInvocation;
              collected.push(toolInvocation);
              // Notify caller so concurrent tools can start immediately
              onToolReady?.(toolInvocation);
            }
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          } else if (currentThinking) {
            collected.push({
              type: 'thinking',
              thinking: currentThinking,
              ...(currentThinkingSignature ? { signature: currentThinkingSignature } : {}),
            } as ThinkingSegment);
            currentThinking = '';
            currentThinkingSignature = '';
          } else {
            // Flush any partial tag held in the stripper
            for (const seg of textStripper.flush()) {
              if (seg.type === 'text') {
                appendText(seg.text);
              } else if (seg.text) {
                onStreamDelta?.({ type: 'thinking', text: seg.text });
              }
            }
            if (currentText) {
              if (textEmission.mode === 'hold' && isRoleplayedJsonToolCallText(currentText)) {
                if (this.debug) {
                  console.error(
                    `[franklin] Model ${request.model} emitted a raw JSON function-call object as text. ` +
                    'Treating it as non-productive output so recovery can try another model.',
                  );
                }
              } else if (textEmission.mode === 'hold' && isNemotronProse) {
                const { thinking, answer } = stripNemotronProse(currentText);
                if (thinking) onStreamDelta?.({ type: 'thinking', text: thinking });
                onStreamDelta?.({ type: 'text', text: answer });
                collected.push({ type: 'text', text: answer } as TextSegment);
              } else {
                if (textEmission.mode !== 'stream') {
                  onStreamDelta?.({ type: 'text', text: currentText });
                }
                collected.push({
                  type: 'text',
                  text: currentText,
                } as TextSegment);
              }
              currentText = '';
              textEmission.mode = 'undecided';
            }
          }
          break;
        }
        case 'message_delta': {
          const msgUsage = chunk.payload['usage'] as Record<string, number> | undefined;
          if (msgUsage) {
            usage.outputTokens = msgUsage['output_tokens'] ?? usage.outputTokens;
          }
          const delta = chunk.payload['delta'] as Record<string, unknown> | undefined;
          if (delta?.['stop_reason']) {
            stopReason = delta['stop_reason'] as string;
          }
          break;
        }
        case 'message_start': {
          const msg = chunk.payload['message'] as Record<string, unknown> | undefined;
          const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
          if (msgUsage) {
            usage.inputTokens = msgUsage['input_tokens'] ?? 0;
            usage.outputTokens = msgUsage['output_tokens'] ?? 0;
          }
          break;
        }
        case 'error': {
          const errMsg = (chunk.payload['message'] as string) || 'API error';
          const status = chunk.payload['status'] as number | undefined;
          // Prefix with HTTP status so classifyAgentError() can match on it
          // (the inner JSON .message field often strips the status code, e.g.
          // "Service temporarily unavailable" doesn't contain "503").
          throw new Error(status ? `HTTP ${status}: ${errMsg}` : errMsg);
        }
      }
    }

    // Flush any remaining text (stream ended without content_block_stop)
    for (const seg of textStripper.flush()) {
      if (seg.type === 'text') {
        appendText(seg.text);
      } else if (seg.text) {
        onStreamDelta?.({ type: 'thinking', text: seg.text });
      }
    }
    if (currentText) {
      if (textEmission.mode === 'hold' && isRoleplayedJsonToolCallText(currentText)) {
        if (this.debug) {
          console.error(
            `[franklin] Model ${request.model} emitted a raw JSON function-call object as text. ` +
            'Treating it as non-productive output so recovery can try another model.',
          );
        }
      } else if (textEmission.mode === 'hold' && isNemotronProse) {
        const { thinking, answer } = stripNemotronProse(currentText);
        if (thinking) onStreamDelta?.({ type: 'thinking', text: thinking });
        onStreamDelta?.({ type: 'text', text: answer });
        collected.push({ type: 'text', text: answer });
      } else {
        if (textEmission.mode !== 'stream') {
          onStreamDelta?.({ type: 'text', text: currentText });
        }
        collected.push({ type: 'text', text: currentText });
      }
    }

    // Fallback: some non-Anthropic providers behind the gateway (e.g. zai/glm-5.1)
    // emit `message_start` with `output_tokens: 1` as a placeholder and never
    // send a final `message_delta` carrying the real count. The audit log
    // then records `outputTokens: 1` for every call in the session even
    // though the model produced rich tool_use/text content. Verified
    // 2026-05-05 in a real session: 50 audit rows, 17 distinct multi-line
    // bash commands, total `output_tokens` summed to 1,154 — most rows
    // showed 1. We estimate from the collected payload byte length when
    // the reported count is implausibly low for the actual content.
    if (usage.outputTokens <= 1 && collected.length > 0) {
      let bytes = 0;
      for (const part of collected) {
        if (part.type === 'text') {
          bytes += (part as { text?: string }).text?.length ?? 0;
        } else if (part.type === 'tool_use') {
          const tu = part as { name?: string; input?: unknown };
          bytes += (tu.name?.length ?? 0) + JSON.stringify(tu.input ?? {}).length;
        } else if (part.type === 'thinking') {
          bytes += (part as { thinking?: string }).thinking?.length ?? 0;
        }
      }
      // ~4 chars/token is a rough but standard tokenizer-agnostic rule.
      // Only override when the estimate is noticeably larger — otherwise
      // trust the wire value (a genuinely tiny response should stay tiny).
      const estimated = Math.ceil(bytes / 4);
      if (estimated > usage.outputTokens + 5) usage.outputTokens = estimated;
    }

    return { content: collected, usage, stopReason };
  }

  // ─── Payment ───────────────────────────────────────────────────────────

  private async signPayment(
    response: Response,
    model: string,
  ): Promise<Record<string, string> | null> {
    try {
      if (this.chain === 'solana') {
        return await this.signSolanaPayment(response, model);
      }
      return await this.signBasePayment(response, model);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('insufficient') || msg.includes('balance')) {
        console.error(`[franklin] Insufficient USDC balance. Open http://localhost:3100/#wallet to deposit (or run 'franklin balance').`);
      } else if (this.debug) {
        console.error('[franklin] Payment error:', msg);
      } else {
        console.error(`[franklin] Payment failed: ${msg.slice(0, 100)}`);
      }
      return null;
    }
  }

  private async signBasePayment(
    response: Response,
    model: string,
  ): Promise<Record<string, string>> {
    // Refresh wallet cache after TTL to pick up balance/key changes
    if (!this.cachedBaseWallet || (Date.now() - this.walletCacheTime > ModelClient.WALLET_CACHE_TTL)) {
      const w = getOrCreateWallet();
      this.walletCacheTime = Date.now();
      this.cachedBaseWallet = { privateKey: w.privateKey, address: w.address };
    }
    const wallet = this.cachedBaseWallet;
    this.walletAddress = wallet.address;

    // Extract payment requirements from 402 response
    const paymentHeader = await this.extractPaymentReq(response);
    if (!paymentHeader) throw new Error('No payment requirements in 402 response');

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    this.lastPaidUsd = paymentAmountToUsd(details.amount);
    // Mirror the SDK's appendCostLog write so cost_log.jsonl becomes a
    // true wallet-truth ledger covering both SDK helper traffic AND the
    // agent's main LLM stream (which uses this signer, not the SDK).
    // Match SDK schema (model/wallet/network/client_kind) so every row
    // is independently queryable.
    appendSettlementRow('/v1/messages', this.lastPaidUsd, {
      model,
      wallet: wallet.address,
      network: details.network || 'base-mainnet',
      client_kind: 'AgentClient',
    });

    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || this.apiUrl,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );

    return { 'PAYMENT-SIGNATURE': payload };
  }

  private async signSolanaPayment(
    response: Response,
    model: string,
  ): Promise<Record<string, string>> {
    if (!this.cachedSolanaWallet || (Date.now() - this.walletCacheTime > ModelClient.WALLET_CACHE_TTL)) {
      const w = await getOrCreateSolanaWallet();
      this.walletCacheTime = Date.now();
      this.cachedSolanaWallet = { privateKey: w.privateKey, address: w.address };
    }
    const wallet = this.cachedSolanaWallet;
    this.walletAddress = wallet.address;

    const paymentHeader = await this.extractPaymentReq(response);
    if (!paymentHeader) throw new Error('No payment requirements in 402 response');

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
    this.lastPaidUsd = paymentAmountToUsd(details.amount);
    appendSettlementRow('/v1/messages', this.lastPaidUsd, {
      model,
      wallet: wallet.address,
      network: details.network || 'solana-mainnet',
      client_kind: 'AgentClient',
    });

    const secretBytes = await solanaKeyToBytes(wallet.privateKey);
    const feePayer = details.extra?.feePayer || details.recipient;

    const payload = await createSolanaPaymentPayload(
      secretBytes,
      wallet.address,
      details.recipient,
      details.amount,
      feePayer as string,
      {
        resourceUrl: details.resource?.url || this.apiUrl,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );

    return { 'PAYMENT-SIGNATURE': payload };
  }

  private async extractPaymentReq(response: Response): Promise<string | null> {
    let header = response.headers.get('payment-required');
    if (!header) {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (body.x402 || body.accepts) {
          header = btoa(JSON.stringify(body));
        }
      } catch { /* ignore parse errors */ }
    }
    return header;
  }

  // ─── SSE Parsing ───────────────────────────────────────────────────────

  private async *parseSSEStream(
    response: Response,
    controller: AbortController,
    timeoutMs: number,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const reader = response.body?.getReader();
    if (!reader) {
      yield { kind: 'error', payload: { message: 'No response body' } };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Persist across read() calls — event: and data: may arrive in separate chunks
    let currentEvent = '';

    const MAX_BUFFER = 1_000_000; // 1MB buffer cap
    try {
      while (true) {
        if (controller.signal.aborted) break;

        const { done, value } = await withAbortableTimeout(
          () => reader.read(),
          controller,
          createModelTimeoutError('stream', model, timeoutMs),
          timeoutMs,
        );
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Safety: if buffer grows too large without newlines, something is wrong
        if (buffer.length > MAX_BUFFER) {
          if (this.debug) {
            console.error(`[franklin] SSE buffer overflow (${(buffer.length / 1024).toFixed(0)}KB) — truncating to prevent OOM`);
          }
          buffer = buffer.slice(-MAX_BUFFER / 2);
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') {
            // Blank line = end of SSE event (reset for next event)
            currentEvent = '';
            continue;
          }
          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data);
              const mappedKind = this.mapEventType(currentEvent, parsed);
              if (mappedKind) {
                yield { kind: mappedKind, payload: parsed };
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private mapEventType(
    event: string,
    _payload: Record<string, unknown>
  ): StreamChunk['kind'] | null {
    switch (event) {
      case 'message_start': return 'message_start';
      case 'message_delta': return 'message_delta';
      case 'message_stop': return 'message_stop';
      case 'content_block_start': return 'content_block_start';
      case 'content_block_delta': return 'content_block_delta';
      case 'content_block_stop': return 'content_block_stop';
      case 'ping': return 'ping';
      case 'error': return 'error';
      default: return null;
    }
  }
}
