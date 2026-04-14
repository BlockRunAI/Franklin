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
/**
 * Try to extract a reusable skill from the recent work.
 * Called from maybeMidSessionExtract when enough tool calls happened.
 */
export declare function maybeExtractSkill(history: Dialogue[], turnToolCalls: number, sessionId: string, client: ModelClient): Promise<void>;
/**
 * Check if mid-session extraction should run, and if so, run it in background.
 * Called from the agent loop after tool execution completes.
 *
 * Triggers when:
 * 1. Token count exceeds init threshold (first extraction) OR update threshold (subsequent)
 * 2. AND enough tool calls have happened since last extraction
 * 3. AND we haven't hit the per-session cap
 *
 * Inspired by Claude Code's SessionMemory which runs a background subagent
 * to extract conversation notes periodically.
 */
export declare function maybeMidSessionExtract(history: Dialogue[], estimatedTokens: number, totalToolCalls: number, sessionId: string, client: ModelClient): void;
