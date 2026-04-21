/**
 * Provider-agnostic trading data contracts.
 *
 * Every trading data source (CoinGecko today, Binance/CoinMarketCap/etc.
 * tomorrow) must produce these types. Downstream code — the trading engine,
 * the `trading-market` tool, the `trading-signal` tool — depends on these
 * types, not on provider-specific response shapes. That's the whole point:
 * swapping providers becomes a registry change, not a codebase change.
 *
 * Pattern: standard query params + standard data shape, both serializable,
 * both strictly typed. Providers are free to accept extra fields in their
 * own query shapes (time zone, cache bust, etc.) but their output must
 * coerce to the standard data type before returning.
 */

/**
 * Asset classes Franklin recognizes. Crypto is today; the rest unlock the
 * moment a provider with non-crypto coverage (BlockRun Gateway / Pyth) is
 * wired into the registry. Fetchers inspect this to pick the correct
 * upstream endpoint.
 */
export type AssetClass = 'crypto' | 'fx' | 'commodity' | 'stock';

/**
 * Stock exchange market codes BlockRun Gateway understands. Only meaningful
 * when `assetClass === 'stock'`; ignored otherwise.
 */
export type MarketCode =
  | 'us' | 'hk' | 'jp' | 'kr' | 'gb' | 'de' | 'fr' | 'nl' | 'ie' | 'lu' | 'cn' | 'ca';

/** Common to every query: a ticker the provider will resolve itself. */
export interface PriceQueryParams {
  ticker: string;
  /** Defaults to 'crypto' so existing callers keep working without churn. */
  assetClass?: AssetClass;
  /** Required when assetClass === 'stock'. Ignored otherwise. */
  market?: MarketCode;
}

export interface PriceData {
  ticker: string;
  priceUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  marketCapUsd: number;
}

export interface OHLCVQueryParams {
  ticker: string;
  /** Number of calendar days of history, typically 1-365. */
  days: number;
}

export interface OHLCVData {
  ticker: string;
  /** Epoch-ms timestamps aligned with closes. */
  timestamps: number[];
  /** Daily closing prices in USD. */
  closes: number[];
}

export interface TrendingQueryParams {
  // Intentionally empty — some providers accept category/timeframe filters,
  // but "trending right now" is a de-facto standard query with no params.
  // Subtypes may extend.
  _?: never;
}

export interface TrendingCoinData {
  providerId: string; // Provider-native id (e.g., CoinGecko slug "bitcoin")
  symbol: string;
  name: string;
  marketCapRank: number | null;
}

export interface MarketOverviewQueryParams {
  /** Top N by market cap. Providers may cap this internally. */
  limit: number;
}

export interface MarketCoinData {
  providerId: string;
  ticker: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapUsd: number;
  volume24hUsd: number;
}

/**
 * Error convention: providers return a `ProviderError` (plain object) rather
 * than throwing, so the caller can render it inline without try/catch at
 * every tool handler. This mirrors the legacy `string | PriceData` return
 * type but is structured — the `kind` field lets the UI color-code without
 * string parsing.
 */
export interface ProviderError {
  kind: 'rate-limited' | 'timeout' | 'not-found' | 'upstream-error' | 'unknown';
  message: string;
  /**
   * Optional provider- or endpoint-specific subcode. Populated when the
   * caller can take a different action than a generic error allows
   * (e.g. "fund your wallet" vs "retry later"). Consumers should render
   * `message` when `code` is absent.
   */
  code?:
    | 'insufficient-funds'
    | 'budget-exceeded'
    | 'schema-mismatch'
    | 'unsupported-asset-class'
    | 'missing-market-code';
}

export function isProviderError(v: unknown): v is ProviderError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    'message' in v &&
    typeof (v as ProviderError).message === 'string'
  );
}
