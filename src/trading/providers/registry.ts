/**
 * Provider registry.
 *
 * Single source of truth for which Fetcher implementation a given standard
 * query should route to. One named slot per data type (price, ohlcv,
 * trending, markets), each pointing at a Fetcher. Today only CoinGecko is
 * wired up — the registry exists so a future Binance or CoinMarketCap
 * provider can plug in with a one-line change here, not a codebase-wide
 * find/replace.
 *
 * Design note: this is intentionally not a dependency-injection framework.
 * Tests that need to stub a provider should call `setProvider()` before
 * acting and reset with `resetProviders()` in a teardown. No magic.
 */

import type { Fetcher } from './fetcher.js';
import type {
  MarketCoinData,
  MarketOverviewQueryParams,
  OHLCVData,
  OHLCVQueryParams,
  PriceData,
  PriceQueryParams,
  TrendingCoinData,
  TrendingQueryParams,
} from './standard-models.js';
import { coingeckoPriceFetcher } from './coingecko/price.js';
import { coingeckoOHLCVFetcher } from './coingecko/ohlcv.js';
import { coingeckoTrendingFetcher } from './coingecko/trending.js';
import { coingeckoMarketsFetcher } from './coingecko/markets.js';

export interface TradingProviders {
  price: Fetcher<PriceQueryParams, PriceData>;
  ohlcv: Fetcher<OHLCVQueryParams, OHLCVData>;
  trending: Fetcher<TrendingQueryParams, TrendingCoinData[]>;
  markets: Fetcher<MarketOverviewQueryParams, MarketCoinData[]>;
}

const DEFAULT_PROVIDERS: TradingProviders = {
  price: coingeckoPriceFetcher,
  ohlcv: coingeckoOHLCVFetcher,
  trending: coingeckoTrendingFetcher,
  markets: coingeckoMarketsFetcher,
};

let current: TradingProviders = { ...DEFAULT_PROVIDERS };

/** Read the active fetcher for a given data type. */
export function getProvider<K extends keyof TradingProviders>(kind: K): TradingProviders[K] {
  return current[kind];
}

/** Replace one fetcher. Useful for tests; also leaves the door open for
 *  a future `franklin config trading.price-provider=binance` command. */
export function setProvider<K extends keyof TradingProviders>(
  kind: K,
  fetcher: TradingProviders[K],
): void {
  current[kind] = fetcher;
}

/** Restore the default wiring — primarily for test isolation. */
export function resetProviders(): void {
  current = { ...DEFAULT_PROVIDERS };
}
