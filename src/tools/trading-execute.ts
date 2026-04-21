/**
 * Trading execution capabilities — the three-to-four tools that let the
 * agent inspect its portfolio, open/close paper positions, and (when a
 * persistent trade log is attached) query cross-session history.
 *
 * This file is now the "router" layer only: it binds the engine to tool
 * handlers and delegates rendering to `trading-views.ts`. The portfolio
 * math, risk math, and exchange simulation all live in `../trading/*`.
 * The split mirrors OpenBB's router/engine/view layering and keeps every
 * layer testable in isolation.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import type { TradingEngine } from '../trading/engine.js';
import type { Position, Portfolio } from '../trading/portfolio.js';
import type { RiskConfig } from '../trading/risk.js';
import type { TradeLog } from '../trading/trade-log.js';
import {
  renderOrderBlocked,
  renderOrderFilled,
  renderPortfolio,
  renderPositionClosed,
  renderTradeHistory,
  windowToSince,
} from './trading-views.js';

export interface TradingCapabilitiesDeps {
  engine: TradingEngine;
  /** Risk config used for "you're at X% of your exposure cap" readout. */
  riskConfig?: RiskConfig;
  /** Hook run after state-changing calls — typically persists to disk. */
  onStateChange?: () => void | Promise<void>;
  /** Persistent trade log; when provided, TradingHistory is registered. */
  tradeLog?: TradeLog;
}

// Ergonomic accessors onto the engine's internal deps. The engine already
// exposes these by reference in its constructor; reaching in avoids plumbing
// a second pair of props through every call site.
interface EngineInternals {
  deps: {
    portfolio: Portfolio;
    exchange: { getPrice(symbol: string): Promise<number | null> };
  };
}

function enginePortfolio(engine: TradingEngine): Portfolio {
  return (engine as unknown as EngineInternals).deps.portfolio;
}

function engineExchange(engine: TradingEngine): EngineInternals['deps']['exchange'] {
  return (engine as unknown as EngineInternals).deps.exchange;
}

async function buildPortfolioSnapshot(engine: TradingEngine) {
  const portfolio = enginePortfolio(engine);
  const exchange = engineExchange(engine);
  const priceTable: Record<string, number> = {};
  for (const p of portfolio.listPositions() as Position[]) {
    const quote = await exchange.getPrice(p.symbol);
    if (quote != null) priceTable[p.symbol] = quote;
  }
  return portfolio.markToMarket(priceTable);
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
      const snap = await buildPortfolioSnapshot(engine);
      return { output: renderPortfolio(snap, riskConfig) };
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
        return { output: renderOrderBlocked({ symbol, qty, priceUsd, reason: outcome.reason }) };
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

      return {
        output: renderOrderFilled({
          symbol,
          fill: outcome.fill,
          portfolio: enginePortfolio(engine),
        }),
      };
    },
  };

  const tradingClosePosition: CapabilityHandler = {
    spec: {
      name: 'TradingClosePosition',
      description:
        'Close (sell) an open position, realizing P&L against the average entry price. ' +
        "Omit qty to flatten the position entirely; pass qty to partially reduce. Uses the " +
        "exchange's current mark — no manual price required.",
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
        return { output: 'Error: TradingClosePosition requires symbol.', isError: true };
      }
      if (qty != null && (!Number.isFinite(qty) || qty <= 0)) {
        return { output: 'Error: if qty is provided, it must be > 0.', isError: true };
      }

      const portfolio = enginePortfolio(engine);
      const priorRealized = portfolio.realizedPnlUsd;
      const outcome = await engine.closePosition({ symbol, qty });
      if (outcome.status === 'noop') {
        return { output: `No open ${symbol} position to close.` };
      }
      if (outcome.status === 'blocked') {
        return { output: `## Close blocked\n- Symbol: ${symbol}\n- Reason: ${outcome.reason}` };
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

      return {
        output: renderPositionClosed({
          symbol,
          fill: outcome.fill,
          tradeRealized,
          portfolio,
        }),
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
        return { output: renderTradeHistory({ windowRaw, entries, realized }) };
      },
    };
    caps.push(tradingHistory);
  }

  return caps;
}
