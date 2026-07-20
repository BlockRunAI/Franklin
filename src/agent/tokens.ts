/**
 * Token estimation for Franklin.
 * Uses byte-based heuristic (no external tokenizer dependency).
 * Anchors to actual API counts when available, estimates on top for new messages.
 */

import type { Dialogue, ContentPart, UserContentPart } from './types.js';
import { peekGatewayModel, warmGatewayModelsCache } from '../gateway-models.js';

const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Model-specific bytes-per-token ratios for more accurate estimation.
 * Anthropic-family models tokenize at ~3.5 bytes/token, GPT-family at ~4,
 * Gemini-family at ~3.
 */
const MODEL_BYTES_PER_TOKEN: Record<string, number> = {
  'anthropic': 3.5,
  'openai': 4,
  'google': 3,
  'deepseek': 3.5,
  'xai': 4,
  'zai': 4,
};

/** Get bytes-per-token ratio for a model. Falls back to DEFAULT_BYTES_PER_TOKEN. */
function getModelBytesPerToken(model?: string): number {
  if (!model) return DEFAULT_BYTES_PER_TOKEN;
  const provider = model.split('/')[0];
  return MODEL_BYTES_PER_TOKEN[provider] ?? DEFAULT_BYTES_PER_TOKEN;
}

// Store current model for token estimation context
let _currentModel: string | undefined;

// ─── API-anchored token tracking ───────────────────────���──────────────────

/** Last known actual token count from API response */
let lastApiInputTokens = 0;
let lastApiOutputTokens = 0;
let lastApiMessageCount = 0;

/**
 * Update with actual token counts from API response.
 * This anchors our estimates to reality.
 */
export function updateActualTokens(inputTokens: number, outputTokens: number, messageCount: number): void {
  lastApiInputTokens = inputTokens;
  lastApiOutputTokens = outputTokens;
  lastApiMessageCount = messageCount;
}

/**
 * Get token count using API anchor + estimation for new messages.
 * More accurate than pure estimation because it's grounded in actual API counts.
 */
export function getAnchoredTokenCount(history: Dialogue[]): {
  estimated: number;
  apiAnchored: boolean;
  contextUsagePct: number;
} {
  // The model that just billed input — used as the denominator below.
  // _currentModel is set per-turn by setEstimationModel(), so it reflects
  // whatever the router actually resolved (not just config.model, which
  // may be a routing profile like blockrun/auto).
  const contextWindow = _currentModel ? getContextWindow(_currentModel) : 200_000;

  if (lastApiInputTokens > 0 && lastApiMessageCount > 0 && history.length >= lastApiMessageCount) {
    // Sanity check: if history was mutated (compaction, micro-compact), anchor may be stale.
    // Detect by checking if new messages were only appended (length grew), not if content changed.
    // If history grew by more than expected (e.g., resume injected many messages), fall through to estimation.
    const growth = history.length - lastApiMessageCount;
    if (growth <= 20) { // Reasonable growth since last API call
      const newMessages = history.slice(lastApiMessageCount);
      let newTokens = 0;
      for (const msg of newMessages) {
        newTokens += estimateDialogueTokens(msg);
      }
      const total = lastApiInputTokens + newTokens;
      return {
        estimated: total,
        apiAnchored: true,
        contextUsagePct: (total / contextWindow) * 100,
      };
    }
    // Too much growth — anchor is unreliable, fall through to estimation
    resetTokenAnchor();
  }

  // No anchor — pure estimation
  const est = estimateHistoryTokens(history);
  return {
    estimated: est,
    apiAnchored: false,
    contextUsagePct: (est / contextWindow) * 100,
  };
}

/**
 * Reset anchor (e.g., after compaction).
 */
export function resetTokenAnchor(): void {
  lastApiInputTokens = 0;
  lastApiOutputTokens = 0;
  lastApiMessageCount = 0;
}

/**
 * Set the current model for token estimation context.
 * Called when the model is resolved in the agent loop.
 */
export function setEstimationModel(model: string): void {
  _currentModel = model;
}

/**
 * Estimate token count for a string using byte-length heuristic.
 * JSON-heavy content uses 2 bytes/token; general text uses model-specific ratio.
 *
 * Padding history:
 *   1.33x → ~36% overestimate, auto-compact fired 15-20% below real limit.
 *   1.15x → still triggered compaction around 60% of real context.
 *   1.05x (current) — combined with Math.ceil() this still leaves a small
 *   safety margin, and the LLM surfaces a hard 413/context error long before
 *   the real limit that recovery code can handle. Net effect: fewer
 *   unnecessary (and expensive) compaction round-trips on mid-sized sessions.
 */
