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

// ─── Agentic keywords that suggest multi-step work ───────────────────────

const AGENTIC_KEYWORDS = /\b(implement|refactor|build|fix|debug|migrate|deploy|create|add|remove|update|restructure|extract|rewrite|optimize|convert|integrate|setup|configure)\b/i;
const MULTI_STEP_PATTERN = /first.*then|step\s+\d|\d+\.\s|and\s+then|after\s+that|next\s*,|finally\b/i;

// ─── Detection ───────────────────────────────────────────────────────────

/**
 * Should this task use plan-then-execute?
 * Returns true only for complex, multi-step tasks where the savings justify
 * the overhead of an extra planning call.
 */
export function shouldPlan(
  tier: Tier | undefined,
  profile: RoutingProfile | undefined,
  userText: string,
  ultrathink: boolean,
  planDisabled: boolean,
): boolean {
  // Per-process opt-out for ablation / scripting ("is plan-then-execute
  // still load-bearing?"). Takes precedence over every other heuristic.
  if (process.env.FRANKLIN_NOPLAN === '1') return false;

  // User disabled planning for this session
  if (planDisabled) return false;

  // Ultrathink already provides deep reasoning
  if (ultrathink) return false;

  // Only auto or premium profiles (eco/free are cost-constrained)
  if (profile !== 'auto' && profile !== 'premium') return false;

  // Explicit multi-step language always plans, regardless of tier / length
  // ("first ... then ...", "step 1 ... step 2 ...", numbered lists, etc.)
  if (MULTI_STEP_PATTERN.test(userText)) return true;

  // Planning is high-ROI on COMPLEX / REASONING tiers for agentic verbs,
  // even when the prompt is short ("refactor the wallet module", "migrate to TS")
  if (tier === 'COMPLEX' || tier === 'REASONING') {
    return AGENTIC_KEYWORDS.test(userText) || userText.length >= 60;
  }

  // On MEDIUM tier: plan only if long AND agentic
  if (tier === 'MEDIUM' && userText.length >= 120 && AGENTIC_KEYWORDS.test(userText)) {
    return true;
  }

  return false;
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
