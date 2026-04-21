import type { Fetcher } from '../fetcher.js';
import type { OHLCVData, OHLCVQueryParams, ProviderError } from '../standard-models.js';
import { cached, coingeckoGet, resolveProviderId, TTL } from './client.js';

export const coingeckoOHLCVFetcher: Fetcher<OHLCVQueryParams, OHLCVData> = {
  providerName: 'coingecko',

  transformQuery(input) {
    const ticker = String(input.ticker ?? '').trim().toUpperCase();
    if (!ticker) throw new Error('OHLCVQueryParams.ticker is required');
    const days = Math.max(1, Math.min(365, Math.round(Number(input.days ?? 30))));
    return { ticker, days };
  },

  async fetchData(query) {
    const id = resolveProviderId(query.ticker);
    return cached(`ohlcv:${id}:${query.days}`, TTL.ohlcv, async () => {
      return coingeckoGet(
        `/coins/${id}/market_chart?vs_currency=usd&days=${query.days}&interval=daily`,
      );
    });
  },

  transformData(raw, query): OHLCVData | ProviderError {
    const payload = raw as { prices?: [number, number][] } | null;
    const prices = payload?.prices;
    if (!Array.isArray(prices) || prices.length === 0) {
      return { kind: 'not-found', message: `No OHLCV data for ${query.ticker} (${query.days}d)` };
    }
    return {
      ticker: query.ticker,
      timestamps: prices.map(p => p[0]),
      closes: prices.map(p => p[1]),
    };
  },
};
