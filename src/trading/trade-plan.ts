/**
 * Trade plans — the approval artifact standing between the agent and real
 * money. Before any trade-execution tool (swaps, prediction-market orders)
 * can run, the session must hold an APPROVED, unexpired plan whose remaining
 * budget covers the trade. The model proposes a structured plan (assets,
 * sizes, rationale, total spend); the user approves, requests changes, or
 * denies; executions draw down the plan's budget until it is consumed.
 *
 * This gate applies in EVERY permission mode including trust — moving money
 * differs in kind from editing files, the same reasoning that keeps
 * dangerous bash commands always-prompting.
 *
 * Persistence: one JSON per plan under ~/.blockrun/trade-plans/. Decisions
 * are audited to ~/.blockrun/approvals.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import { appendApprovalRecord } from '../audit/approvals.js';
import { estimateSpendUsd, TRADE_EXECUTION_TOOLS } from '../tools/spend-tools.js';
import type { CapabilityInvocation, CapabilityResult } from '../agent/types.js';

export type TradeVenue = 'jupiter' | 'zerox' | 'polymarket';

export interface PlannedTrade {
  venue: TradeVenue;
  action: 'buy' | 'sell' | 'swap' | 'bet';
  /** Symbol, mint, token address, or market/outcome label. */
  asset: string;
  direction?: 'long' | 'short' | 'yes' | 'no';
  amountUsd: number;
  maxSlippageBps?: number;
  /** Human-readable exit/stop condition — enforced by goal loops, not code. */
  stopCondition?: string;
}

export type TradePlanStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'consumed'
  | 'cancelled';

export interface TradePlan {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: TradePlanStatus;
  trades: PlannedTrade[];
  totalSpendUsd: number;
  rationale: string;
  decidedBy?: string; // 'user:tui' | 'user:panel' | 'flag' | 'policy'
  changeRequest?: string;
  consumedUsd: number;
}

export const TRADE_PLAN_TTL_MS = 15 * 60 * 1000;

const VENUE_BY_TOOL: Record<string, TradeVenue> = {
  JupiterSwap: 'jupiter',
  Base0xSwap: 'zerox',
  Base0xGaslessSwap: 'zerox',
  PolymarketBet: 'polymarket',
};

// ─── Store ─────────────────────────────────────────────────────────────────

export function tradePlansDir(): string {
  return path.join(BLOCKRUN_DIR, 'trade-plans');
}

function planPath(id: string): string {
  return path.join(tradePlansDir(), `${id}.json`);
}

