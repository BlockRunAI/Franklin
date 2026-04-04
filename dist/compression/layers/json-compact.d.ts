/**
 * Layer 5: JSON Compaction
 *
 * Minifies JSON in tool_call arguments and tool results.
 * Removes pretty-print whitespace from JSON strings.
 *
 * Safe for LLM: JSON semantics unchanged.
 * Expected savings: 2-4%
 */
import { NormalizedMessage } from "../types.js";
export interface JsonCompactResult {
    messages: NormalizedMessage[];
    charsSaved: number;
}
/**
 * Apply JSON compaction to all messages.
 *
 * Targets:
 * - tool_call arguments (in assistant messages)
 * - tool message content (often JSON)
 */
export declare function compactMessagesJson(messages: NormalizedMessage[]): JsonCompactResult;
