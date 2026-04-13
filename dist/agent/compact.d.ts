/**
 * Context compaction for runcode.
 * When conversation history approaches the context window limit,
 * summarize older messages and replace them with the summary.
 */
import { ModelClient } from './llm.js';
import type { Dialogue } from './types.js';
export declare const COMPACT_HEADER = "[CONTEXT COMPACTION \u2014 REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window \u2014 treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary.";
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
