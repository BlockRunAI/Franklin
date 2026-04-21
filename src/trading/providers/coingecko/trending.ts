import type { Fetcher } from '../fetcher.js';
import type { ProviderError, TrendingCoinData, TrendingQueryParams } from '../standard-models.js';
import { cached, coingeckoGet, TTL } from './client.js';

interface RawTrending {
  coins: { item: { id: string; name: string; symbol: string; market_cap_rank: number | null } }[];
}

export const coingeckoTrendingFetcher: Fetcher<TrendingQueryParams, TrendingCoinData[]> = {
  providerName: 'coingecko',

  transformQuery(_input) {
    return {};
  },

  async fetchData(_query) {
    return cached('trending', TTL.trending, async () => coingeckoGet('/search/trending'));
  },

  transformData(raw, _query): TrendingCoinData[] | ProviderError {
    const payload = raw as RawTrending | null;
    if (!payload || !Array.isArray(payload.coins)) {
      return { kind: 'upstream-error', message: 'CoinGecko /search/trending returned unexpected shape' };
    }
    return payload.coins.map(c => ({
      providerId: c.item.id,
      name: c.item.name,
      symbol: c.item.symbol,
      marketCapRank: c.item.market_cap_rank,
    }));
  },
};
