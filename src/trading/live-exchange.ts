/**
 * LiveExchange — ExchangeClient backed by a real pricing source (CoinGecko
 * by default) but with *simulated* fills. This is the default adapter the
 * agent uses out of the box: it sees real market prices when valuing
 * positions (so P&L tracks reality) but trades are paper — no real assets
 * are moved, no real USDC is spent on exchange fees.
 *
 * A future commit will add a `RealExchange` that actually routes orders
 * through Coinbase/Kraken; it plugs into the same ExchangeClient contract
 * here. Keep this seam clean: the agent loop, risk engine, and portfolio
 * math never need to know whether they're in paper or live mode.
 *
 * Pricing is injected (not imported directly from `./data.js`) so tests
 * can validate behavior without hitting CoinGecko.
 */

import type { ExchangeClient } from './mock-exchange.js';
import type { Fill, Side } from './portfolio.js';

/** Subset of src/trading/data.ts's PriceData that we actually consume. */
export interface PricingClientResponse {
  price: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
}

export interface PricingClient {
  /** Returns live price data on success, a string error on failure — matches data.ts. */
  getPrice(ticker: string): Promise<PricingClientResponse | string>;
}

export interface LiveExchangeOptions {
  pricing: PricingClient;
  feeBps: number;
}

export class LiveExchange implements ExchangeClient {
  constructor(private opts: LiveExchangeOptions) {}

  async getPrice(symbol: string): Promise<number | null> {
    try {
      const resp = await this.opts.pricing.getPrice(symbol.toUpperCase());
      if (typeof resp === 'string') return null;
      if (typeof resp.price !== 'number' || !Number.isFinite(resp.price)) return null;
      return resp.price;
    } catch {
      // Network errors, DNS failures, etc — treat as "price unknown" rather
      // than throwing, so the agent gets a clean "can't close, no price"
      // signal from TradingClosePosition instead of an uncaught exception.
      return null;
    }
  }

  async placeOrder(order: {
    symbol: string;
    side: Side;
    qty: number;
    priceUsd: number;
  }): Promise<Fill> {
    const notional = order.qty * order.priceUsd;
    const feeUsd = (notional * this.opts.feeBps) / 10_000;
    return {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      priceUsd: order.priceUsd,
      feeUsd,
    };
  }
}
