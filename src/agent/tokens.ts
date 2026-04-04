/**
 * Token estimation for runcode.
 * Uses byte-based heuristic (no external tokenizer dependency).
 * Anchors to actual API counts when available, estimates on top for new messages.
 */

import type { Dialogue, ContentPart, UserContentPart } from './types.js';

const DEFAULT_BYTES_PER_TOKEN = 4;

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
        contextUsagePct: 0,
      };
    }
    // Too much growth — anchor is unreliable, fall through to estimation
    resetTokenAnchor();
  }

  // No anchor — pure estimation
  return {
    estimated: estimateHistoryTokens(history),
    apiAnchored: false,
    contextUsagePct: 0,
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
 * Estimate token count for a string using byte-length heuristic.
 * JSON-heavy content uses 2 bytes/token; general text uses 4.
 */
export function estimateTokens(text: string, bytesPerToken = DEFAULT_BYTES_PER_TOKEN): number {
  // Pad by 4/3 (~33%) for conservative estimation — better to over-count than under-count
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / bytesPerToken * 1.33);
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
      const content = typeof part.content === 'string'
        ? part.content
        : JSON.stringify(part.content);
      return estimateTokens(content, 2);
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
  // Anthropic
  'anthropic/claude-opus-4.6': 200_000,
  'anthropic/claude-sonnet-4.6': 200_000,
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
  'anthropic/claude-haiku-4.5-20251001': 200_000,
  // OpenAI
  'openai/gpt-5.4': 128_000,
  'openai/gpt-5.4-pro': 128_000,
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
  // DeepSeek
  'deepseek/deepseek-chat': 64_000,
  'deepseek/deepseek-reasoner': 64_000,
  // xAI
  'xai/grok-3': 131_072,
  'xai/grok-4-0709': 131_072,
  'xai/grok-4-1-fast-reasoning': 131_072,
  // Others
  'zai/glm-5': 128_000,
  'moonshot/kimi-k2.5': 128_000,
  'minimax/minimax-m2.7': 128_000,
};

/**
 * Get the context window size for a model, with a conservative default.
 */
export function getContextWindow(model: string): number {
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
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
