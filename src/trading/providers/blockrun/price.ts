/**
 * BlockRun Gateway price fetcher.
 *
 * One fetcher, many asset classes. Dispatches on `PriceQueryParams.assetClass`
 * to the right Pyth-backed Gateway endpoint:
 *
 *   crypto     → /api/v1/crypto/price/{ticker}         free
 *   fx         → /api/v1/fx/price/{ticker}             free
 *   commodity  → /api/v1/commodity/price/{ticker}      free
 *   stock      → /v1/stocks/{market}/price/{ticker} paid ($0.001 x402) — PR 2
 *
 * PR 1 scope: crypto / fx / commodity only. The stock branch returns a
 * `ProviderError { code: 'insufficient-funds' }` until the x402 signing
 * wrapper lands, so callers get a useful message instead of a wire-level
 * 402.
 *
 * Response shape from Gateway: Pyth delivers `{ price, confidence, timestamp }`
 * — no 24h change, no market cap, no volume. Legacy CoinGecko-shaped fields
 * (`change24hPct`, `volume24hUsd`, `marketCapUsd`) come back as `NaN` for
 * non-crypto classes; views treat NaN as "not applicable" and render a dash.
 */

import type { Fetcher } from '../fetcher.js';
import type { PriceData, PriceQueryParams, ProviderError } from '../standard-models.js';
import { blockrunGet, cached, normalizePythSymbol, TTL } from './client.js';

/**
 * Actual Gateway response shape (verified 2026-04-21 against
 * https://blockrun.ai/api/v1/crypto/price/BTC-USD):
 *
 *   { symbol: 'BTC-USD', category: 'crypto', price: 75583.15,
 *     confidence: 27.34, publishTime: 1776791355,
 *     timestamp: '2026-04-21T17:09:15.000Z', assetType: 'crypto',
 *     feedId: '0xe62...', source: 'pyth' }
 *
 * Pyth feeds do NOT carry 24h change, 24h volume, or market cap — those
 * fields stay NaN for BlockRun-sourced prices. Views treat NaN as "n/a"
 * and render a dash instead of "+NaN%".
 */
interface RawPythPrice {
  symbol?: string;
  category?: string;
  price?: number;
  confidence?: number;
  publishTime?: number;
  timestamp?: string;
  feedId?: string;
  source?: string;
}

function endpointFor(
  assetClass: Exclude<PriceQueryParams['assetClass'], undefined>,
  ticker: string,
  market?: PriceQueryParams['market'],
): { path: string; endpoint: string; paid: boolean } | ProviderError {
  switch (assetClass) {
    case 'crypto':
      return { path: `/api/v1/crypto/price/${ticker}`, endpoint: '/api/v1/crypto/price', paid: false };
    case 'fx':
      return { path: `/api/v1/fx/price/${ticker}`, endpoint: '/api/v1/fx/price', paid: false };
    case 'commodity':
      return { path: `/api/v1/commodity/price/${ticker}`, endpoint: '/api/v1/commodity/price', paid: false };
    case 'stock':
      if (!market) {
        return {
          kind: 'not-found',
          code: 'missing-market-code',
          message: `Stock queries require a market code (us/hk/jp/kr/gb/de/fr/nl/ie/lu/cn/ca). Got ticker "${ticker}" with none.`,
        };
      }
      return {
        path: `/api/v1/stocks/${market}/price/${ticker}`,
        endpoint: `/api/v1/stocks/${market}/price`,
        paid: true,
      };
    default: {
      const _exhaust: never = assetClass;
      void _exhaust;
      return { kind: 'unknown', code: 'unsupported-asset-class', message: `Unsupported asset class` };
    }
  }
}

export const blockrunPriceFetcher: Fetcher<PriceQueryParams, PriceData> = {
  providerName: 'blockrun',

  transformQuery(input) {
    const assetClass = (input.assetClass ?? 'crypto') as Exclude<PriceQueryParams['assetClass'], undefined>;
    const rawTicker = String(input.ticker ?? '').trim();
    if (!rawTicker) throw new Error('PriceQueryParams.ticker is required');
    // Stocks: keep ticker as-is (`AAPL`, `7203`, `HSBA`). Everything else:
    // Pyth-style `BASE-QUOTE`, upper-cased, `-USD` suffix defaulted.
    const ticker = assetClass === 'stock'
      ? rawTicker.toUpperCase()
      : normalizePythSymbol(rawTicker);
    return { ticker, assetClass, market: input.market };
  },

  async fetchData(query) {
    const assetClass = (query.assetClass ?? 'crypto') as Exclude<PriceQueryParams['assetClass'], undefined>;
    const resolved = endpointFor(assetClass, query.ticker, query.market);
    if ('kind' in resolved) return resolved;

    const cacheKey = `blockrun:${assetClass}:${query.market ?? ''}:${query.ticker}`;
    return cached(cacheKey, TTL.price, async () =>
      blockrunGet(resolved.path, {
        endpoint: resolved.endpoint,
        paid: resolved.paid,
        costUsd: resolved.paid ? 0.001 : 0,
      }),
    );
  },

  transformData(raw, query): PriceData | ProviderError {
    if (!raw || typeof raw !== 'object') {
      return { kind: 'upstream-error', code: 'schema-mismatch', message: 'Gateway returned non-object payload' };
    }
    const payload = raw as RawPythPrice & Record<string, unknown>;
    if (typeof payload.price !== 'number' || !Number.isFinite(payload.price)) {
      return {
        kind: 'upstream-error',
        code: 'schema-mismatch',
        message: `Gateway payload missing numeric 'price' for ${query.ticker}`,
      };
    }
    // Pyth feeds don't carry 24h deltas; future Gateway upgrades might add
    // them as optional fields, so we read defensively via indexed access.
    const change = payload['change_24h_pct'];
    const volume = payload['volume_24h_usd'];
    const marketCap = payload['market_cap_usd'];
    return {
      ticker: query.ticker,
      priceUsd: payload.price,
      change24hPct: typeof change === 'number' ? change : NaN,
      volume24hUsd: typeof volume === 'number' ? volume : NaN,
      marketCapUsd: typeof marketCap === 'number' ? marketCap : NaN,
    };
  },
};
