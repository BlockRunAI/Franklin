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
import { resolveMint } from '../tools/jupiter.js';
import { resolveTokenAddress as resolveBaseToken } from '../tools/zerox-base.js';
import { resolveTokenAddress as resolveGaslessToken } from '../tools/zerox-gasless.js';
import { captureTradeEvent } from '../memory/capture.js';
import { getAddress } from '../wallet/manager.js';
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
  consumedLineUsd?: number[];
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
  // TODO: protect read/modify/write with a cross-process lock.
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
    totalSpendUsd: opts.trades.reduce((sum, t) => sum + usdUnits(t.amountUsd), 0) / 1e6,
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
  return plan.status === 'approved' && plan.expiresAt > Date.now() && usdUnits(plan.consumedUsd) < usdUnits(plan.totalSpendUsd);
}

/** The session's live (approved, unexpired, unconsumed) plan, if any. */
export function activeTradePlan(sessionId: string = gateSessionId): TradePlan | null {
  return listTradePlans().find(p => p.sessionId === sessionId && planIsLive(p)) ?? null;
}

// Integer micro-dollars avoid granting an extra cent on each execution.
function usdUnits(usd: number): number {
  return Math.round(usd * 1e6);
}

const authorizations = new WeakMap<CapabilityInvocation, { planId: string; line: number; units: number }>();

function matchesTrade(trade: PlannedTrade, invocation: CapabilityInvocation): boolean {
  const { name, input } = invocation;
  const equal = (value: unknown, resolve: (s: string) => string = s => s.trim()) =>
    typeof value === 'string' && resolve(value).toLowerCase() === resolve(trade.asset).toLowerCase();
  if (name === 'PolymarketBet') {
    if ((trade.action === 'bet' ? 'buy' : trade.action) !== input.action) return false;
    // token_id takes precedence in the tool; unused condition/outcome fields
    // cannot authorize a different token or claim an unverified direction.
    if (input.token_id) return !trade.direction && equal(input.token_id);
    if (!input.condition_id || !input.outcome) return false;
    if (trade.direction && String(input.outcome).toLowerCase() !== trade.direction) return false;
    // The market is identified by condition_id alone. An outcome label such as
    // "Yes" exists in every market, so it can never stand in for the asset.
    return equal(input.condition_id);
  }
  if (trade.action === 'bet') return false;
  if (name === 'JupiterSwap') {
    return equal(input[trade.action === 'sell' ? 'input_mint' : 'output_mint'], resolveMint);
  }
  return equal(input[trade.action === 'sell' ? 'sell_token' : 'buy_token'],
    name === 'Base0xGaslessSwap' ? resolveGaslessToken : resolveBaseToken);
}

function tradeAmount(invocation: CapabilityInvocation): number | null {
  // Sells do not count as spend in hooks, but still consume their approved line.
  if (invocation.name === 'PolymarketBet') {
    const { price, size, action } = invocation.input;
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
      if (action === 'sell') return size; // a share can fill above its limit, up to $1
      if (typeof price === 'number' && Number.isFinite(price) && price > 0 && price <= 1) return price * size;
    }
  }
  return estimateSpendUsd(invocation.name, invocation.input);
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
export function checkTradePlanGate(
  invocation: CapabilityInvocation,
  sessionId: string = gateSessionId
): CapabilityResult | null {
  authorizations.delete(invocation);
  if (!isGatedInvocation(invocation)) return null;

  const plan = activeTradePlan(sessionId);
  const venue = VENUE_BY_TOOL[invocation.name];
  const estimate = tradeAmount(invocation);

  if (!plan) {
    appendApprovalRecord({
      ts: Date.now(),
      sessionId,
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

  const remaining = usdUnits(plan.totalSpendUsd) - usdUnits(plan.consumedUsd);
  const matching = plan.trades.map((trade, line) => ({ trade, line }))
    .filter(({ trade }) => trade.venue === venue && matchesTrade(trade, invocation));

  if (matching.length === 0) {
    return {
      output:
        `Trade blocked: approved plan ${plan.id} does not include a ${venue} trade matching this call's asset, action and direction. ` +
        'Either execute only the planned trades, or propose a new plan via the TradePlan tool.',
      isError: true,
    };
  }

  if (estimate === null || !Number.isSafeInteger(usdUnits(estimate)) || usdUnits(estimate) <= 0) {
    return { output: 'Trade blocked: cannot determine a USD amount for this call to enforce the approved line budget.', isError: true };
  }
  const units = usdUnits(estimate);
  const matched = matching.find(({ trade, line }) =>
    units <= usdUnits(trade.amountUsd) - usdUnits(plan.consumedLineUsd?.[line] ?? 0));
  if (!matched || units > remaining) {
    return {
      output:
        `Trade blocked: this call needs ~$${estimate.toFixed(2)} but plan ${plan.id} has insufficient per-line or total budget left. ` +
        'Propose a new plan for the additional spend.',
      isError: true,
    };
  }

  // Keep authorization out of tool inputs and transcripts, and retain the
  // exact plan even if another approval/cancellation occurs while executing.
  authorizations.set(invocation, { planId: plan.id, line: matched.line, units });
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
export function recordTradeExecution(
  invocation: CapabilityInvocation,
  result: CapabilityResult,
  sessionId: string = gateSessionId
): void {
  const authorization = authorizations.get(invocation);
  authorizations.delete(invocation);
  if (result.isError || !authorization) return;
  const plan = loadTradePlan(authorization.planId);
  if (!plan) return;
  const matched = plan.trades[authorization.line];
  const venue = matched.venue;
  const spent = authorization.units / 1e6;
  const consumedUnits = usdUnits(plan.consumedUsd) + authorization.units;
  const consumedLineUsd = plan.trades.map((_, line) =>
    (usdUnits(plan.consumedLineUsd?.[line] ?? 0) + (line === authorization.line ? authorization.units : 0)) / 1e6);
  const updated: TradePlan = {
    ...plan,
    consumedUsd: consumedUnits / 1e6,
    consumedLineUsd,
    status: consumedUnits >= usdUnits(plan.totalSpendUsd) ? 'consumed' : plan.status,
  };
  saveTradePlan(updated);

  // Journal the real-money execution into wallet-keyed document memory —
  // the trade journal follows the wallet, not the working directory.
  try {
    const chain = venue === 'jupiter' ? 'solana' : 'base';
    captureTradeEvent({
      kind: venue === 'polymarket' ? 'bet' : matched?.action === 'sell' ? 'close' : 'open',
      chain,
      address: getAddress(),
      asset: matched?.asset ?? String(invocation.input.asset ?? invocation.name),
      amountUsd: spent > 0 ? spent : undefined,
      thesis: plan.rationale,
      ref: plan.id,
    });
  } catch {
    /* no wallet or memory disabled — journaling is best-effort */
  }
}
