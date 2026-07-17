/**
 * Goal engine — cross-turn autonomous objectives.
 *
 * A goal freezes an objective into a plan (outcomes, not implementation),
 * steers the main model with per-turn directives, and gates every
 * completion claim behind an adversarial verifier panel that defaults to
 * refuting. The architecture is deliberately defensive: plausible-but-
 * incomplete work must not survive verification, and verification must not
 * ratchet (re-reviews may not raise fresh demands — see the verifier
 * prompt), or goals become unfinishable.
 */

export type GoalKind = 'trading' | 'research' | 'general';

export type GoalStatus =
  | 'active'      // implementer is working (or will continue next turn)
  | 'verifying'   // a completion claim is under panel review
  | 'paused'      // user interrupted — /goal resume to continue
  | 'blocked'     // needs a user decision (contradiction/unverifiable/budget)
  | 'completed'
  | 'abandoned';

export interface GoalBudget {
  /** Ceiling captured from --max-spend at creation (undefined = uncapped). */
  maxUsd?: number;
  /** Cumulative USD spent on this goal across sessions. */
  spentUsd: number;
}

export interface GoalRoundRecord {
  round: number;
  refuted: boolean;
  gaps: string[];
  at: number;
}

export interface GoalState {
  id: string;
  objective: string;
  kind: GoalKind;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  /** Verification rounds run so far. */
  rounds: GoalRoundRecord[];
  /** Latest verifier gaps, inlined into the next continuation directive. */
  verifierGaps: string[];
  /** One structural recommendation from the strategist, if it ran. */
  strategistNote?: string;
  /** Implementer turns consumed (continuation bound). */
  turnsUsed: number;
  budget: GoalBudget;
  blockedReason?: string;
  /** Closing user-facing summary, once completed. */
  summary?: string;
}

export interface VerifierVerdict {
  refuted: boolean;
  /** Concrete, actionable gaps (empty when not refuted). */
  findings: string[];
  confidence: 'low' | 'medium' | 'high';
  /**
   * none          — implementer-fixable, iterate
   * contradiction — the objective precludes itself; user must decide
   * unverifiable  — the needed evidence cannot exist here; user must decide
   */
  blocking: 'none' | 'contradiction' | 'unverifiable';
}

export const GOAL_MAX_ROUNDS_DEFAULT = 5;
export const GOAL_MAX_TURNS_DEFAULT = 25;
export const GOAL_VERIFIERS_DEFAULT = 3;

export function goalMaxRounds(): number {
  const n = Number(process.env.FRANKLIN_GOAL_MAX_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : GOAL_MAX_ROUNDS_DEFAULT;
}

export function goalMaxTurns(): number {
  const n = Number(process.env.FRANKLIN_GOAL_MAX_TURNS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : GOAL_MAX_TURNS_DEFAULT;
}

export function goalVerifierCount(): number {
  const n = Number(process.env.FRANKLIN_GOAL_VERIFIERS);
  return Number.isFinite(n) && n >= 1 ? Math.min(5, Math.floor(n)) : GOAL_VERIFIERS_DEFAULT;
}
