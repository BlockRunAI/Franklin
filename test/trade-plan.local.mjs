/**
 * Deterministic tests for the trade-plan approval flow: plan store, the
 * tool-guard gate (planless denial, coverage, budget drawdown, trust-mode
 * independence), the TradePlan tool's propose/approve semantics, the
 * approval broker, and the headless auto-policy. No network, no wallet.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tradeplan-test-'));
process.env.HOME = TMP_HOME;

const {
  createTradePlan, decideTradePlan, activeTradePlan, listTradePlans,
  checkTradePlanGate, recordTradeExecution, setTradePlanSessionId,
  validatePlannedTrades, formatTradePlanText, tradePlansDir,
} = await import('../dist/trading/trade-plan.js');
const { createTradePlanCapability } = await import('../dist/tools/trade-plan.js');
const { setSchedulerSessionId } = await import('../dist/scheduler/store.js');
const { ApprovalBroker } = await import('../dist/agent/approvals.js');
const { createHeadlessApprovalFn } = await import('../dist/commands/start.js');
const { resetLiveSpend, recordUsage } = await import('../dist/stats/tracker.js');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function clearPlans() {
  fs.rmSync(tradePlansDir(), { recursive: true, force: true });
}

const SESSION = 'tp-test-session';
setTradePlanSessionId(SESSION);
setSchedulerSessionId(SESSION);

const swapInvocation = (over = {}) => ({
  type: 'tool_use', id: 'inv1', name: 'JupiterSwap',
  input: { input_mint: 'USDC', output_mint: 'SOL', amount: 2, ...over },
});

const SOL_TRADE = { venue: 'jupiter', action: 'buy', asset: 'SOL', amountUsd: 2 };

// ─── Validation ────────────────────────────────────────────────────────────

test('validatePlannedTrades rejects malformed trades', () => {
  assert.ok('error' in validatePlannedTrades([]));
  assert.ok('error' in validatePlannedTrades([{ venue: 'nyse', action: 'buy', asset: 'X', amountUsd: 1 }]));
  assert.ok('error' in validatePlannedTrades([{ venue: 'jupiter', action: 'buy', asset: 'X', amountUsd: -5 }]));
  const ok = validatePlannedTrades([SOL_TRADE]);
  assert.ok('trades' in ok);
  assert.equal(ok.trades[0].asset, 'SOL');
});

// ─── Gate ──────────────────────────────────────────────────────────────────

test('gate: planless trade is denied with propose instruction, and audited', () => {
  clearPlans();
  const result = checkTradePlanGate(swapInvocation());
  assert.ok(result?.isError);
  assert.match(result.output, /TradePlan/);
  assert.match(result.output, /propose/);

  const audit = fs.readFileSync(path.join(TMP_HOME, '.blockrun', 'approvals.jsonl'), 'utf-8').trim().split('\n');
  const last = JSON.parse(audit[audit.length - 1]);
  assert.equal(last.kind, 'trade-plan');
  assert.equal(last.reason, 'no approved trade plan');
});

test('gate: non-trade tools and research actions pass without a plan', () => {
  clearPlans();
  assert.equal(checkTradePlanGate({ type: 'tool_use', id: 'i', name: 'Read', input: {} }), null);
  assert.equal(checkTradePlanGate({ type: 'tool_use', id: 'i', name: 'PredictionMarket', input: {} }), null);
  // PolymarketBet research + dry-run previews stay free.
  assert.equal(checkTradePlanGate({ type: 'tool_use', id: 'i', name: 'PolymarketBet', input: { action: 'positions' } }), null);
  assert.equal(checkTradePlanGate({ type: 'tool_use', id: 'i', name: 'PolymarketBet', input: { action: 'buy', amount_usd: 5 } }), null, 'no confirm = dry-run preview');
  // Order placement is gated.
  const gated = checkTradePlanGate({ type: 'tool_use', id: 'i', name: 'PolymarketBet', input: { action: 'buy', amount_usd: 5, confirm: true } });
  assert.ok(gated?.isError);
});

test('gate: approved covering plan passes, flags auto_approve, draws down, then consumes', () => {
  clearPlans();
  const plan = createTradePlan({ sessionId: SESSION, trades: [{ ...SOL_TRADE, amountUsd: 4 }], rationale: 'test' });
  assert.equal(activeTradePlan(SESSION), null, 'pending plan is not active');
  decideTradePlan(plan, 'approved', 'user:test');
  assert.ok(activeTradePlan(SESSION), 'approved plan is active');

  const inv = swapInvocation();
  assert.equal(checkTradePlanGate(inv), null, 'covered trade passes');
  assert.equal(inv.input.auto_approve, true, 'per-swap confirm skipped under an approved plan');

  recordTradeExecution(inv, { output: 'ok' });
  const after1 = activeTradePlan(SESSION);
  assert.ok(after1);
  assert.equal(after1.consumedUsd, 2);

  // Second $2 execution exhausts the $4 budget → plan consumed.
  recordTradeExecution(swapInvocation({ id: 'inv2' }), { output: 'ok' });
  assert.equal(activeTradePlan(SESSION), null, 'consumed plan no longer active');
  const stored = listTradePlans().find(p => p.id === plan.id);
  assert.equal(stored.status, 'consumed');
});

test('gate: failed execution does not draw down the budget', () => {
  clearPlans();
  const plan = createTradePlan({ sessionId: SESSION, trades: [{ ...SOL_TRADE, amountUsd: 4 }], rationale: 'test' });
  decideTradePlan(plan, 'approved', 'user:test');
  recordTradeExecution(swapInvocation(), { output: 'boom', isError: true });
  assert.equal(activeTradePlan(SESSION).consumedUsd, 0);
});

test('gate: budget overflow and asset mismatch deny', () => {
  clearPlans();
  const plan = createTradePlan({ sessionId: SESSION, trades: [{ ...SOL_TRADE, amountUsd: 1 }], rationale: 'test' });
  decideTradePlan(plan, 'approved', 'user:test');

  const over = checkTradePlanGate(swapInvocation({ amount: 5 }));
  assert.ok(over?.isError);
  assert.match(over.output, /budget left/);

  const wrongAsset = checkTradePlanGate(swapInvocation({ output_mint: 'BONK', amount: 0.5 }));
  assert.ok(wrongAsset?.isError, 'plan covers SOL, not BONK');
  assert.match(wrongAsset.output, /does not include/);
});

test('gate: expired plan is not active', () => {
  clearPlans();
  const plan = createTradePlan({ sessionId: SESSION, trades: [SOL_TRADE], rationale: 'test', ttlMs: -1000 });
  decideTradePlan(plan, 'approved', 'user:test');
  assert.equal(activeTradePlan(SESSION), null);
  assert.ok(checkTradePlanGate(swapInvocation())?.isError);
});

// ─── TradePlan tool ────────────────────────────────────────────────────────

const scope = (onApproval) => ({
  workingDir: '/tmp', abortSignal: new AbortController().signal, onApproval,
});

test('tool: propose without an approval surface fails closed', async () => {
  clearPlans();
  const tool = createTradePlanCapability();
  const result = await tool.execute(
    { action: 'propose', trades: [SOL_TRADE], rationale: 'buy the dip' },
    scope(undefined)
  );
  assert.ok(result.isError);
  assert.match(result.output, /REJECTED/);
  assert.match(result.output, /--approve-trades/);
  assert.equal(activeTradePlan(SESSION), null);
});

test('tool: propose → approve activates the plan', async () => {
  clearPlans();
  const tool = createTradePlanCapability();
  let seenRequest;
  const result = await tool.execute(
    { action: 'propose', trades: [SOL_TRADE], rationale: 'momentum entry' },
    scope(async (req) => { seenRequest = req; return { choice: 'approve' }; })
  );
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /APPROVED/);
  assert.equal(seenRequest.kind, 'trade-plan');
  assert.match(seenRequest.description, /TRADE PLAN/);
  assert.match(seenRequest.description, /momentum entry/);
  assert.ok(activeTradePlan(SESSION));
});

test('tool: request changes rejects with feedback for revision', async () => {
  clearPlans();
  const tool = createTradePlanCapability();
  const result = await tool.execute(
    { action: 'propose', trades: [SOL_TRADE], rationale: 'r' },
    scope(async () => ({ choice: 'request changes', message: 'cut size to $1' }))
  );
  assert.ok(result.isError);
  assert.match(result.output, /cut size to \$1/);
  assert.equal(activeTradePlan(SESSION), null);
});

test('tool: deny and status/cancel lifecycle', async () => {
  clearPlans();
  const tool = createTradePlanCapability();
  const denied = await tool.execute(
    { action: 'propose', trades: [SOL_TRADE], rationale: 'r' },
    scope(async () => ({ choice: 'deny' }))
  );
  assert.ok(denied.isError);
  assert.match(denied.output, /DENIED/);

  const status = await tool.execute({ action: 'status' }, scope());
  assert.match(status.output, /No ACTIVE plan/);

  const plan = createTradePlan({ sessionId: SESSION, trades: [SOL_TRADE], rationale: 'r' });
  decideTradePlan(plan, 'approved', 'user:test');
  const cancel = await tool.execute({ action: 'cancel', plan_id: plan.id }, scope());
  assert.match(cancel.output, /cancelled/);
  assert.equal(activeTradePlan(SESSION), null);
});

// ─── ApprovalBroker ────────────────────────────────────────────────────────

test('broker: request parks until respond; pending lists it; unknown id refused', async () => {
  const broker = new ApprovalBroker();
  const promise = broker.request({
    sessionId: 's', kind: 'trade-plan', title: 't', description: 'd', options: ['approve', 'deny'],
  });
  assert.equal(broker.pending().length, 1);
  const requestId = broker.pending()[0].requestId;
  assert.equal(broker.respond('nope', { choice: 'approve' }), false);
  assert.equal(broker.respond(requestId, { choice: 'approve', message: 'go' }), true);
  const decision = await promise;
  assert.deepEqual(decision, { choice: 'approve', message: 'go' });
  assert.equal(broker.pending().length, 0);
});

test('broker: timeout resolves as timeout; cancelAll denies the rest', async () => {
  const broker = new ApprovalBroker();
  // The broker's timeout timer is deliberately unref'd (must not pin the
  // process in production) — hold the test's event loop open ourselves.
  const keepAlive = setInterval(() => {}, 10);
  try {
    const timedOut = broker.request({
      sessionId: 's', kind: 'trade-plan', title: 't', description: 'd', options: ['approve'], timeoutMs: 20,
    });
    assert.equal((await timedOut).choice, 'timeout');
  } finally {
    clearInterval(keepAlive);
  }

  const hanging = broker.request({
    sessionId: 's', kind: 'ask-user', title: 't', description: 'd', options: ['ok'],
  });
  broker.cancelAll('teardown');
  const cancelled = await hanging;
  assert.equal(cancelled.choice, 'deny');
  assert.equal(cancelled.message, 'teardown');
});

// ─── Headless auto-policy ──────────────────────────────────────────────────

test('headless policy: flag and max-spend matrix', async () => {
  resetLiveSpend();
  const plan = { totalSpendUsd: 2 };
  const req = { sessionId: 's', kind: 'trade-plan', title: 't', description: 'd', options: [], payload: plan };

  const noFlag = createHeadlessApprovalFn(false, 100);
  assert.equal((await noFlag(req)).choice, 'deny');

  const flagTightCap = createHeadlessApprovalFn(true, 1);
  assert.equal((await flagTightCap(req)).choice, 'deny', '$2 plan exceeds $1 cap');

  const flagRoomyCap = createHeadlessApprovalFn(true, 5);
  assert.equal((await flagRoomyCap(req)).choice, 'approve');

  // Spend eats the envelope: $4 already spent of $5 leaves $1 < $2 plan.
  recordUsage('local/testmodel', 0, 0, 4, 0);
  assert.equal((await flagRoomyCap(req)).choice, 'deny', 'remaining envelope too small');
  resetLiveSpend();

  const nonTrade = { ...req, kind: 'ask-user' };
  assert.equal((await createHeadlessApprovalFn(true, 100)(nonTrade)).choice, 'deny', 'non-trade approvals fail closed headless');
});
