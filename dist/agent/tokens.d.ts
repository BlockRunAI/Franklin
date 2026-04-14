/**
 * Token estimation for Franklin.
 * Uses byte-based heuristic (no external tokenizer dependency).
 * Anchors to actual API counts when available, estimates on top for new messages.
 */
import type { Dialogue } from './types.js';
/**
 * Update with actual token counts from API response.
 * This anchors our estimates to reality.
 */
export declare function updateActualTokens(inputTokens: number, outputTokens: number, messageCount: number): void;
/**
 * Get token count using API anchor + estimation for new messages.
 * More accurate than pure estimation because it's grounded in actual API counts.
 */
export declare function getAnchoredTokenCount(history: Dialogue[]): {
    estimated: number;
    apiAnchored: boolean;
    contextUsagePct: number;
};
/**
 * Reset anchor (e.g., after compaction).
 */
export declare function resetTokenAnchor(): void;
/**
 * Set the current model for token estimation context.
 * Called when the model is resolved in the agent loop.
 */
export declare function setEstimationModel(model: string): void;
/**
 * Estimate token count for a string using byte-length heuristic.
 * JSON-heavy content uses 2 bytes/token; general text uses model-specific ratio.
 *
 * Padding reduced from 1.33x to 1.15x to prevent premature compaction.
 * The old 1.33x + ceil() combo caused ~36% overestimation, triggering
 * auto-compact when context was still 15-20% below the actual limit.
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
