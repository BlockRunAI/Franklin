/**
 * CoinGecko implementation of Fetcher<PriceQueryParams, PriceData>.
 *
 * Transforms: uppercase ticker → CoinGecko slug lookup.
 * Fetches: /simple/price with 24h change/cap/volume flags.
 * Coerces: the nested `{ [id]: { usd: ..., usd_24h_change: ... } }`
 *          response into the standard PriceData shape.
 */

import type { Fetcher } from '../fetcher.js';
import type { PriceData, PriceQueryParams, ProviderError } from '../standard-models.js';
import { cached, coingeckoGet, resolveProviderId, TTL } from './client.js';

export const coingeckoPriceFetcher: Fetcher<PriceQueryParams, PriceData> = {
  providerName: 'coingecko',

  transformQuery(input) {
    const ticker = String(input.ticker ?? '').trim().toUpperCase();
    if (!ticker) {
      throw new Error('PriceQueryParams.ticker is required');
    }
    return { ticker };
  },

  async fetchData(query) {
    const id = resolveProviderId(query.ticker);
    return cached(`price:${id}`, TTL.price, async () => {
      return coingeckoGet(
        `/simple/price?ids=${id}` +
        `&vs_currencies=usd&include_24hr_change=true` +
        `&include_market_cap=true&include_24hr_vol=true`,
      );
    });
  },

  transformData(raw, query): PriceData | ProviderError {
    const id = resolveProviderId(query.ticker);
    const entry = (raw as Record<string, Record<string, number>>)[id];
    if (!entry) {
      return { kind: 'not-found', message: `No CoinGecko data for ${query.ticker}` };
    }
    return {
      ticker: query.ticker,
      priceUsd: entry.usd,
      change24hPct: entry.usd_24h_change,
      volume24hUsd: entry.usd_24h_vol,
      marketCapUsd: entry.usd_market_cap,
    };
  },
};
