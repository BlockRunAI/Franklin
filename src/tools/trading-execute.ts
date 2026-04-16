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

export interface TradingCapabilitiesDeps {
  engine: TradingEngine;
  /** Risk config used to report "you're using X% of your position cap". */
  riskConfig?: RiskConfig;
  /** Optional hook run after every state-changing call (e.g., persist to disk). */
  onStateChange?: () => void | Promise<void>;
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

export function createTradingCapabilities(
  deps: TradingCapabilitiesDeps,
): CapabilityHandler[] {
  const { engine, riskConfig, onStateChange } = deps;

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

      if (onStateChange) await onStateChange();

      const tradeRealized = portfolio.realizedPnlUsd - priorRealized;
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

  return [tradingPortfolio, tradingOpenPosition, tradingClosePosition];
}
