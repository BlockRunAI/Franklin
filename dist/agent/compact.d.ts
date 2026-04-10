/**
 * Context compaction for runcode.
 * When conversation history approaches the context window limit,
 * summarize older messages and replace them with the summary.
 */
import { ModelClient } from './llm.js';
import type { Dialogue } from './types.js';
export declare const COMPACT_HEADER = "[CONTEXT COMPACTION] Earlier turns in this conversation were compacted to save context space. The summary below describes work that was already completed, and the current session state may still reflect that work (for example, files may already be changed). Use the summary and the current state to continue from where things left off, and avoid repeating work:";
/**
 * Check if compaction is needed and perform it if so.
 * Returns the (possibly compacted) history.
 */
export declare function autoCompactIfNeeded(history: Dialogue[], model: string, client: ModelClient, debug?: boolean): Promise<{
    history: Dialogue[];
    compacted: boolean;
}>;
/**
 * Force compaction regardless of threshold (for /compact command).
 */
export declare function forceCompact(history: Dialogue[], model: string, client: ModelClient, debug?: boolean): Promise<{
    history: Dialogue[];
    compacted: boolean;
}>;
/**
 * Clear old tool results AND truncate old tool_use inputs to save tokens.
 * This is the primary defense against context snowball:
 * - tool_result content (Read output, Bash output, Grep matches) grows fast
 * - tool_use input (Edit replacements, Bash commands) also accumulates
 * Both are cleared for all but the last N tool exchanges.
 */
export declare function microCompact(history: Dialogue[], keepLastN?: number): Dialogue[];
