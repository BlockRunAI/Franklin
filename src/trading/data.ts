/**
 * Legacy data.ts — thin shim over the provider registry.
 *
 * Keeps the historical `string | Data` error-by-string return convention so
 * the existing callers (`trading.ts`, `tools/index.ts` wiring into
 * `LiveExchange`) keep working without a call-site rewrite. New code should
 * import from `./providers/registry.js` and consume `PriceData | ProviderError`
 * directly — the structured error shape enables UI color-coding and retry
 * classification the string convention can't express.
 */

import { getProvider } from './providers/registry.js';
import { runFetcher } from './providers/fetcher.js';
import { isProviderError } from './providers/standard-models.js';

export interface PriceData {
  price: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
}

export interface OHLCVData {
  closes: number[];
  timestamps: number[];
}

export interface TrendingCoin {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number | null;
}

export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  marketCap: number;
  volume24h: number;
}

export function resolveId(ticker: string): string {
  // Delegated — kept exported for backwards compat with any external caller.
  return ticker.toLowerCase();
}

export async function getPrice(ticker: string): Promise<PriceData | string> {
  const result = await runFetcher(getProvider('price'), { ticker });
  if (isProviderError(result)) return result.message;
  return {
    price: result.priceUsd,
    change24h: result.change24hPct,
    volume24h: result.volume24hUsd,
    marketCap: result.marketCapUsd,
  };
}

export async function getOHLCV(ticker: string, days = 30): Promise<OHLCVData | string> {
  const result = await runFetcher(getProvider('ohlcv'), { ticker, days });
  if (isProviderError(result)) return result.message;
  return { closes: result.closes, timestamps: result.timestamps };
}

export async function getTrending(): Promise<TrendingCoin[] | string> {
  const result = await runFetcher(getProvider('trending'), {});
  if (isProviderError(result)) return result.message;
  return result.map(c => ({
    id: c.providerId,
    name: c.name,
    symbol: c.symbol,
    marketCapRank: c.marketCapRank,
  }));
}

export async function getMarketOverview(): Promise<MarketCoin[] | string> {
  const result = await runFetcher(getProvider('markets'), { limit: 20 });
  if (isProviderError(result)) return result.message;
  return result.map(c => ({
    id: c.providerId,
    symbol: c.ticker.toLowerCase(),
    name: c.name,
    price: c.priceUsd,
    change24h: c.change24hPct,
    marketCap: c.marketCapUsd,
    volume24h: c.volume24hUsd,
  }));
}
