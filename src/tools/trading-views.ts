/**
 * Trading view/formatter helpers.
 *
 * Anything that turns engine state into human/agent-readable markdown
 * belongs here. Split out of `trading-execute.ts` so the tool handlers in
 * `trading-router.ts` stay focused on request handling and the engine
 * stays free of presentation concerns. This mirrors the view/controller
 * separation OpenBB enforces between `standard_models` (data) and the
 * router-side rendering that happens in their MCP layer.
 */

import type { Position } from '../trading/portfolio.js';
import type { Portfolio } from '../trading/portfolio.js';
import type { RiskConfig } from '../trading/risk.js';
import type { TradeLogEntry } from '../trading/trade-log.js';

export function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatPositionLine(
  p: Position & { markUsd: number; unrealizedPnlUsd: number },
): string {
  const pctReturn = (p.markUsd - p.avgPriceUsd) / p.avgPriceUsd;
  const arrow = p.unrealizedPnlUsd >= 0 ? '↑' : '↓';
  return (
    `- **${p.symbol}** qty=${p.qty} @ avg ${formatUsd(p.avgPriceUsd)} ` +
    `| mark ${formatUsd(p.markUsd)} ${arrow} ` +
    `| unrealized ${formatUsd(p.unrealizedPnlUsd)} (${formatPct(pctReturn)})`
  );
}

export function formatTradeLine(entry: TradeLogEntry): string {
  const when = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 16);
  const side = entry.side.toUpperCase();
  const pnl =
    entry.realizedPnlUsd === 0 ? '' : ` → realized ${formatUsd(entry.realizedPnlUsd)}`;
  return `- ${when}  ${side} ${entry.qty} ${entry.symbol} @ ${formatUsd(entry.priceUsd)}${pnl}`;
}

/** Parse a window string ("24h", "7d", "all") into a lower-bound timestamp. */
export function windowToSince(window: string, now: number): number {
  const m = /^(\d+)\s*([hdwm])$/i.exec(window.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 'h': return now - n * 3_600_000;
    case 'd': return now - n * 86_400_000;
    case 'w': return now - n * 7 * 86_400_000;
    case 'm': return now - n * 30 * 86_400_000;
    default: return 0;
  }
}

export interface PortfolioSnapshot {
  cashUsd: number;
  equityUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  positions: (Position & { markUsd: number; unrealizedPnlUsd: number })[];
}

export function renderPortfolio(
  snap: PortfolioSnapshot,
  riskConfig?: RiskConfig,
): string {
  const lines: string[] = [];
  lines.push('## Portfolio');
  lines.push(`- Cash: ${formatUsd(snap.cashUsd)}`);
  lines.push(`- Equity (cash + positions marked-to-market): ${formatUsd(snap.equityUsd)}`);
  lines.push(`- Unrealized P&L: ${formatUsd(snap.unrealizedPnlUsd)}`);
  lines.push(`- Realized P&L (this session): ${formatUsd(snap.realizedPnlUsd)}`);
  lines.push('');
  if (snap.positions.length === 0) {
    lines.push('_No open positions._');
  } else {
    lines.push('### Open positions');
    for (const p of snap.positions) lines.push(formatPositionLine(p));
  }
  if (riskConfig) {
    const totalExposure = snap.positions.reduce((a, p) => a + p.qty * p.markUsd, 0);
    lines.push('');
    lines.push('### Risk utilization');
    lines.push(
      `- Total exposure: ${formatUsd(totalExposure)} / cap ${formatUsd(riskConfig.maxTotalExposureUsd)} ` +
      `(${formatPct(totalExposure / riskConfig.maxTotalExposureUsd)})`,
    );
  }
  return lines.join('\n');
}

export function renderOrderFilled(params: {
  symbol: string;
  fill: { qty: number; priceUsd: number; feeUsd: number };
  portfolio: Portfolio;
}): string {
  const { symbol, fill, portfolio } = params;
  const pos = portfolio.getPosition(symbol);
  return (
    `## Order filled\n` +
    `- Bought ${fill.qty} ${symbol} @ ${formatUsd(fill.priceUsd)} ` +
    `(fee ${formatUsd(fill.feeUsd)})\n` +
    `- Position now: ${pos ? `${pos.qty} ${symbol} @ avg ${formatUsd(pos.avgPriceUsd)}` : '(none)'}\n` +
    `- Cash remaining: ${formatUsd(portfolio.cashUsd)}`
  );
}

export function renderOrderBlocked(params: {
  symbol: string;
  qty: number;
  priceUsd: number;
  reason: string;
}): string {
  return (
    `## Order blocked\n` +
    `- Symbol: ${params.symbol}\n` +
    `- Attempted: buy ${params.qty} @ ${formatUsd(params.priceUsd)}\n` +
    `- Reason: ${params.reason}\n\n` +
    `Try a smaller qty, or close other positions first to free up exposure headroom.`
  );
}

export function renderPositionClosed(params: {
  symbol: string;
  fill: { qty: number; priceUsd: number; feeUsd: number };
  tradeRealized: number;
  portfolio: Portfolio;
}): string {
  const { symbol, fill, tradeRealized, portfolio } = params;
  const remaining = portfolio.getPosition(symbol);
  return (
    `## Position closed\n` +
    `- Sold ${fill.qty} ${symbol} @ ${formatUsd(fill.priceUsd)} ` +
    `(fee ${formatUsd(fill.feeUsd)})\n` +
    `- Realized on this trade: ${formatUsd(tradeRealized)}\n` +
    `- Remaining ${symbol}: ${remaining ? `${remaining.qty} @ avg ${formatUsd(remaining.avgPriceUsd)}` : '(flat)'}\n` +
    `- Cash: ${formatUsd(portfolio.cashUsd)} · ` +
    `Session realized P&L: ${formatUsd(portfolio.realizedPnlUsd)}`
  );
}

export function renderTradeHistory(params: {
  windowRaw: string;
  entries: TradeLogEntry[];
  realized: number;
}): string {
  const { windowRaw, entries, realized } = params;
  const opens = entries.filter(e => e.side === 'buy').length;
  const closes = entries.filter(e => e.side === 'sell').length;
  const lines: string[] = [];
  lines.push(`## Trade history (${windowRaw})`);
  lines.push(`- ${windowRaw} P&L (realized): ${formatUsd(realized)}`);
  lines.push(`- Trades: ${entries.length} (${opens} opens, ${closes} closes)`);
  lines.push('');
  if (entries.length === 0) {
    lines.push('_No trades in this window._');
  } else {
    for (const e of entries) lines.push(formatTradeLine(e));
  }
  return lines.join('\n');
}
