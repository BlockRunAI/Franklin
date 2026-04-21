import type { Fetcher } from '../fetcher.js';
import type { MarketCoinData, MarketOverviewQueryParams, ProviderError } from '../standard-models.js';
import { cached, coingeckoGet, TTL } from './client.js';

interface RawMarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
}

export const coingeckoMarketsFetcher: Fetcher<MarketOverviewQueryParams, MarketCoinData[]> = {
  providerName: 'coingecko',

  transformQuery(input) {
    const limit = Math.max(1, Math.min(100, Math.round(Number(input.limit ?? 20))));
    return { limit };
  },

  async fetchData(query) {
    return cached(`markets:${query.limit}`, TTL.markets, async () =>
      coingeckoGet(
        `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${query.limit}&page=1`,
      ),
    );
  },

  transformData(raw, _query): MarketCoinData[] | ProviderError {
    if (!Array.isArray(raw)) {
      return { kind: 'upstream-error', message: 'CoinGecko /coins/markets returned unexpected shape' };
    }
    return (raw as RawMarketCoin[]).map(c => ({
      providerId: c.id,
      ticker: c.symbol.toUpperCase(),
      name: c.name,
      priceUsd: c.current_price,
      change24hPct: c.price_change_percentage_24h,
      marketCapUsd: c.market_cap,
      volume24hUsd: c.total_volume,
    }));
  },
};
