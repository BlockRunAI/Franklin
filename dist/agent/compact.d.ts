/**
 * Context compaction for 0xcode.
 * When conversation history approaches the context window limit,
 * summarize older messages and replace them with the summary.
 */
import { ModelClient } from './llm.js';
import type { Dialogue } from './types.js';
/**
 * Check if compaction is needed and perform it if so.
 * Returns the (possibly compacted) history.
 */
export declare function autoCompactIfNeeded(history: Dialogue[], model: string, client: ModelClient, debug?: boolean): Promise<{
    history: Dialogue[];
    compacted: boolean;
}>;
/**
 * Clear old tool results in-place to save tokens (microcompaction).
 * Replaces tool result content with a short summary for all but the last N results.
 */
export declare function microCompact(history: Dialogue[], keepLastN?: number): Dialogue[];