export function estimateTokens(text: string, bytesPerToken?: number): number {
  const effectiveBPT = bytesPerToken ?? getModelBytesPerToken(_currentModel);
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / effectiveBPT * 1.05);
}

/**
 * Estimate tokens for a content part.
 */
function estimateContentPartTokens(part: ContentPart | UserContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'tool_use':
      // +16 tokens for tool_use framing (type, id, name fields, JSON structure)
      return 16 + estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input), 2);
    case 'tool_result': {
      // String content: count as text directly.
      if (typeof part.content === 'string') {
        return estimateTokens(part.content, 2);
      }
      // Array content: sum block-by-block. CRITICAL: image blocks must
      // NOT go through JSON.stringify — their base64 `data` field would
      // be tokenized as text (a 100KB image → ~70k phantom tokens),
      // which is what made the context ring read ~86% on a 2-image chat
      // and triggered premature /compact loops. Anthropic actually
      // bills (w*h)/750 per image, ≈1100-1500 for typical sizes; a flat
      // 1500-token estimate is close enough without needing to decode
      // the image dimensions client-side.
      let total = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blocks = part.content as any[];
      for (const block of blocks) {
        const blockType = block?.type;
        if (blockType === 'text') {
          total += estimateTokens((block?.text as string) ?? '', 2);
        } else if (blockType === 'image') {
          total += 1500;
        } else {
          // Unknown block — stringify minus any nested base64 data field
          // to avoid the same blow-up for future block kinds.
          const sanitized = { ...block };
          if (sanitized?.source && typeof sanitized.source === 'object' && sanitized.source.data) {
            sanitized.source = { ...sanitized.source, data: '<bytes>' };
          }
          total += estimateTokens(JSON.stringify(sanitized), 2);
        }
      }
      return total;
    }
    case 'thinking':
      return estimateTokens(part.thinking);
    default:
      return 0;
  }
}

/**
 * Estimate total tokens for a message.
 */
export function estimateDialogueTokens(msg: Dialogue): number {
  const overhead = 4; // role, structure overhead
  if (typeof msg.content === 'string') {
    return overhead + estimateTokens(msg.content);
  }
  let total = overhead;
  for (const part of msg.content) {
    total += estimateContentPartTokens(part as ContentPart | UserContentPart);
  }
  return total;
}

/**
 * Estimate total tokens for the entire conversation history.
 */
export function estimateHistoryTokens(history: Dialogue[]): number {
  let total = 0;
  for (const msg of history) {
    total += estimateDialogueTokens(msg);
  }
  return total;
}

