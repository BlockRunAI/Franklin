/**
 * Token estimation for runcode.
 * Uses byte-based heuristic (no external tokenizer dependency).
 */

import type { Dialogue, ContentPart, UserContentPart } from './types.js';

const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Estimate token count for a string using byte-length heuristic.
 * JSON-heavy content uses 2 bytes/token; general text uses 4.
 */
export function estimateTokens(text: string, bytesPerToken = DEFAULT_BYTES_PER_TOKEN): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / bytesPerToken);
}

/**
 * Estimate tokens for a content part.
 */
function estimateContentPartTokens(part: ContentPart | UserContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'tool_use':
      return estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input), 2);
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
  'anthropic/claude-opus-4.6': 200_000,
  'anthropic/claude-sonnet-4.6': 200_000,
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-haiku-4.5': 200_000,
  'openai/gpt-5.4': 128_000,
  'openai/gpt-5.4-pro': 128_000,
  'openai/gpt-5-mini': 128_000,
  'google/gemini-2.5-pro': 1_000_000,
  'google/gemini-2.5-flash': 1_000_000,
  'deepseek/deepseek-chat': 64_000,
  'deepseek/deepseek-reasoner': 64_000,
};

/**
 * Get the context window size for a model, with a conservative default.
 */
export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 128_000;
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
