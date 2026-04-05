/**
 * Token optimization strategies for runcode.
 *
 * Five layers of optimization to minimize token usage:
 * 1. Tool result size budgeting — cap large outputs, keep preview
 * 2. Thinking block stripping — remove old thinking from history
 * 3. Time-based cleanup — clear stale tool results after idle gap
 * 4. Adaptive max_tokens — start low (8K), escalate on hit
 * 5. Pre-compact stripping — remove images/docs before summarization
 */

import type { Dialogue, ContentPart, UserContentPart } from './types.js';
import { estimateTokens } from './tokens.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Max chars per individual tool result before truncation (history-level safety net) */
const MAX_TOOL_RESULT_CHARS = 32_000;

/** Max aggregate tool result chars per user message */
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 100_000;

/** Preview size when truncating */
const PREVIEW_CHARS = 2_000;

/** Default max_tokens (low to save output slot reservation) */
export const CAPPED_MAX_TOKENS = 16_384;

/** Escalated max_tokens after hitting the cap */
export const ESCALATED_MAX_TOKENS = 65_536;

/** Per-model max output tokens — prevents requesting more than the model supports */
const MODEL_MAX_OUTPUT: Record<string, number> = {
  'anthropic/claude-opus-4.6': 32_000,
  'anthropic/claude-sonnet-4.6': 64_000,
  'anthropic/claude-haiku-4.5-20251001': 16_384,
  'openai/gpt-5.4': 32_768,
  'openai/gpt-5-mini': 16_384,
  'google/gemini-2.5-pro': 65_536,
  'google/gemini-2.5-flash': 65_536,
  'deepseek/deepseek-chat': 8_192,
};

/** Get max output tokens for a model */
export function getMaxOutputTokens(model: string): number {
  return MODEL_MAX_OUTPUT[model] ?? 16_384;
}

/** Idle gap (minutes) after which old tool results are cleared */
const IDLE_GAP_THRESHOLD_MINUTES = 60;

/** Number of recent tool results to keep during time-based cleanup */
const KEEP_RECENT_TOOL_RESULTS = 5;

// ─── 1. Tool Result Size Budgeting ─────────────────────────────────────────

/**
 * Cap tool result sizes to prevent context bloat.
 * Large results (>50K chars) are truncated with a preview.
 * Per-message aggregate is also capped at 200K chars.
 */
export function budgetToolResults(history: Dialogue[]): Dialogue[] {
  const result: Dialogue[] = [];

  for (const msg of history) {
    if (msg.role !== 'user' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    let messageTotal = 0;
    let modified = false;
    const budgeted: UserContentPart[] = [];

    for (const part of msg.content as UserContentPart[]) {
      if (part.type !== 'tool_result') {
        budgeted.push(part);
        continue;
      }

      const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      const size = content.length;

      // Per-tool cap
      if (size > MAX_TOOL_RESULT_CHARS) {
        modified = true;
        // Truncate at line boundary for cleaner output
        let preview = content.slice(0, PREVIEW_CHARS);
        const lastNewline = preview.lastIndexOf('\n');
        if (lastNewline > PREVIEW_CHARS * 0.5) {
          preview = preview.slice(0, lastNewline);
        }
        budgeted.push({
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: `[Output truncated: ${size.toLocaleString()} chars → ${PREVIEW_CHARS} preview]\n\n${preview}\n\n... (${size - PREVIEW_CHARS} chars omitted)`,
          is_error: part.is_error,
        });
        messageTotal += PREVIEW_CHARS + 200;
        continue;
      }

      // Per-message aggregate cap — once exceeded, truncate remaining results
      if (messageTotal + size > MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) {
        modified = true;
        budgeted.push({
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: `[Output omitted: message budget exceeded (${MAX_TOOL_RESULTS_PER_MESSAGE_CHARS / 1000}K chars/msg)]`,
          is_error: part.is_error,
        });
        messageTotal = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS;
        continue;
      }

      budgeted.push(part);
      messageTotal += size;
    }

    result.push(modified ? { role: 'user', content: budgeted } : msg);
  }

  return result;
}

// ─── 2. Thinking Block Stripping ───────────────────────────────────────────

/**
 * Remove thinking blocks from older assistant messages.
 * Keeps thinking only in the most recent N assistant messages (default: last 2 turns).
 * Older thinking blocks are large and not needed after the decision is made.
 */
const KEEP_THINKING_TURNS = 2;

export function stripOldThinking(history: Dialogue[]): Dialogue[] {
  // Find the last N assistant message indices to preserve their thinking
  const assistantIndices: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      assistantIndices.push(i);
      if (assistantIndices.length >= KEEP_THINKING_TURNS) break;
    }
  }

  if (assistantIndices.length === 0) return history;
  const keepSet = new Set(assistantIndices);

  const result: Dialogue[] = [];
  let modified = false;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    // Strip thinking from assistant messages NOT in the keep set
    if (msg.role === 'assistant' && !keepSet.has(i) && Array.isArray(msg.content)) {
      const filtered = (msg.content as ContentPart[]).filter(
        (part) => part.type !== 'thinking'
      );

      if (filtered.length < (msg.content as ContentPart[]).length) {
        modified = true;
        result.push({
          role: 'assistant',
          content: filtered.length > 0 ? filtered : [{ type: 'text', text: '[thinking omitted]' }],
        });
        continue;
      }
    }

    result.push(msg);
  }

  return modified ? result : history;
}

