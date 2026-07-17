/**
 * Deterministic tests for the goal engine (src/goal/): store round-trips,
 * kind detection, verdict parsing, majority-refute aggregation (via a fake
 * model client), strategist triggering, and claim processing. No network.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-goal-test-'));
process.env.HOME = TMP_HOME;

const {
  createGoal, saveGoal, loadGoal, savePlan, loadPlan, saveVerdicts,
  setActiveGoal, getActiveGoal, updateActiveGoal, goalDir,
} = await import('../dist/goal/store.js');
const {
  detectGoalKind, parseVerdict, runVerifierPanel, needsStrategist, mineNextStep,
} = await import('../dist/goal/engine.js');
const { spendBucket } = await import('../dist/goal/prompts.js');
const { processGoalClaim } = await import('../dist/goal/runtime.js');
const { setGoalEngineDeps } = await import('../dist/goal/runtime.js');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const scope = () => ({ workingDir: '/tmp', abortSignal: new AbortController().signal });

/** Fake ModelClient: returns canned text responses in sequence (cycling). */
function fakeClient(responses) {
  let i = 0;
  return {
    complete: async () => {
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        content: [{ type: 'text', text }],
        usage: { inputTokens: 10, outputTokens: 10 },
        stopReason: 'end_turn',
      };
    },
  };
}

// ─── Store ─────────────────────────────────────────────────────────────────

test('store: goal + plan + verdicts round-trip; updateActiveGoal persists', () => {
  const goal = createGoal({ objective: 'test objective', kind: 'research', maxUsd: 5 });
  savePlan(goal.id, '# Goal Plan\n- [ ] first step\n- [ ] second step');
  saveVerdicts(goal.id, 1, [{ refuted: true, findings: ['gap'], confidence: 'high', blocking: 'none' }]);

  const loaded = loadGoal(goal.id);
  assert.equal(loaded.objective, 'test objective');
  assert.equal(loaded.budget.maxUsd, 5);
  assert.match(loadPlan(goal.id), /first step/);
  assert.ok(fs.existsSync(path.join(goalDir(goal.id), 'verdicts', 'round-1.json')));

  setActiveGoal(loaded);
  updateActiveGoal({ turnsUsed: 3 });
  assert.equal(getActiveGoal().turnsUsed, 3);
  assert.equal(loadGoal(goal.id).turnsUsed, 3, 'update persisted to disk');
  setActiveGoal(null);
});

// ─── Kind detection & helpers ──────────────────────────────────────────────

test('detectGoalKind routes trading/research/general', () => {
  assert.equal(detectGoalKind('open a long SOL position with a stop loss'), 'trading');
  assert.equal(detectGoalKind('rebalance my portfolio weekly'), 'trading');
  assert.equal(detectGoalKind('research the top 3 x402 data APIs and compare pricing'), 'research');
  assert.equal(detectGoalKind('organize my notes folder'), 'general');
});

test('mineNextStep finds the first unchecked item; spendBucket is coarse', () => {
  assert.equal(mineNextStep('- [x] done\n- [ ] next thing\n- [ ] later'), 'next thing');
  assert.equal(mineNextStep('- [x] all done'), undefined);
  assert.equal(spendBucket(1, 10), 'under 25% of budget');
  assert.equal(spendBucket(6, 10), '50-75% of budget');
  assert.equal(spendBucket(11, 10), 'BUDGET EXHAUSTED');
  assert.equal(spendBucket(0.1), 'under $0.50');
});

// ─── Verdict parsing ───────────────────────────────────────────────────────

test('parseVerdict: last JSON line wins; junk returns null', () => {
  const v = parseVerdict('I audited the work.\nSome notes.\n{"refuted": true, "findings": ["missing evidence"], "confidence": "high", "blocking": "none"}');
  assert.equal(v.refuted, true);
  assert.deepEqual(v.findings, ['missing evidence']);
  assert.equal(parseVerdict('no json here at all'), null);
  const pass = parseVerdict('{"refuted": false, "findings": [], "confidence": "medium", "blocking": "none"}');
  assert.equal(pass.refuted, false);
  const clamped = parseVerdict('{"refuted": true, "findings": [], "confidence": "bogus", "blocking": "weird"}');
  assert.equal(clamped.confidence, 'medium');
  assert.equal(clamped.blocking, 'none');
});

// ─── Panel aggregation ─────────────────────────────────────────────────────

const REFUTE = '{"refuted": true, "findings": ["gap A"], "confidence": "high", "blocking": "none"}';
const PASS = '{"refuted": false, "findings": [], "confidence": "high", "blocking": "none"}';

function panelCtx(client) {
  return {
    client, model: 'local/test-goal', capabilities: [], workingDir: '/tmp',
    signal: new AbortController().signal,
  };
}

test('panel: strict majority refutes; minority does not', async () => {
  process.env.FRANKLIN_GOAL_VERIFIERS = '3';
  const goal = createGoal({ objective: 'o', kind: 'general' });

  const refuted = await runVerifierPanel(panelCtx(fakeClient([REFUTE, REFUTE, PASS])), goal, 'plan', 'claim');
  assert.equal(refuted.refuted, true);
  assert.deepEqual(refuted.gaps, ['gap A']);

  const passed = await runVerifierPanel(panelCtx(fakeClient([PASS, PASS, REFUTE])), goal, 'plan', 'claim');
  assert.equal(passed.refuted, false);
  assert.deepEqual(passed.gaps, []);
  delete process.env.FRANKLIN_GOAL_VERIFIERS;
});

