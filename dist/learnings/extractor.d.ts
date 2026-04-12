/**
 * Extract user preferences from a completed session trace.
 * Uses a cheap model to analyze the conversation and produce learnings.
 */
import { ModelClient } from '../agent/llm.js';
import type { Dialogue } from '../agent/types.js';
/**
 * Scan for Claude Code configuration and bootstrap learnings from it.
 * Only runs once — skips if learnings already exist.
 */
export declare function bootstrapFromClaudeConfig(client: ModelClient): Promise<number>;
/**
 * Extract learnings from a completed session.
 * Runs asynchronously — caller should fire-and-forget.
 */
export declare function extractLearnings(history: Dialogue[], sessionId: string, client: ModelClient): Promise<void>;
