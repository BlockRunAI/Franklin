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
  // Gate 1: only COMPLEX or REASONING tiers benefit from planning
  if (tier !== 'COMPLEX' && tier !== 'REASONING') return false;

  // Gate 2: only auto or premium profiles (eco/free already cost-optimized)
  if (profile !== 'auto' && profile !== 'premium') return false;

  // Gate 3: skip short queries — planning overhead not worth it
  if (userText.length < 80) return false;

  // Gate 4: ultrathink already provides deep reasoning
  if (ultrathink) return false;

  // Gate 5: user disabled planning for this session
  if (planDisabled) return false;

  // Gate 6: must have agentic or multi-step signals
  const hasAgenticKeyword = AGENTIC_KEYWORDS.test(userText);
  const hasMultiStep = MULTI_STEP_PATTERN.test(userText);
  return hasAgenticKeyword || hasMultiStep;
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
      return 'moonshot/kimi-k2.5';           // Medium-tier, reliable execution
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
