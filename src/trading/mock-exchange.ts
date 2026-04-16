/**
 * MockExchange — deterministic in-memory exchange used by tests and dev mode.
 *
 * Implements the same `ExchangeClient` contract a real adapter would, so the
 * agent flow can be verified end-to-end without hitting a network or placing
 * real orders. Fills land at the requested price (no slippage) with a
 * configured taker fee in basis points; no latency is simulated.
 *
 * When a real Coinbase/Kraken adapter lands (follow-up PR), it replaces
 * MockExchange at the ExchangeClient seam — no Portfolio or RiskEngine
 * changes required.
 */

import type { Fill, Side } from './portfolio.js';

export interface ExchangeClient {
  placeOrder(order: {
    symbol: string;
    side: Side;
    qty: number;
    priceUsd: number;
  }): Promise<Fill>;
  // Live mark-price for portfolio valuation. Real adapters hit the ticker
  // endpoint; MockExchange reads from its config.
  getPrice(symbol: string): Promise<number | null>;
}

export interface MockExchangeOptions {
  prices: Record<string, number>;
  feeBps: number; // basis points; 10 = 0.10%
}

export class MockExchange implements ExchangeClient {
  private prices: Record<string, number>;
  private feeBps: number;

  constructor(opts: MockExchangeOptions) {
    this.prices = { ...opts.prices };
    this.feeBps = opts.feeBps;
  }

  /** Update the synthetic price book (e.g. to simulate a move in tests). */
  setPrice(symbol: string, priceUsd: number): void {
    this.prices[symbol] = priceUsd;
  }

  async placeOrder(order: {
    symbol: string;
    side: Side;
    qty: number;
    priceUsd: number;
  }): Promise<Fill> {
    if (!(order.symbol in this.prices)) {
      throw new Error(`MockExchange has no quote for ${order.symbol}`);
    }
    const notional = order.qty * order.priceUsd;
    const feeUsd = (notional * this.feeBps) / 10_000;
    return {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      priceUsd: order.priceUsd,
      feeUsd,
    };
  }

  async getPrice(symbol: string): Promise<number | null> {
    return this.prices[symbol] ?? null;
  }
}
