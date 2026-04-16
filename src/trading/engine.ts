/**
 * TradingEngine — composes Portfolio + RiskEngine + ExchangeClient into the
 * single surface the Franklin capabilities call into.
 *
 * Responsibilities:
 *  - Pre-trade risk check (refuse the order if it would breach caps).
 *  - Route the order to the Exchange (mock or real adapter).
 *  - Apply the resulting Fill to the Portfolio.
 *
 * The engine holds no state itself beyond the injected dependencies; that
 * keeps the class easy to unit-test and lets us swap the ExchangeClient for
 * a real adapter without touching capability plumbing.
 */

import type { ExchangeClient } from './mock-exchange.js';
import type { Portfolio } from './portfolio.js';
import type { RiskEngine } from './risk.js';

export interface OpenPositionRequest {
  symbol: string;
  qty: number;
  priceUsd: number;
}

export interface CloseRequest {
  symbol: string;
  qty?: number; // if omitted, closes the entire position
}

export type Outcome =
  | { status: 'filled'; fill: { symbol: string; qty: number; priceUsd: number; feeUsd: number } }
  | { status: 'blocked'; reason: string }
  | { status: 'noop'; reason: string };

export interface TradingEngineDeps {
  portfolio: Portfolio;
  risk: RiskEngine;
  exchange: ExchangeClient;
}

export class TradingEngine {
  constructor(private deps: TradingEngineDeps) {}

  async openPosition(req: OpenPositionRequest): Promise<Outcome> {
    const { portfolio, risk, exchange } = this.deps;
    const decision = risk.check(portfolio, {
      symbol: req.symbol,
      side: 'buy',
      qty: req.qty,
      priceUsd: req.priceUsd,
    });
    if (!decision.allowed) {
      return { status: 'blocked', reason: decision.reason ?? 'blocked by risk engine' };
    }

    const fill = await exchange.placeOrder({
      symbol: req.symbol,
      side: 'buy',
      qty: req.qty,
      priceUsd: req.priceUsd,
    });
    portfolio.applyFill(fill);
    return {
      status: 'filled',
      fill: {
        symbol: fill.symbol,
        qty: fill.qty,
        priceUsd: fill.priceUsd,
        feeUsd: fill.feeUsd ?? 0,
      },
    };
  }

  async closePosition(req: CloseRequest): Promise<Outcome> {
    const { portfolio, exchange } = this.deps;
    const existing = portfolio.getPosition(req.symbol);
    if (!existing) {
      return { status: 'noop', reason: `No open ${req.symbol} position` };
    }
    const qty = req.qty ?? existing.qty;
    const price = (await exchange.getPrice(req.symbol));
    if (price == null) {
      return { status: 'blocked', reason: `Exchange returned no price for ${req.symbol}` };
    }
    const fill = await exchange.placeOrder({
      symbol: req.symbol,
      side: 'sell',
      qty,
      priceUsd: price,
    });
    portfolio.applyFill(fill);
    return {
      status: 'filled',
      fill: {
        symbol: fill.symbol,
        qty: fill.qty,
        priceUsd: fill.priceUsd,
        feeUsd: fill.feeUsd ?? 0,
      },
    };
  }
}
