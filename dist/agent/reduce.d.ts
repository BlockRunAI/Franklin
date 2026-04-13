/**
 * Token Reduction for runcode.
 * Original implementation — reduces context size through intelligent pruning.
 *
 * Strategy: instead of compression/encoding, we PRUNE redundant content.
 * The model doesn't need verbose tool outputs from 20 turns ago.
 *
 * Three reduction passes:
 * 1. Tool result aging — progressively shorten old tool results
 * 2. Whitespace normalization — remove excessive blank lines and indentation
 * 3. Stale context removal — drop system info that's been superseded
 */
import type { Dialogue } from './types.js';
/**
 * Progressively shorten tool results based on age.
 * Recent results: keep full. Older results: keep summary. Very old: keep one line.
 *
 * This is the biggest token saver — a 10KB bash output from 20 turns ago
 * can be reduced to "✓ Bash: ran npm test (exit 0)" saving ~2500 tokens.
 */
export declare function ageToolResults(history: Dialogue[]): Dialogue[];
/**
 * Normalize whitespace in text messages.
 * - Collapse 3+ blank lines to 2
 * - Remove trailing spaces
 * - Reduce indentation beyond 8 spaces to 8
 */
export declare function normalizeWhitespace(history: Dialogue[]): Dialogue[];
/**
 * Trim very long assistant text messages from old turns.
 * Recent messages: keep full. Old long messages: keep first 1000 chars.
 */
export declare function trimOldAssistantMessages(history: Dialogue[]): Dialogue[];
/**
 * Remove consecutive duplicate messages (same role + same content).
 */
export declare function deduplicateMessages(history: Dialogue[]): Dialogue[];
/**
 * Collapse repeated consecutive lines within tool results.
 * "Fetching...\nFetching...\nFetching...\n" → "Fetching... ×3"
 * Also strips any residual ANSI escape codes from older tool results.
 * RTK-inspired: dedup_lines + strip_ansi pipeline stages.
 */
export declare function deduplicateToolResultLines(history: Dialogue[]): Dialogue[];
/**
 * When the same tool (WebSearch, Grep, etc.) is called 6+ times,
 * collapse all but the last 3 results to one-line summaries.
 * Prevents context snowball from search spam (e.g. 96 WebSearches).
 */
export declare function collapseRepetitiveTools(history: Dialogue[]): Dialogue[];
/**
 * Run all token reduction passes on conversation history.
 * Returns same reference if nothing changed (cheap identity check).
 */
export declare function reduceTokens(history: Dialogue[], debug?: boolean): Dialogue[];