test('panel: unparseable verdicts default to refuted', async () => {
  process.env.FRANKLIN_GOAL_VERIFIERS = '3';
  const goal = createGoal({ objective: 'o', kind: 'general' });
  const outcome = await runVerifierPanel(panelCtx(fakeClient(['looks great to me!'])), goal, 'plan', 'claim');
  assert.equal(outcome.refuted, true);
  assert.match(outcome.gaps[0], /no parseable verdict/);
  delete process.env.FRANKLIN_GOAL_VERIFIERS;
});

test('panel: blocking classification escalates contradiction', async () => {
  process.env.FRANKLIN_GOAL_VERIFIERS = '3';
  const goal = createGoal({ objective: 'o', kind: 'general' });
  const CONTRA = '{"refuted": true, "findings": ["self-contradictory"], "confidence": "high", "blocking": "contradiction"}';
  const outcome = await runVerifierPanel(panelCtx(fakeClient([CONTRA, REFUTE, REFUTE])), goal, 'plan', 'claim');
  assert.equal(outcome.blocking, 'contradiction');
  delete process.env.FRANKLIN_GOAL_VERIFIERS;
});

// ─── Strategist trigger ────────────────────────────────────────────────────

test('needsStrategist: three disjoint refuted rounds trigger; overlap or note suppress', () => {
  const base = createGoal({ objective: 'o', kind: 'general' });
  const round = (n, gaps, refuted = true) => ({ round: n, refuted, gaps, at: Date.now() });

  assert.equal(needsStrategist({ ...base, rounds: [round(1, ['a']), round(2, ['b']), round(3, ['c'])] }), true);
  assert.equal(needsStrategist({ ...base, rounds: [round(1, ['a']), round(2, ['a']), round(3, ['c'])] }), false, 'overlap = converging');
  assert.equal(needsStrategist({ ...base, rounds: [round(1, ['a']), round(2, ['b'], false), round(3, ['c'])] }), false, 'a pass resets');
  assert.equal(needsStrategist({ ...base, rounds: [round(1, ['a']), round(2, ['b'])] }), false, 'needs three');
  assert.equal(
    needsStrategist({ ...base, strategistNote: 'done', rounds: [round(1, ['a']), round(2, ['b']), round(3, ['c'])] }),
    false, 'one intervention per goal'
  );
});

// ─── Claim processing ──────────────────────────────────────────────────────

test('claim: no active goal errors; blocked_reason blocks; progress notes pass through', async () => {
  setActiveGoal(null);
  const none = await processGoalClaim({ completed: true }, scope());
  assert.ok(none.isError);

  const goal = createGoal({ objective: 'o', kind: 'general' });
  setActiveGoal(goal);

  const note = await processGoalClaim({ message: 'halfway there' }, scope());
  assert.match(note.output, /Progress noted/);
  assert.equal(getActiveGoal().status, 'active');

  const blocked = await processGoalClaim({ blocked_reason: 'need funding decision' }, scope());
  assert.match(blocked.output, /blocked/);
  assert.equal(getActiveGoal().status, 'blocked');
  setActiveGoal(null);
});

test('claim: verified completion sets status and returns the summary', async () => {
  process.env.FRANKLIN_GOAL_VERIFIERS = '3';
  const goal = createGoal({ objective: 'deliver the thing', kind: 'general' });
  savePlan(goal.id, '# Goal Plan\n- [ ] step');
  setActiveGoal(goal);
  // 3 verifier calls all pass, then the summarizer call.
  setGoalEngineDeps({
    client: fakeClient([PASS, PASS, PASS, 'Delivered: the thing. Run it with `thing --go`.']),
    getModel: () => 'local/test-goal',
    capabilities: [],
  });

  const result = await processGoalClaim({ completed: true, message: 'all criteria met' }, scope());
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /GOAL VERIFIED COMPLETE/);
  assert.match(result.output, /thing --go/);
  assert.equal(getActiveGoal().status, 'completed');
  setActiveGoal(null);
  setGoalEngineDeps(null);
  delete process.env.FRANKLIN_GOAL_VERIFIERS;
});

test('claim: refuted completion re-arms the goal with gaps; round cap blocks', async () => {
  process.env.FRANKLIN_GOAL_VERIFIERS = '3';
  process.env.FRANKLIN_GOAL_MAX_ROUNDS = '2';
  const goal = createGoal({ objective: 'o', kind: 'general' });
  savePlan(goal.id, '# Goal Plan\n- [ ] step');
  setActiveGoal(goal);
  setGoalEngineDeps({
    client: fakeClient([REFUTE, REFUTE, REFUTE]),
    getModel: () => 'local/test-goal',
    capabilities: [],
  });

  const r1 = await processGoalClaim({ completed: true }, scope());
  assert.ok(r1.isError);
  assert.match(r1.output, /REFUTED/);
  assert.match(r1.output, /gap A/);
  assert.equal(getActiveGoal().status, 'active', 'refuted claim re-arms the goal');
  assert.deepEqual(getActiveGoal().verifierGaps, ['gap A']);

  const r2 = await processGoalClaim({ completed: true }, scope());
  assert.ok(r2.isError);

  const r3 = await processGoalClaim({ completed: true }, scope());
  assert.match(r3.output, /round cap/i);
  assert.equal(getActiveGoal().status, 'blocked');

  setActiveGoal(null);
  setGoalEngineDeps(null);
  delete process.env.FRANKLIN_GOAL_VERIFIERS;
  delete process.env.FRANKLIN_GOAL_MAX_ROUNDS;
});