// ─── 3. Time-Based Cleanup ─────────────────────────────────────────────────

/**
 * After an idle gap (>60 min), clear old tool results.
 * When the user comes back after being away, old results are stale anyway.
 */
export function timeBasedCleanup(
  history: Dialogue[],
  lastActivityTimestamp?: number
): { history: Dialogue[]; cleaned: boolean } {
  if (!lastActivityTimestamp) {
    return { history, cleaned: false };
  }

  const gapMs = Date.now() - lastActivityTimestamp;
  if (gapMs < 0) return { history, cleaned: false }; // Clock skew protection
  const gapMinutes = gapMs / 60_000;
  if (gapMinutes < IDLE_GAP_THRESHOLD_MINUTES) {
    return { history, cleaned: false };
  }

  // Find all tool_result positions
  const toolPositions: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      typeof msg.content[0] !== 'string' &&
      'type' in msg.content[0] &&
      (msg.content[0] as UserContentPart).type === 'tool_result'
    ) {
      toolPositions.push(i);
    }
  }

  if (toolPositions.length <= KEEP_RECENT_TOOL_RESULTS) {
    return { history, cleaned: false };
  }

  // Clear all but the most recent N
  const toClear = toolPositions.slice(0, -KEEP_RECENT_TOOL_RESULTS);
  const result = [...history];

  for (const pos of toClear) {
    const msg = result[pos];
    if (!Array.isArray(msg.content)) continue;

    const cleared = (msg.content as UserContentPart[]).map((part): UserContentPart => {
      if (part.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: '[Stale tool result cleared after idle gap]',
          is_error: part.is_error,
        };
      }
      return part;
    });

    result[pos] = { role: 'user', content: cleared };
  }

  return { history: result, cleaned: true };
}

// ─── 4. Pre-Compact Stripping ──────────────────────────────────────────────

/**
 * Strip heavy content before sending to compaction model.
 * Removes image/document references since the summarizer can't see them anyway.
 */
export function stripHeavyContent(history: Dialogue[]): Dialogue[] {
  return history.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;

    let modified = false;
    const stripped = msg.content.map((part) => {
      // Strip image blocks (if they ever appear)
      if ('type' in part && (part.type as string) === 'image') {
        modified = true;
        return { type: 'text' as const, text: '[image]' };
      }
      // Strip document blocks
      if ('type' in part && (part.type as string) === 'document') {
        modified = true;
        return { type: 'text' as const, text: '[document]' };
      }
      return part;
    });

    return modified ? { ...msg, content: stripped } : msg;
  }) as Dialogue[];
}

// ─── 5. Full Optimization Pipeline ─────────────────────────────────────────

export interface OptimizeOptions {
  debug?: boolean;
  lastActivityTimestamp?: number;
}

/**
 * Run the full optimization pipeline on conversation history.
 * Called before each model request to minimize token usage.
 *
 * Pipeline order (cheapest first):
 * 1. Strip old thinking blocks (free, local)
 * 2. Budget tool results (free, local)
 * 3. Time-based cleanup (free, local, only after idle)
 *
 * Returns the optimized history (may be same reference if no changes).
 */
export function optimizeHistory(
  history: Dialogue[],
  opts?: OptimizeOptions
): Dialogue[] {
  let result = history;
  let changed = false;

  // 1. Strip old thinking
  const stripped = stripOldThinking(result);
  if (stripped !== result) {
    result = stripped;
    changed = true;
    if (opts?.debug) console.error('[runcode] Stripped old thinking blocks');
  }

  // 2. Budget tool results
  const budgeted = budgetToolResults(result);
  if (budgeted !== result) {
    result = budgeted;
    changed = true;
    if (opts?.debug) console.error('[runcode] Budgeted oversized tool results');
  }

  // 3. Time-based cleanup
  const { history: cleaned, cleaned: didClean } = timeBasedCleanup(
    result,
    opts?.lastActivityTimestamp
  );
  if (didClean) {
    result = cleaned;
    changed = true;
    if (opts?.debug) console.error('[runcode] Cleared stale tool results after idle gap');
  }

  return result;
}
