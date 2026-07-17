/**
 * Goal-engine prompt templates. All roles except the summarizer write for
 * MACHINE readers (the implementer, the verifier panel, the parser) — keep
 * their outputs structured and terse. The summarizer alone writes for the
 * user.
 */

import type { GoalKind, GoalState } from './types.js';

// ─── Planner ───────────────────────────────────────────────────────────────

const KIND_GUIDANCE: Record<GoalKind, string> = {
  trading: `This is a TRADING goal. The plan MUST include:
- Entry criteria (what conditions justify opening each position)
- Exit criteria (profit target and stop conditions, in plain language)
- Risk limits: an explicit "Budget: $X" line (the maximum total USD at risk)
- A monitoring cadence if the goal spans time (use the Scheduler/Monitor tools)
Remember: every real-money trade will separately require an approved trade plan at execution time — your acceptance criteria should reference outcomes (position opened/closed per criteria, P&L recorded), not raw tool calls.`,
  research: `This is a RESEARCH goal. The plan MUST name the deliverable (a written answer, comparison, or report), the source standards (primary sources over aggregators; cite what was actually read), and completeness criteria (which questions must be answered for the deliverable to count as done).`,
  general: `This is a GENERAL task goal. Anchor acceptance criteria on observable outcomes (an artifact exists, a state changed, a question is answered with evidence) — never on effort spent.`,
};

export function plannerPrompt(objective: string, kind: GoalKind): string {
  return `You are a goal planner. Convert the objective below into a frozen plan that a
separate implementer agent will execute and a skeptical verifier panel will audit.
Downstream readers are machines, some on small models — be structured and unambiguous.

<objective>
${objective}
</objective>

${KIND_GUIDANCE[kind]}

Rules:
- Specify OUTCOMES, not methods. Do not prescribe which tools to call, in what
  order, or how to structure intermediate work — freezing the HOW lets a verifier
  wrongly refute correct work that took a different path.
- Write 3-5 ACCEPTANCE CRITERIA by GROUPING requirements, never one criterion per
  detail and never an exhaustive conjunction. Satisficing beats completionism.
- If the objective references something with an established definition (a named
  protocol, market mechanism, or convention), state the defining facts the
  implementer must honor rather than assuming it knows them.
- Include a VERIFICATION PLAN: how the implementer should demonstrate each
  criterion with evidence a skeptic can audit (commands run, data captured,
  sources cited).
- Include NON-GOALS: what is explicitly out of scope, so the verifier cannot
  invent requirements.

Output EXACTLY this structure (markdown):

# Goal Plan
## Objective
(one sentence restatement)
## Kind
${kind}
## Acceptance criteria
1. ...
## Verification plan
- ...
## Task checklist
- [ ] ...
## Non-goals
- ...

End your response with the plan only — no commentary after it.`;
}

// ─── Continuation directive (injected each turn while a goal is active) ────

export function taskDisciplineBlock(): string {
  return `<task_discipline>
Four failure modes to avoid:
1. Narration without action: past-tense prose describing an action counts for
   nothing unless the actual tool call happened. Call the tool, then narrate.
2. Do not ask permission to continue in-flight work. Only surface questions
   that genuinely require a user decision.
3. The task checklist is your scratchpad, not the deliverable. Flip items to
   [x] as you finish them; record real deviations in a "## Deviations" note.
4. Do not stop with easy work undone — the goal loop re-engages you until
   verification passes anyway, so finishing now is strictly cheaper.
NO EVIDENCE THEATER: verification will audit what you actually did. Captured
outputs, real data, and cited sources count; claims do not.
</task_discipline>`;
}

/** Spend shown as coarse buckets so the directive stays prompt-cache-friendly. */
export function spendBucket(spentUsd: number, maxUsd?: number): string {
  if (!maxUsd || maxUsd <= 0) {
    if (spentUsd < 0.5) return 'under $0.50';
    if (spentUsd < 2) return 'under $2';
    if (spentUsd < 10) return 'under $10';
    return 'over $10';
  }
  const pct = (spentUsd / maxUsd) * 100;
  if (pct < 25) return 'under 25% of budget';
  if (pct < 50) return '25-50% of budget';
  if (pct < 75) return '50-75% of budget';
  if (pct < 100) return '75-100% of budget — wrap up';
  return 'BUDGET EXHAUSTED';
}

