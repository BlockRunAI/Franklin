/**
 * Goal runtime — bridges the UpdateGoal capability (constructed at module
 * load, before any session exists) to the session's model client and
 * capability set, and processes completion claims through the verifier
 * panel. The loop installs the dependencies at session start.
 */

import type { ModelClient } from '../agent/llm.js';
import type { CapabilityHandler, CapabilityResult, Dialogue, ExecutionScope } from '../agent/types.js';
import { readRuntimeWallet } from '../agent/context.js';
import {
  experienceEnabled,
  experienceScope,
  markRenderedLessonsRefuted,
  recordConfoundedGoal,
  reflectGoalExperience,
} from '../learnings/experience.js';
import {
  getActiveGoal,
  loadPlan,
  saveVerdicts,
  updateActiveGoal,
} from './store.js';
import {
  needsStrategist,
  runStrategist,
  runSummarizer,
  runVerifierPanel,
  type GoalEngineContext,
} from './engine.js';
import { goalMaxRounds, type GoalState } from './types.js';

export interface GoalEngineDeps {
  client: ModelClient;
  getModel: () => string;
  capabilities: CapabilityHandler[];
  /** The session transcript, read by the goal-outcome reflector as evidence. */
  getHistory?: () => Dialogue[];
}

// The reflector runs after a verified claim without blocking the reply.
// Tests (and shutdown) await it here.
let pendingReflection: Promise<unknown> = Promise.resolve();

export function awaitGoalReflection(): Promise<void> {
  return pendingReflection.then(() => undefined, () => undefined);
}

function scopeFor(goal: { kind: GoalState['kind'] }, scope: ExecutionScope) {
  return experienceScope(scope.workingDir, safeWallet(), goal.kind);
}

function safeWallet() {
  try { return readRuntimeWallet(); } catch { return {}; }
}

let deps: GoalEngineDeps | null = null;

export function setGoalEngineDeps(d: GoalEngineDeps | null): void {
  deps = d;
}

function engineContext(scope: ExecutionScope): GoalEngineContext | null {
  if (!deps) return null;
  return {
    client: deps.client,
    model: deps.getModel(),
    capabilities: deps.capabilities,
    workingDir: scope.workingDir,
    signal: scope.abortSignal,
    onProgress: scope.onProgress,
  };
}

export interface GoalClaimInput {
  completed?: boolean;
  blocked_reason?: string;
  message?: string;
}

export async function processGoalClaim(
  input: GoalClaimInput,
  scope: ExecutionScope
): Promise<CapabilityResult> {
  const goal = getActiveGoal();
  if (!goal) {
    return { output: 'No active goal. Start one with the /goal command.', isError: true };
  }

  if (input.blocked_reason) {
    updateActiveGoal({ status: 'blocked', blockedReason: String(input.blocked_reason) });
    return {
      output:
        `Goal marked blocked: ${input.blocked_reason}. Explain the blocker to the user and ` +
        'what decision you need from them. The goal resumes with /goal resume.',
    };
  }

  if (!input.completed) {
    // Progress note — recorded, no verification.
    return {
      output: `Progress noted${input.message ? `: ${String(input.message).slice(0, 200)}` : ''}. Keep working the plan.`,
    };
  }

  const ctx = engineContext(scope);
  if (!ctx) {
    return { output: 'Goal engine is not initialized in this session.', isError: true };
  }

  const round = goal.rounds.length + 1;
  if (round > goalMaxRounds()) {
    updateActiveGoal({
      status: 'blocked',
      blockedReason: `verification round cap (${goalMaxRounds()}) reached`,
    });
    try { recordConfoundedGoal(goal, scopeFor(goal, scope)); } catch { /* best-effort */ }
    return {
      output:
        `Verification round cap reached (${goalMaxRounds()} rounds). The goal is now blocked — ` +
        'summarize for the user what passed, what kept failing, and ask how they want to proceed.',
      isError: true,
    };
  }

  updateActiveGoal({ status: 'verifying' });
  const planMd = loadPlan(goal.id);
  const outcome = await runVerifierPanel(ctx, goal, planMd, String(input.message ?? ''));
  saveVerdicts(goal.id, round, outcome.verdicts);

  const rounds = [...goal.rounds, { round, refuted: outcome.refuted, gaps: outcome.gaps, at: Date.now() }];

  if (!outcome.refuted) {
    let summary = '';
    try {
      summary = await runSummarizer(ctx, { ...goal, rounds }, planMd);
    } catch { /* summary is best-effort */ }
    updateActiveGoal({ status: 'completed', rounds, verifierGaps: [], summary });
    // Harnessing-level recursion: a refuted→verified contrast is evidence; a
    // round-1 pass is adoption alone and teaches nothing durable.
    if (experienceEnabled() && (rounds.length >= 2 || goal.strategistNote)) {
      const verified: GoalState = { ...goal, rounds, status: 'completed', summary };
      pendingReflection = reflectGoalExperience({
        goal: verified,
        planMd,
        history: deps?.getHistory?.() ?? [],
        scope: scopeFor(goal, scope),
        sessionId: scope.sessionId ?? '',
        client: ctx.client,
      }).catch(() => null);
    }
    return {
      output:
        `GOAL VERIFIED COMPLETE (round ${round}, ${outcome.verdicts.length}-reviewer panel).\n\n` +
        `${summary || 'Deliverable verified against every acceptance criterion.'}\n\n` +
        'Relay this closing summary to the user verbatim, then stop working the goal.',
    };
  }

  if (outcome.blocking !== 'none') {
    updateActiveGoal({
      status: 'blocked',
      rounds,
      verifierGaps: outcome.gaps,
      blockedReason: `verifiers judged the goal ${outcome.blocking}`,
    });
    return {
      output:
        `Completion claim REFUTED as ${outcome.blocking.toUpperCase()} — this is not fixable by more work.\n` +
        `Findings:\n${outcome.gaps.map(g => `- ${g}`).join('\n')}\n\n` +
        'Escalate to the user: explain the contradiction/unverifiable evidence and ask for a decision.',
      isError: true,
    };
  }

  const updated = updateActiveGoal({ status: 'active', rounds, verifierGaps: outcome.gaps });
  if (round === 1) {
    try { markRenderedLessonsRefuted(scopeFor(goal, scope), goal.id); } catch { /* best-effort */ }
  }
  let strategistLine = '';
  if (updated && needsStrategist(updated)) {
    try {
      const note = await runStrategist(ctx, updated, planMd);
      updateActiveGoal({ strategistNote: note });
      strategistLine = `\n\nStrategist intervention (structural — apply this rather than patching symptoms):\n${note}`;
    } catch { /* strategist is best-effort */ }
  }

  return {
    output:
      `Completion claim REFUTED by the verifier panel (round ${round}).\n` +
      `Gaps to close:\n${outcome.gaps.map(g => `- ${g}`).join('\n')}` +
      strategistLine +
      '\n\nAddress every gap, re-run the plan\'s verification yourself, then claim completion again. ' +
      'The panel judges only against the plan\'s acceptance criteria — no new requirements will appear.',
    isError: true,
  };
}
