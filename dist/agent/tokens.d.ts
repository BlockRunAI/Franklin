/**
 * Token estimation for 0xcode.
 * Uses byte-based heuristic (no external tokenizer dependency).
 */
import type { Dialogue } from './types.js';
/**
 * Estimate token count for a string using byte-length heuristic.
 * JSON-heavy content uses 2 bytes/token; general text uses 4.
 */
export declare function estimateTokens(text: string, bytesPerToken?: number): number;
/**
 * Estimate total tokens for a message.
 */
export declare function estimateDialogueTokens(msg: Dialogue): number;
/**
 * Estimate total tokens for the entire conversation history.
 */
export declare function estimateHistoryTokens(history: Dialogue[]): number;
/**
 * Get the context window size for a model, with a conservative default.
 */
export declare function getContextWindow(model: string): number;
/**
 * Reserved tokens for the compaction summary output.
 */
export declare const COMPACTION_SUMMARY_RESERVE = 16000;
/**
 * Buffer before hitting the context limit to trigger auto-compact.
 */
export declare const COMPACTION_TRIGGER_BUFFER = 12000;
/**
 * Calculate the threshold at which auto-compaction should trigger.
 */
export declare function getCompactionThreshold(model: string): number;