export function continuationDirective(goal: GoalState, planMd: string, nextStep?: string): string {
  const gaps = goal.verifierGaps.length
    ? `\nOpen verification gaps (address these FIRST):\n${goal.verifierGaps.map(g => `- ${g}`).join('\n')}`
    : '';
  const strategist = goal.strategistNote
    ? `\nStrategist recommendation (a structural change — apply it rather than patching symptoms):\n${goal.strategistNote}`
    : '';
  const next = nextStep ? `\nNext step: ${nextStep}` : '';
  return `<goal-state>
Active goal (${goal.kind}): ${goal.objective}
Status: ${goal.status} · verification rounds: ${goal.rounds.length} · spend: ${spendBucket(goal.budget.spentUsd, goal.budget.maxUsd)}
${gaps}${strategist}${next}
</goal-state>

<goal-plan>
${planMd}
</goal-plan>

Work the plan's task checklist in order. Run the plan's Verification plan yourself
BEFORE claiming completion. When (and only when) every acceptance criterion is
demonstrably met, call UpdateGoal with completed: true. If genuinely blocked on a
user decision, call UpdateGoal with blocked_reason.

${taskDisciplineBlock()}`;
}

// ─── Verifier (adversarial skeptic) ────────────────────────────────────────

export function verifierPrompt(goal: GoalState, planMd: string, claimMessage: string, lens: string): string {
  return `You are an adversarial verifier. An implementer agent claims the goal below is
complete. Your JOB is to REFUTE the claim. If you are uncertain whether a
criterion is met, the verdict is refuted — a false pass that ships broken work
costs far more than one more iteration.

Your assigned lens: ${lens}.

<goal-plan>
${planMd}
</goal-plan>

<completion-claim>
${claimMessage || '(no message attached to the claim)'}
</completion-claim>

Audit doctrine:
- AUDIT, DON'T AUTHOR: examine the evidence the implementer produced (files,
  captured outputs, cited sources, recorded data) with your read-only tools.
  Minimize tool calls; do not redo the work.
- EVIDENCE HONESTY: hardcoded expected values, self-referential claims, sources
  that were never actually read, or "verified" without captured output prove
  nothing. But controlling an environment boundary (fixed clock, pinned data
  snapshot) to make real behavior observable is honest evidence.
- ANTI-RATCHET: judge ONLY against the plan's acceptance criteria and non-goals.
  Do not raise requirements the plan does not contain — missing edge cases,
  stylistic preferences, and scope beyond the criteria are NOT grounds to refute.
  On re-review rounds the bar must not rise; a fresh nitpick each round is the
  failure mode that makes goals unfinishable.
- Classify a refute: blocking "none" = implementer can fix it; "contradiction" =
  the objective precludes itself; "unverifiable" = the required evidence cannot
  exist in this environment. The latter two escalate to the user, not to retry.

Respond with EXACTLY one JSON object on the final line of your response:
{"refuted": true|false, "findings": ["specific actionable gap", ...], "confidence": "low|medium|high", "blocking": "none|contradiction|unverifiable"}
Findings must be empty when refuted is false.`;
}

export const VERIFIER_LENSES = [
  'criteria coverage — is every acceptance criterion demonstrably met with real evidence',
  'evidence honesty — does the claimed evidence actually support the claims, or is it theater',
  'reproducibility — would the demonstrated outcome hold if checked again right now',
];

// ─── Strategist ────────────────────────────────────────────────────────────

export function strategistPrompt(goal: GoalState, planMd: string): string {
  const gapHistory = goal.rounds
    .map(r => `Round ${r.round}: ${r.refuted ? 'REFUTED' : 'passed'} — ${r.gaps.join('; ') || 'no gaps'}`)
    .join('\n');
  return `You are a strategist. An implementer keeps failing verification on the goal
below, with a DIFFERENT gap surfacing each round (whack-a-mole) — patching
symptoms is not converging. Diagnose the STRUCTURAL root cause and recommend ONE
concrete structural change to HOW the work is being approached.

Hard limits: you may not change the objective or the acceptance criteria (WHAT is
frozen; only HOW may change). Recommend exactly one change, not a list.

<goal-plan>
${planMd}
</goal-plan>

<verification-history>
${gapHistory}
</verification-history>

Respond in at most 120 words:
Diagnosis: (the structural cause)
Restructure: (the one change)
Why this converges: (one sentence)`;
}

// ─── Summarizer ────────────────────────────────────────────────────────────

export function summarizerPrompt(goal: GoalState, planMd: string): string {
  return `A goal just passed verification. Write the single closing message the user will
read. At most 80 words and 4 bullet points total: WHAT was delivered, and HOW to
use or see it (exact command, file, or position to look at). No process
narration, no praise, no caveats already covered by the plan's non-goals.

<goal-plan>
${planMd}
</goal-plan>

Objective: ${goal.objective}`;
}
