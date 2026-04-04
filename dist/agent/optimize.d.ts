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
import type { Dialogue } from './types.js';
/** Default max_tokens (low to save output slot reservation) */
export declare const CAPPED_MAX_TOKENS = 16384;
/** Escalated max_tokens after hitting the cap */
export declare const ESCALATED_MAX_TOKENS = 65536;
/** Get max output tokens for a model */
export declare function getMaxOutputTokens(model: string): number;
/**
 * Cap tool result sizes to prevent context bloat.
 * Large results (>50K chars) are truncated with a preview.
 * Per-message aggregate is also capped at 200K chars.
 */
export declare function budgetToolResults(history: Dialogue[]): Dialogue[];
export declare function stripOldThinking(history: Dialogue[]): Dialogue[];
/**
 * After an idle gap (>60 min), clear old tool results.
 * When the user comes back after being away, old results are stale anyway.
 */
export declare function timeBasedCleanup(history: Dialogue[], lastActivityTimestamp?: number): {
    history: Dialogue[];
    cleaned: boolean;
};
/**
 * Strip heavy content before sending to compaction model.
 * Removes image/document references since the summarizer can't see them anyway.
 */
export declare function stripHeavyContent(history: Dialogue[]): Dialogue[];
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
export declare function optimizeHistory(history: Dialogue[], opts?: OptimizeOptions): Dialogue[];
