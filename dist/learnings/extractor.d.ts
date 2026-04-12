/**
 * Extract user preferences from a completed session trace.
 * Uses a cheap model to analyze the conversation and produce learnings.
 */
import { ModelClient } from '../agent/llm.js';
import type { Dialogue } from '../agent/types.js';
/**
 * Extract learnings from a completed session.
 * Runs asynchronously — caller should fire-and-forget.
 */
export declare function extractLearnings(history: Dialogue[], sessionId: string, client: ModelClient): Promise<void>;
