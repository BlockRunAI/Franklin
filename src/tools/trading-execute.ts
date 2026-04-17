/**
 * Trading execution capabilities. Exposes Franklin's Portfolio + RiskEngine
 * + Exchange stack to the agent as three tools: TradingPortfolio (read),
 * TradingOpenPosition (buy side), TradingClosePosition (sell side).
 *
 * This is the surface that differentiates Franklin from generic coding
 * agents — Claude Code and Cursor cannot hold a wallet, track positions
 * across sessions, or reason about P&L. Every output here is deliberately
 * information-rich so the agent has the numbers it needs to make the next
 * economic decision (cash left, risk utilization, unrealized vs realized
 * P&L, fill detail) without a follow-up tool call.
 *
 * Factory-style construction (createTradingCapabilities) keeps testing
 * clean: production code calls it with a default disk-backed engine;
 * tests inject a MockExchange-backed engine and assert behavior without
 * touching disk.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import type { TradingEngine } from '../trading/engine.js';
import type { Position } from '../trading/portfolio.js';
import type { RiskConfig } from '../trading/risk.js';
import type { TradeLog, TradeLogEntry } from '../trading/trade-log.js';

export interface TradingCapabilitiesDeps {
  engine: TradingEngine;
  /** Risk config used to report "you're using X% of your position cap". */
  riskConfig?: RiskConfig;
  /** Optional hook run after every state-changing call (e.g., persist to disk). */
  onStateChange?: () => void | Promise<void>;
  /**
   * Optional persistent trade log. When provided, opens and closes are
   * appended to it and the TradingHistory capability is registered so the
   * agent can query cross-session P&L.
   */
  tradeLog?: TradeLog;
}

function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatPositionLine(
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

/** Parse a window string (e.g. "24h", "7d", "all") into a lower-bound timestamp. */
function windowToSince(window: string, now: number): number {
  const m = /^(\d+)\s*([hdwm])$/i.exec(window.trim());
  if (!m) return 0; // "all" or anything unparseable → since epoch
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 'h': return now - n * 3_600_000;
    case 'd': return now - n * 86_400_000;
    case 'w': return now - n * 7 * 86_400_000;
    case 'm': return now - n * 30 * 86_400_000;
    default: return 0;
  }
}

function formatTradeLine(entry: TradeLogEntry): string {
  const when = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 16);
  const side = entry.side.toUpperCase();
  const pnl =
    entry.realizedPnlUsd === 0 ? '' : ` → realized ${formatUsd(entry.realizedPnlUsd)}`;
  return `- ${when}  ${side} ${entry.qty} ${entry.symbol} @ ${formatUsd(entry.priceUsd)}${pnl}`;
}

