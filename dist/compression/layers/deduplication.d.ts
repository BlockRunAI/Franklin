/**
 * Layer 1: Message Deduplication
 *
 * Removes exact duplicate messages from conversation history.
 * Common in heartbeat patterns and repeated tool calls.
 *
 * Safe for LLM: Identical messages add no new information.
 * Expected savings: 2-5%
 */
import { NormalizedMessage } from "../types.js";
export interface DeduplicationResult {
    messages: NormalizedMessage[];
    duplicatesRemoved: number;
    originalCount: number;
}
/**
 * Remove exact duplicate messages from the conversation.
 *
 * Strategy:
 * - Keep first occurrence of each unique message
 * - Preserve order for semantic coherence
 * - Never dedupe system messages (they set context)
 * - Allow duplicate user messages (user might repeat intentionally)
 * - CRITICAL: Never dedupe assistant messages with tool_calls that are
 *   referenced by subsequent tool messages (breaks Anthropic tool_use/tool_result pairing)
 */
export declare function deduplicateMessages(messages: NormalizedMessage[]): DeduplicationResult;
