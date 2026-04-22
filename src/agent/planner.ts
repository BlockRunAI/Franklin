/**
 * Planner-Executor for Franklin
 *
 * Uses expensive models (Opus/Sonnet) for planning, then cheap/free models
 * for execution. Saves 40-70% on complex tasks while maintaining quality.
 *
 * Flow: detect complexity → plan with strong model → execute with cheap model
 *       → escalate back to strong model if executor gets stuck
 */

import type { RoutingProfile } from '../router/index.js';

// ─── Detection ───────────────────────────────────────────────────────────

/**
 * Should this task use plan-then-execute?
 *
 * Replaces the former AGENTIC_KEYWORDS / MULTI_STEP_PATTERN regex heuristics
 * with a single read of `turnAnalysis.needsPlanning`. The free model judged
 * whether the task is substantive-multi-step from the user's actual phrasing,
 * no keyword allowlist to maintain.
 *
 * Environment gates (opt-in / opt-out / profile / ultrathink / session
 * override) remain — those are operator decisions, not model decisions.
 */
export function shouldPlan(
  profile: RoutingProfile | undefined,
  ultrathink: boolean,
  planDisabled: boolean,
  analyzerSaysNeedsPlanning: boolean,
): boolean {
  // Default: plan-then-execute is OFF (since v3.8.18). The cheap-executor
  // pattern was load-bearing for Sonnet-4.0-era models but Opus 4.7 /
  // Sonnet 4.6 handle multi-step tool use in a single pass. Opt in with
  // FRANKLIN_PLAN=1 for ablation / experiments.
  if (process.env.FRANKLIN_PLAN !== '1') return false;

  // Legacy env opt-out still honored for users who set it previously.
  if (process.env.FRANKLIN_NOPLAN === '1') return false;

  // Per-session / per-turn overrides from the agent surface.
  if (planDisabled) return false;
  if (ultrathink) return false; // ultrathink already provides deep reasoning

  // Only auto / premium profiles — eco / free are cost-constrained.
  if (profile !== 'auto' && profile !== 'premium') return false;

  // Final decision comes from the turn analyzer's boolean flag.
  return analyzerSaysNeedsPlanning;
}

// ─── Planning Prompt ─────────────────────────────────────────────────────

/**
 * Returns the planning system prompt section.
 * Injected alongside the normal system prompt during the planning call.
 */
export function getPlanningPrompt(): string {
  return `# Planning Mode — Active
You are in planning mode. Produce a structured execution plan for the user's request.

Rules:
- Output a numbered list of concrete steps. Each step = one action.
- Include specific file paths, function names, or shell commands when known.
- If you need to explore the codebase first, make it step 1.
- Mark steps that can run in parallel with [PARALLEL].
- Keep the plan to 15 steps max.
- End with a verification step (run tests, check output, etc.).
- Output ONLY the numbered plan. No code blocks, no explanations, no preamble.`;
}

// ─── Executor Model Selection ────────────────────────────────────────────

/**
 * Pick the cheap executor model for a given routing profile.
 * These models are good at following structured instructions (the plan)
 * but much cheaper than the planning model.
 */
export function getExecutorModel(profile: RoutingProfile): string {
  switch (profile) {
    case 'premium':
      return 'moonshot/kimi-k2.6';           // Medium-tier, reliable execution (256K ctx, vision + reasoning)
    case 'auto':
    default:
      return 'google/gemini-2.5-flash';      // Cheap, fast, good at instructions
  }
}

// ─── Plan Parsing ────────────────────────────────────────────────────────

/**
 * Extract numbered steps from plan text.
 * Handles formats like "1. Do X", "1) Do X", "Step 1: Do X".
 */
export function parsePlanSteps(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Match: "1. ...", "1) ...", "Step 1: ...", "- 1. ..."
    if (/^(?:\d+[\.\):]|step\s+\d)/i.test(trimmed)) {
      steps.push(trimmed);
    }
  }
  return steps;
}

// ─── Stuck Detection ─────────────────────────────────────────────────────

/** Max consecutive tool errors before escalation */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Detect if the executor model is stuck.
 * Triggers when the model hits repeated errors or repeats the same tool call.
 */
export function isExecutorStuck(
  consecutiveErrors: number,
  sameToolRepeat: boolean,
): boolean {
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return true;
  if (sameToolRepeat) return true;
  return false;
}

/**
 * Build a signature for a tool call (name + first 100 chars of input JSON).
 * Used to detect when the executor repeats the exact same call.
 */
export function toolCallSignature(name: string, input: unknown): string {
  return `${name}::${JSON.stringify(input).slice(0, 100)}`;
}
