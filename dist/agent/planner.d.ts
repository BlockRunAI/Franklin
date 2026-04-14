/**
 * Planner-Executor for Franklin
 *
 * Uses expensive models (Opus/Sonnet) for planning, then cheap/free models
 * for execution. Saves 40-70% on complex tasks while maintaining quality.
 *
 * Flow: detect complexity → plan with strong model → execute with cheap model
 *       → escalate back to strong model if executor gets stuck
 */
import type { Tier, RoutingProfile } from '../router/index.js';
/**
 * Should this task use plan-then-execute?
 * Returns true only for complex, multi-step tasks where the savings justify
 * the overhead of an extra planning call.
 */
export declare function shouldPlan(tier: Tier | undefined, profile: RoutingProfile | undefined, userText: string, ultrathink: boolean, planDisabled: boolean): boolean;
/**
 * Returns the planning system prompt section.
 * Injected alongside the normal system prompt during the planning call.
 */
export declare function getPlanningPrompt(): string;
/**
 * Pick the cheap executor model for a given routing profile.
 * These models are good at following structured instructions (the plan)
 * but much cheaper than the planning model.
 */
export declare function getExecutorModel(profile: RoutingProfile): string;
/**
 * Extract numbered steps from plan text.
 * Handles formats like "1. Do X", "1) Do X", "Step 1: Do X".
 */
export declare function parsePlanSteps(text: string): string[];
/**
 * Detect if the executor model is stuck.
 * Triggers when the model hits repeated errors or repeats the same tool call.
 */
export declare function isExecutorStuck(consecutiveErrors: number, sameToolRepeat: boolean): boolean;
/**
 * Build a signature for a tool call (name + first 100 chars of input JSON).
 * Used to detect when the executor repeats the exact same call.
 */
export declare function toolCallSignature(name: string, input: unknown): string;