/**
 * Context window sizes for known models.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic. The BlockRun gateway model entry advertises 1M context for
  // Opus 4.8 / 4.7, but the 1M beta header may not be enabled at the gateway
  // edge yet — sending more than 200k without it 413s. Keep 200k as the
  // safe Franklin baseline; bump to 1_000_000 in a separate commit once
  // a real >200k call has been verified end-to-end.
  // Fable 5 / Sonnet 5 advertise 1M at the gateway; keep the 200k safe baseline
  // (same rationale as Opus above) until a real >200k call is verified.
  'anthropic/claude-fable-5': 200_000,
  'anthropic/claude-opus-4.8': 200_000,
  'anthropic/claude-opus-4.7': 200_000,
  'anthropic/claude-opus-4.6': 200_000,
  'anthropic/claude-opus-4.5': 200_000,
  'anthropic/claude-sonnet-5': 200_000,
  'anthropic/claude-sonnet-4.6': 200_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
  // Retired 2026-07-14 (gateway 400s on it) — kept so replayed sessions that
  // recorded the dated id still resolve a context window.
  'anthropic/claude-haiku-4.5-20251001': 200_000,
  // OpenAI
  // gpt-5.5 advertises 1.05M context at the gateway, but Franklin keeps the
  // conservative 128k baseline matching every other gpt-5.x line — bump in
  // a separate change once a real >128k call has been verified end-to-end.
  'openai/gpt-5.6-sol': 128_000,
  'openai/gpt-5.6-terra': 128_000,
  'openai/gpt-5.6-luna': 128_000,
  'openai/gpt-5.5': 128_000,
  'openai/gpt-5.4': 128_000,
  'openai/gpt-5.4-pro': 128_000,
  'openai/gpt-5.4-mini': 128_000,
  'openai/gpt-5.4-nano': 128_000,
  'openai/gpt-5.3': 128_000,
  'openai/gpt-5.3-codex': 128_000,
  'openai/gpt-5.2': 128_000,
  'openai/gpt-5-mini': 128_000,
  'openai/gpt-5-nano': 128_000,
  'openai/gpt-4.1': 1_000_000,
  'openai/o3': 200_000,
  'openai/o4-mini': 200_000,
  // Google
  'google/gemini-2.5-pro': 1_000_000,
  'google/gemini-2.5-flash': 1_000_000,
  'google/gemini-2.5-flash-lite': 1_000_000,
  'google/gemini-3.1-pro': 1_000_000,
  'google/gemini-3.5-flash': 1_000_000,
  'google/gemini-3.1-flash-lite': 1_000_000,
  // DeepSeek (V4 family — gateway aliased deepseek-chat / -reasoner to V4
  // Flash on 2026-05-03; context bumped 128K → 1M for both, 65K out)
  'deepseek/deepseek-chat': 1_000_000,
  'deepseek/deepseek-reasoner': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
  // xAI
  'xai/grok-3': 131_072,
  'xai/grok-4-0709': 131_072,
  'xai/grok-4-1-fast-reasoning': 131_072,
  // Others
  'zai/glm-5.2': 1_000_000, // flagship bump 2026-06 — context jumped 200K → 1M
  'zai/glm-5.1': 200_000,
  'moonshot/kimi-k3': 1_048_576,
  'moonshot/kimi-k2.7': 256_000,
  'moonshot/kimi-k2.6': 256_000,
  'moonshot/kimi-k2.5': 128_000,
  'minimax/minimax-m3': 1_000_000,
  'minimax/minimax-m2.7': 128_000,
  // NVIDIA-hosted free tier (refreshed 2026-07-11 to match live /v1/models).
  'nvidia/qwen3-next-80b-a3b-instruct': 262_144, // current free default
  'nvidia/qwen3.5-122b-a10b': 131_072,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': 256_000,
  'nvidia/mistral-nemotron': 131_072,
  'nvidia/step-3.7-flash': 131_072,
  'nvidia/seed-oss-36b': 131_072,
  'nvidia/nemotron-nano-9b-v2': 131_072,
  'nvidia/nemotron-nano-12b-v2-vl': 131_072,
  'nvidia/llama-4-maverick': 131_072,
  'nvidia/mistral-large-3-675b': 131_072,
  // Qwen (paid) — Max tier is 1M ctx; the generic `qwen` fallback below is
  // 128k and would compact ~8x too early.
  'qwen/qwen3.7-max': 1_000_000,
};

/**
 * Get the context window size for a model, with a conservative default.
 */
export function getContextWindow(model: string): number {
  // The static table wins. It is not merely a cache of the gateway catalog —
  // several entries are deliberate DOWNGRADES from what the gateway advertises
  // (see the Anthropic block above: the gateway reports 1M, but its 1M beta
  // header is not enabled, so anything over 200k 413s). Letting the catalog
  // override these would reintroduce the exact bug those comments prevent.
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // No static entry — a live catalog value beats the blind default below.
  // This is the qwen3.7-max class: a real model nobody has catalogued yet,
  // which would otherwise silently compact at 128k.
  const live = peekGatewayModel(model)?.context_window;
  if (live && live > 0) return live;
  // Cache is cold. Kick a fetch (deduped in-flight, errors swallowed) so the
  // next call in this session gets a real number instead of the blind default.
  warmGatewayModelsCache();
  // Pattern-based inference for unknown models
  if (model.includes('gemini')) return 1_000_000;
  if (model.includes('claude')) return 200_000;
  if (model.includes('gpt-4.1')) return 1_000_000;
  if (model.includes('nemotron') || model.includes('qwen')) return 128_000;
  return 128_000;
}

/**
 * Reserved tokens for the compaction summary output.
 */
export const COMPACTION_SUMMARY_RESERVE = 16_000;

/**
 * Buffer before hitting the context limit to trigger auto-compact.
 */
export const COMPACTION_TRIGGER_BUFFER = 12_000;

/**
 * Calculate the threshold at which auto-compaction should trigger.
 */
export function getCompactionThreshold(model: string): number {
  const window = getContextWindow(model);
  return window - COMPACTION_SUMMARY_RESERVE - COMPACTION_TRIGGER_BUFFER;
}