export function saveTradePlan(plan: TradePlan): void {
  fs.mkdirSync(tradePlansDir(), { recursive: true });
  const tmp = path.join(tradePlansDir(), `.${plan.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, planPath(plan.id));
}

export function loadTradePlan(id: string): TradePlan | null {
  try {
    return JSON.parse(fs.readFileSync(planPath(id), 'utf-8')) as TradePlan;
  } catch {
    return null;
  }
}

export function listTradePlans(): TradePlan[] {
  let files: string[];
  try {
    files = fs.readdirSync(tradePlansDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const plans: TradePlan[] = [];
  for (const f of files) {
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(tradePlansDir(), f), 'utf-8')) as TradePlan;
      if (plan?.id) plans.push(plan);
    } catch {
      /* skip */
    }
  }
  return plans.sort((a, b) => b.createdAt - a.createdAt);
}

export function validatePlannedTrades(trades: unknown): { trades: PlannedTrade[] } | { error: string } {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { error: 'trades must be a non-empty array' };
  }
  const cleaned: PlannedTrade[] = [];
  for (const [i, raw] of trades.entries()) {
    const t = raw as Partial<PlannedTrade>;
    if (!t || typeof t !== 'object') return { error: `trades[${i}] must be an object` };
    if (t.venue !== 'jupiter' && t.venue !== 'zerox' && t.venue !== 'polymarket') {
      return { error: `trades[${i}].venue must be jupiter | zerox | polymarket` };
    }
    if (t.action !== 'buy' && t.action !== 'sell' && t.action !== 'swap' && t.action !== 'bet') {
      return { error: `trades[${i}].action must be buy | sell | swap | bet` };
    }
    if (typeof t.asset !== 'string' || !t.asset.trim()) {
      return { error: `trades[${i}].asset is required` };
    }
    if (typeof t.amountUsd !== 'number' || !Number.isFinite(t.amountUsd) || t.amountUsd <= 0) {
      return { error: `trades[${i}].amountUsd must be a positive number` };
    }
    cleaned.push({
      venue: t.venue,
      action: t.action,
      asset: t.asset.trim(),
      direction: t.direction,
      amountUsd: t.amountUsd,
      maxSlippageBps: typeof t.maxSlippageBps === 'number' ? t.maxSlippageBps : undefined,
      stopCondition: typeof t.stopCondition === 'string' ? t.stopCondition : undefined,
    });
  }
  return { trades: cleaned };
}

export function createTradePlan(opts: {
  sessionId: string;
  trades: PlannedTrade[];
  rationale: string;
  ttlMs?: number;
}): TradePlan {
  const plan: TradePlan = {
    id: `tp_${crypto.randomBytes(6).toString('hex')}`,
    sessionId: opts.sessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + (opts.ttlMs ?? TRADE_PLAN_TTL_MS),
    status: 'pending',
    trades: opts.trades,
    totalSpendUsd: opts.trades.reduce((sum, t) => sum + t.amountUsd, 0),
    rationale: opts.rationale,
    consumedUsd: 0,
  };
  saveTradePlan(plan);
  return plan;
}

export function decideTradePlan(
  plan: TradePlan,
  decision: 'approved' | 'rejected' | 'cancelled',
  by: string,
  reason?: string
): TradePlan {
  const updated: TradePlan = {
    ...plan,
    status: decision,
    decidedBy: by,
    changeRequest: decision === 'rejected' ? reason : plan.changeRequest,
  };
  saveTradePlan(updated);
  appendApprovalRecord({
    ts: Date.now(),
    sessionId: plan.sessionId,
    kind: 'trade-plan',
    subject: plan.id,
    decision: decision === 'approved' ? 'approve' : decision === 'rejected' ? 'reject' : 'cancel',
    by,
    reason,
  });
  return updated;
}

export function formatTradePlanText(plan: TradePlan, walletBalanceUsd?: number): string {
  const lines: string[] = [];
  lines.push(`TRADE PLAN ${plan.id}`);
  lines.push('');
  for (const [i, t] of plan.trades.entries()) {
    const dir = t.direction ? ` ${t.direction.toUpperCase()}` : '';
    const slip = t.maxSlippageBps != null ? ` · max slippage ${t.maxSlippageBps} bps` : '';
    const stop = t.stopCondition ? ` · stop: ${t.stopCondition}` : '';
    lines.push(`  ${i + 1}. [${t.venue}] ${t.action.toUpperCase()}${dir} ${t.asset} — $${t.amountUsd.toFixed(2)}${slip}${stop}`);
  }
  lines.push('');
  lines.push(`  Total spend: $${plan.totalSpendUsd.toFixed(2)}${walletBalanceUsd != null ? ` (wallet: $${walletBalanceUsd.toFixed(2)})` : ''}`);
  lines.push(`  Valid until: ${new Date(plan.expiresAt).toLocaleTimeString()}`);
  lines.push('');
  lines.push(`  Rationale: ${plan.rationale}`);
  return lines.join('\n');
}

// ─── Session gate ──────────────────────────────────────────────────────────

// Session context threaded via setter (same pattern as the scheduler) because
// SessionToolGuard is constructed without session identity.
let gateSessionId = 'default';

export function setTradePlanSessionId(id: string): void {
  gateSessionId = id;
}

function planIsLive(plan: TradePlan): boolean {
  return plan.status === 'approved' && plan.expiresAt > Date.now() && plan.consumedUsd < plan.totalSpendUsd;
}

/** The session's live (approved, unexpired, unconsumed) plan, if any. */
export function activeTradePlan(sessionId: string = gateSessionId): TradePlan | null {
  return listTradePlans().find(p => p.sessionId === sessionId && planIsLive(p)) ?? null;
}

/** Does the tool input plausibly reference the planned asset? Lenient by design:
 *  symbols vs mint addresses vs market ids all count as a mention anywhere in
 *  the input values. A mismatch denies, so false negatives (blocking a covered
 *  trade) are worse than false positives here — the budget cap still binds. */
function assetMentioned(asset: string, input: Record<string, unknown>): boolean {
  const needle = asset.toLowerCase();
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function isGatedInvocation(invocation: CapabilityInvocation): boolean {
  if (!TRADE_EXECUTION_TOOLS.has(invocation.name)) return false;
  if (invocation.name === 'PolymarketBet') {
    // Only order placement is gated; setup/positions/redeem/withdraw and
    // dry-run previews (no confirm) stay free so the model can research
    // and preview before proposing a plan.
    const action = String(invocation.input.action ?? '');
    if (action !== 'buy' && action !== 'sell') return false;
    if (invocation.input.confirm !== true) return false;
  }
  return true;
}

/**
 * Trade-plan gate — called from SessionToolGuard.beforeExecute for every
 * invocation. Returns a deny result when a trade-execution call lacks plan
 * coverage; null to proceed. On coverage, flags the invocation so the tool
 * skips its redundant per-swap confirm (the plan approval IS the confirm).
 */
export function checkTradePlanGate(invocation: CapabilityInvocation): CapabilityResult | null {
  if (!isGatedInvocation(invocation)) return null;

  const plan = activeTradePlan();
  const venue = VENUE_BY_TOOL[invocation.name];
  const estimate = estimateSpendUsd(invocation.name, invocation.input);

  if (!plan) {
    appendApprovalRecord({
      ts: Date.now(),
      sessionId: gateSessionId,
      kind: 'trade-plan',
      subject: invocation.name,
      decision: 'deny',
      by: 'policy',
      reason: 'no approved trade plan',
    });
    return {
      output:
        `Trade blocked: no approved trade plan covers this ${invocation.name} call. ` +
        'Real-money trades require prior approval. Call the TradePlan tool with action "propose" — ' +
        'list every intended trade (venue, action, asset, amountUsd, slippage, stop condition) plus a ' +
        'one-paragraph rationale, wait for the user decision, then retry the trade.',
      isError: true,
    };
  }

  const remaining = plan.totalSpendUsd - plan.consumedUsd;
  const matched = plan.trades.find(
    t => t.venue === venue && assetMentioned(t.asset, invocation.input)
  );

  if (!matched) {
    return {
      output:
        `Trade blocked: approved plan ${plan.id} does not include a ${venue} trade matching this call's asset. ` +
        'Either execute only the planned trades, or propose a new plan via the TradePlan tool.',
      isError: true,
    };
  }

  const spendNeeded = estimate ?? matched.amountUsd;
  if (spendNeeded > remaining + 0.01) {
    return {
      output:
        `Trade blocked: this call needs ~$${spendNeeded.toFixed(2)} but plan ${plan.id} has only ` +
        `$${remaining.toFixed(2)} of its approved $${plan.totalSpendUsd.toFixed(2)} budget left. ` +
        'Propose a new plan for the additional spend.',
      isError: true,
    };
  }

  // Covered: the plan approval already carried the human decision — skip the
  // tool's own per-swap AskUser confirm (all swap tools honor auto_approve).
  if (invocation.name !== 'PolymarketBet') {
    invocation.input.auto_approve = true;
  }
  return null;
}

/**
 * Draw down the plan budget after a successful gated execution. Called from
 * SessionToolGuard.afterExecute for every invocation (no-op for non-trades).
 */
export function recordTradeExecution(invocation: CapabilityInvocation, result: CapabilityResult): void {
  if (result.isError || !isGatedInvocation(invocation)) return;
  const plan = activeTradePlan();
  if (!plan) return;
  const venue = VENUE_BY_TOOL[invocation.name];
  const matched = plan.trades.find(t => t.venue === venue && assetMentioned(t.asset, invocation.input));
  const spent = estimateSpendUsd(invocation.name, invocation.input) ?? matched?.amountUsd ?? 0;
  const consumedUsd = plan.consumedUsd + spent;
  const updated: TradePlan = {
    ...plan,
    consumedUsd,
    status: consumedUsd >= plan.totalSpendUsd - 0.01 ? 'consumed' : plan.status,
  };
  saveTradePlan(updated);
}