export function createTradingCapabilities(
  deps: TradingCapabilitiesDeps,
): CapabilityHandler[] {
  const { engine, riskConfig, onStateChange, tradeLog } = deps;

  const tradingPortfolio: CapabilityHandler = {
    spec: {
      name: 'TradingPortfolio',
      description:
        'Report current paper-trading portfolio: cash, open positions with unrealized P&L, ' +
        'and realized P&L across the session. No inputs. Use this before deciding whether ' +
        'to open, close, or hold a position.',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    concurrent: true,
    async execute(_input, _ctx: ExecutionScope): Promise<CapabilityResult> {
      // markToMarket against current exchange prices; fall back to avg price
      // (flat unrealized) when the exchange doesn't know the symbol.
      const priceTable: Record<string, number> = {};
      for (const p of (engine as unknown as { deps: { portfolio: { listPositions(): Position[] } } }).deps.portfolio.listPositions()) {
        const quote = await (engine as unknown as { deps: { exchange: { getPrice(s: string): Promise<number | null> } } }).deps.exchange.getPrice(p.symbol);
        if (quote != null) priceTable[p.symbol] = quote;
      }
      const portfolio = (engine as unknown as { deps: { portfolio: { markToMarket(t: Record<string, number>): ReturnType<import('../trading/portfolio.js').Portfolio['markToMarket']> } } }).deps.portfolio;
      const snap = portfolio.markToMarket(priceTable);

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
      return { output: lines.join('\n') };
    },
  };

  const tradingOpenPosition: CapabilityHandler = {
    spec: {
      name: 'TradingOpenPosition',
      description:
        'Open (buy into) a position. Pre-trade risk checks enforce per-position and total ' +
        'exposure caps; a blocked order returns a normal text result with the reason — the ' +
        'agent should read it and try again with a smaller qty if appropriate. This is paper ' +
        'trading: fills are simulated against the provided price.',
      input_schema: {
        type: 'object',
        required: ['symbol', 'qty', 'priceUsd'],
        properties: {
          symbol: { type: 'string', description: 'Ticker (e.g., "BTC", "ETH")' },
          qty: { type: 'number', description: 'Quantity in base units (e.g., 0.01 for 0.01 BTC)' },
          priceUsd: { type: 'number', description: 'Price at which to execute, in USD' },
        },
        additionalProperties: false,
      },
    },
    concurrent: false,
    async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const symbol = String(input.symbol ?? '').toUpperCase();
      const qty = Number(input.qty);
      const priceUsd = Number(input.priceUsd);
      if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0) {
        return {
          output: 'Error: TradingOpenPosition requires symbol (string), qty (>0), priceUsd (>0).',
          isError: true,
        };
      }

      const outcome = await engine.openPosition({ symbol, qty, priceUsd });
      if (outcome.status === 'blocked') {
        // Not an agent error — a legitimate risk decision the agent must read.
        return {
          output:
            `## Order blocked\n` +
            `- Symbol: ${symbol}\n` +
            `- Attempted: buy ${qty} @ ${formatUsd(priceUsd)}\n` +
            `- Reason: ${outcome.reason}\n\n` +
            `Try a smaller qty, or close other positions first to free up exposure headroom.`,
        };
      }
      if (outcome.status === 'noop') {
        return { output: `No-op: ${outcome.reason}` };
      }

      if (tradeLog) {
        tradeLog.append({
          timestamp: Date.now(),
          symbol,
          side: 'buy',
          qty: outcome.fill.qty,
          priceUsd: outcome.fill.priceUsd,
          feeUsd: outcome.fill.feeUsd,
          realizedPnlUsd: 0,
        });
      }
      if (onStateChange) await onStateChange();

      const portfolio = (engine as unknown as { deps: { portfolio: import('../trading/portfolio.js').Portfolio } }).deps.portfolio;
      const pos = portfolio.getPosition(symbol);
      return {
        output:
          `## Order filled\n` +
          `- Bought ${outcome.fill.qty} ${symbol} @ ${formatUsd(outcome.fill.priceUsd)} ` +
          `(fee ${formatUsd(outcome.fill.feeUsd)})\n` +
          `- Position now: ${pos ? `${pos.qty} ${symbol} @ avg ${formatUsd(pos.avgPriceUsd)}` : '(none)'}\n` +
          `- Cash remaining: ${formatUsd(portfolio.cashUsd)}`,
      };
    },
  };

  const tradingClosePosition: CapabilityHandler = {
    spec: {
      name: 'TradingClosePosition',
      description:
        'Close (sell) an open position, realizing P&L against the average entry price. ' +
        'Omit qty to flatten the position entirely; pass qty to partially reduce. Uses the ' +
        'exchange\'s current mark — no manual price required.',
      input_schema: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: 'Ticker of the position to close' },
          qty: {
            type: 'number',
            description: 'Optional — partial size. Omit to close the full position.',
          },
        },
        additionalProperties: false,
      },
    },
    concurrent: false,
    async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
      const symbol = String(input.symbol ?? '').toUpperCase();
      const qty = input.qty != null ? Number(input.qty) : undefined;
      if (!symbol) {
        return {
          output: 'Error: TradingClosePosition requires symbol.',
          isError: true,
        };
      }
      if (qty != null && (!Number.isFinite(qty) || qty <= 0)) {
        return {
          output: 'Error: if qty is provided, it must be > 0.',
          isError: true,
        };
      }

      const portfolio = (engine as unknown as { deps: { portfolio: import('../trading/portfolio.js').Portfolio } }).deps.portfolio;
      const priorRealized = portfolio.realizedPnlUsd;
      const outcome = await engine.closePosition({ symbol, qty });
      if (outcome.status === 'noop') {
        return { output: `No open ${symbol} position to close.` };
      }
      if (outcome.status === 'blocked') {
        return {
          output:
            `## Close blocked\n- Symbol: ${symbol}\n- Reason: ${outcome.reason}`,
        };
      }

      const tradeRealized = portfolio.realizedPnlUsd - priorRealized;
      if (tradeLog) {
        tradeLog.append({
          timestamp: Date.now(),
          symbol,
          side: 'sell',
          qty: outcome.fill.qty,
          priceUsd: outcome.fill.priceUsd,
          feeUsd: outcome.fill.feeUsd,
          realizedPnlUsd: tradeRealized,
        });
      }
      if (onStateChange) await onStateChange();

      const remaining = portfolio.getPosition(symbol);
      return {
        output:
          `## Position closed\n` +
          `- Sold ${outcome.fill.qty} ${symbol} @ ${formatUsd(outcome.fill.priceUsd)} ` +
          `(fee ${formatUsd(outcome.fill.feeUsd)})\n` +
          `- Realized on this trade: ${formatUsd(tradeRealized)}\n` +
          `- Remaining ${symbol}: ${remaining ? `${remaining.qty} @ avg ${formatUsd(remaining.avgPriceUsd)}` : '(flat)'}\n` +
          `- Cash: ${formatUsd(portfolio.cashUsd)} · ` +
          `Session realized P&L: ${formatUsd(portfolio.realizedPnlUsd)}`,
      };
    },
  };

  const caps: CapabilityHandler[] = [tradingPortfolio, tradingOpenPosition, tradingClosePosition];

  if (tradeLog) {
    const tradingHistory: CapabilityHandler = {
      spec: {
        name: 'TradingHistory',
        description:
          'Show recent trades and realized P&L within a time window. Unlike ephemeral ' +
          'session state, this reads the persistent trade log so it spans every prior ' +
          'session on this machine. Use to answer "am I up this week?", "what was my ' +
          'worst trade?", "how often am I flipping BTC?".',
        input_schema: {
          type: 'object',
          properties: {
            window: {
              type: 'string',
              description: 'Time window: "24h", "7d", "30d", "all". Default "7d".',
            },
            limit: {
              type: 'number',
              description: 'Max number of trade rows to list. Default 20.',
            },
          },
          additionalProperties: false,
        },
      },
      concurrent: true,
      async execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
        const windowRaw = String(input.window ?? '7d').trim();
        const limit = Number.isFinite(Number(input.limit))
          ? Math.max(1, Math.min(200, Number(input.limit)))
          : 20;
        const now = Date.now();
        const since = windowRaw.toLowerCase() === 'all' ? 0 : windowToSince(windowRaw, now);

        const entries = tradeLog.recent(limit).filter((e) => e.timestamp >= since);
        const realized = tradeLog.realizedSince(since);
        const opens = entries.filter((e) => e.side === 'buy').length;
        const closes = entries.filter((e) => e.side === 'sell').length;

        const lines: string[] = [];
        lines.push(`## Trade history (${windowRaw})`);
        lines.push(
          `- ${windowRaw} P&L (realized): ${formatUsd(realized)}`,
        );
        lines.push(`- Trades: ${entries.length} (${opens} opens, ${closes} closes)`);
        lines.push('');
        if (entries.length === 0) {
          lines.push('_No trades in this window._');
        } else {
          for (const e of entries) lines.push(formatTradeLine(e));
        }
        return { output: lines.join('\n') };
      },
    };
    caps.push(tradingHistory);
  }

  return caps;
}
