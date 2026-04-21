/**
 * Provider registry.
 *
 * Single source of truth for which Fetcher implementation a given standard
 * query should route to. One named slot per data kind — plus a keyed map
 * for `price` so we can route per asset class (crypto → CoinGecko free tier,
 * fx/commodity/stock → BlockRun Gateway / Pyth) without the call sites
 * knowing which provider is active.
 *
 * Design note: this is intentionally not a dependency-injection framework.
 * Tests that need to stub a provider should call `setProvider*()` before
 * acting and reset with `resetProviders()` in a teardown. No magic.
 */

import type { Fetcher } from './fetcher.js';
import type {
  AssetClass,
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
import { blockrunPriceFetcher } from './blockrun/price.js';

export type PriceFetcher = Fetcher<PriceQueryParams, PriceData>;

export interface TradingProviders {
  /** Per-asset-class price fetcher. `getPriceProvider(assetClass)` reads this. */
  price: Record<AssetClass, PriceFetcher>;
  ohlcv: Fetcher<OHLCVQueryParams, OHLCVData>;
  trending: Fetcher<TrendingQueryParams, TrendingCoinData[]>;
  markets: Fetcher<MarketOverviewQueryParams, MarketCoinData[]>;
}

const DEFAULT_PROVIDERS: TradingProviders = {
  price: {
    crypto: coingeckoPriceFetcher,
    fx: blockrunPriceFetcher,
    commodity: blockrunPriceFetcher,
    stock: blockrunPriceFetcher,
  },
  ohlcv: coingeckoOHLCVFetcher,
  trending: coingeckoTrendingFetcher,
  markets: coingeckoMarketsFetcher,
};

let current: TradingProviders = {
  ...DEFAULT_PROVIDERS,
  price: { ...DEFAULT_PROVIDERS.price },
};

/** Read the active fetcher for a singleton data kind (not price). */
export function getProvider<K extends Exclude<keyof TradingProviders, 'price'>>(
  kind: K,
): TradingProviders[K] {
  return current[kind];
}

/** Read the active price fetcher for a given asset class. Defaults to crypto. */
export function getPriceProvider(assetClass: AssetClass = 'crypto'): PriceFetcher {
  return current.price[assetClass];
}

/** Replace one singleton fetcher. */
export function setProvider<K extends Exclude<keyof TradingProviders, 'price'>>(
  kind: K,
  fetcher: TradingProviders[K],
): void {
  current[kind] = fetcher;
}

/** Replace one asset-class price fetcher. */
export function setPriceProvider(assetClass: AssetClass, fetcher: PriceFetcher): void {
  current.price[assetClass] = fetcher;
}

/** Restore the default wiring — primarily for test isolation. */
export function resetProviders(): void {
  current = {
    ...DEFAULT_PROVIDERS,
    price: { ...DEFAULT_PROVIDERS.price },
  };
}

/**
 * Describe the active wiring for introspection (Panel Markets page, debug).
 * Returns a per-asset-class listing plus the singleton kinds.
 */
export interface ProviderWiringRow {
  kind: string;
  assetClass?: AssetClass;
  provider: string;
  endpoint: string;
  paid: boolean;
}

export function describeWiring(): ProviderWiringRow[] {
  const rows: ProviderWiringRow[] = [];
  const priceEndpoints: Record<AssetClass, { endpoint: string; paid: boolean }> = {
    crypto: { endpoint: 'coingecko /simple/price · blockrun /api/v1/crypto/price', paid: false },
    fx: { endpoint: '/api/v1/fx/price', paid: false },
    commodity: { endpoint: '/api/v1/commodity/price', paid: false },
    stock: { endpoint: '/api/v1/stocks/{market}/price', paid: true },
  };
  for (const ac of ['crypto', 'fx', 'commodity', 'stock'] as AssetClass[]) {
    const f = current.price[ac];
    const meta = priceEndpoints[ac];
    rows.push({
      kind: 'price',
      assetClass: ac,
      provider: f.providerName,
      endpoint: ac === 'crypto' && f.providerName === 'coingecko'
        ? 'coingecko /simple/price'
        : meta.endpoint.split(' · ').pop() || meta.endpoint,
      paid: meta.paid,
    });
  }
  rows.push({ kind: 'ohlcv', provider: current.ohlcv.providerName, endpoint: '/coins/{id}/market_chart', paid: false });
  rows.push({ kind: 'trending', provider: current.trending.providerName, endpoint: '/search/trending', paid: false });
  rows.push({ kind: 'markets', provider: current.markets.providerName, endpoint: '/coins/markets', paid: false });
  return rows;
}
