/**
 * Goal persistence — ~/.blockrun/goals/<id>/ holding goal.json (atomic),
 * plan.md (frozen by the planner), and verdicts/round-N.json. Plus the
 * process-scoped active-goal slot the loop and /goal command share.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import type { GoalKind, GoalState, VerifierVerdict } from './types.js';

export function goalsDir(): string {
  return path.join(BLOCKRUN_DIR, 'goals');
}

export function goalDir(id: string): string {
  return path.join(goalsDir(), id);
}

export function saveGoal(goal: GoalState): void {
  const dir = goalDir(goal.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.goal.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ ...goal, updatedAt: Date.now() }, null, 2));
  fs.renameSync(tmp, path.join(dir, 'goal.json'));
}

export function loadGoal(id: string): GoalState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(goalDir(id), 'goal.json'), 'utf-8')) as GoalState;
  } catch {
    return null;
  }
}

export function savePlan(id: string, planMd: string): void {
  fs.mkdirSync(goalDir(id), { recursive: true });
  fs.writeFileSync(path.join(goalDir(id), 'plan.md'), planMd);
}

export function loadPlan(id: string): string {
  try {
    return fs.readFileSync(path.join(goalDir(id), 'plan.md'), 'utf-8');
  } catch {
    return '';
  }
}

export function saveVerdicts(id: string, round: number, verdicts: VerifierVerdict[]): void {
  const dir = path.join(goalDir(id), 'verdicts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `round-${round}.json`), JSON.stringify(verdicts, null, 2));
}

export function createGoal(opts: {
  objective: string;
  kind: GoalKind;
  maxUsd?: number;
}): GoalState {
  const goal: GoalState = {
    id: `g_${crypto.randomBytes(5).toString('hex')}`,
    objective: opts.objective,
    kind: opts.kind,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rounds: [],
    verifierGaps: [],
    turnsUsed: 0,
    budget: { maxUsd: opts.maxUsd, spentUsd: 0 },
  };
  saveGoal(goal);
  return goal;
}

// ─── Active-goal slot (process-scoped, one per session) ────────────────────

let activeGoal: GoalState | null = null;

export function setActiveGoal(goal: GoalState | null): void {
  activeGoal = goal;
}

export function getActiveGoal(): GoalState | null {
  return activeGoal;
}

/** Mutate + persist + keep the in-memory slot coherent. */
export function updateActiveGoal(patch: Partial<GoalState>): GoalState | null {
  if (!activeGoal) return null;
  activeGoal = { ...activeGoal, ...patch, updatedAt: Date.now() };
  saveGoal(activeGoal);
  return activeGoal;
}
