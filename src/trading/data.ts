const BASE = "https://api.coingecko.com/api/v3";
const UA = "franklin/3.3.0 (trading)";
const TIMEOUT = 10_000;

const TICKER_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", XRP: "ripple",
  ADA: "cardano", DOGE: "dogecoin", AVAX: "avalanche-2", DOT: "polkadot", MATIC: "matic-network",
  LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos", LTC: "litecoin", NEAR: "near",
  APT: "aptos", ARB: "arbitrum", OP: "optimism", SUI: "sui", SEI: "sei-network",
  FIL: "filecoin", AAVE: "aave", MKR: "maker", SNX: "synthetix-network-token",
  COMP: "compound-governance-token", INJ: "injective-protocol", TIA: "celestia",
  PEPE: "pepe", WIF: "dogwifcoin", RENDER: "render-token",
};

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

// Cache
interface CacheEntry<T> { data: T; expiry: number; }
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiry > Date.now()) return Promise.resolve(hit.data);
  return fn().then(data => {
    cache.set(key, { data, expiry: Date.now() + ttlMs });
    return data;
  });
}

const TTL_PRICE = 5 * 60_000;
const TTL_OHLCV = 60 * 60_000;
const TTL_TRENDING = 15 * 60_000;

// Fetch helper
async function geckofetch(path: string): Promise<unknown | string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (res.status === 429) return "rate-limited: CoinGecko 429 — retry later";
    if (!res.ok) return `CoinGecko error ${res.status}`;
    return await res.json();
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") return "request timed out";
    return String(e);
  } finally {
    clearTimeout(timer);
  }
}

export function resolveId(ticker: string): string {
  return TICKER_MAP[ticker.toUpperCase()] ?? ticker.toLowerCase();
}

export async function getPrice(ticker: string): Promise<PriceData | string> {
  const id = resolveId(ticker);
  return cached(`price:${id}`, TTL_PRICE, async () => {
    const raw = await geckofetch(
      `/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
    );
    if (typeof raw === "string") return raw;
    const d = (raw as Record<string, Record<string, number>>)[id];
    if (!d) return `no data for ${ticker}`;
    return {
      price: d.usd,
      change24h: d.usd_24h_change,
      volume24h: d.usd_24h_vol,
      marketCap: d.usd_market_cap,
    } satisfies PriceData;
  });
}

export async function getOHLCV(ticker: string, days = 30): Promise<OHLCVData | string> {
  const id = resolveId(ticker);
  return cached(`ohlcv:${id}:${days}`, TTL_OHLCV, async () => {
    const raw = await geckofetch(`/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
    if (typeof raw === "string") return raw;
    const prices = (raw as { prices: [number, number][] }).prices;
    return {
      timestamps: prices.map(p => p[0]),
      closes: prices.map(p => p[1]),
    } satisfies OHLCVData;
  });
}

export async function getTrending(): Promise<TrendingCoin[] | string> {
  return cached("trending", TTL_TRENDING, async () => {
    const raw = await geckofetch("/search/trending");
    if (typeof raw === "string") return raw;
    const coins = (raw as { coins: { item: { id: string; name: string; symbol: string; market_cap_rank: number | null } }[] }).coins;
    return coins.map(c => ({
      id: c.item.id,
      name: c.item.name,
      symbol: c.item.symbol,
      marketCapRank: c.item.market_cap_rank,
    })) satisfies TrendingCoin[];
  });
}

export async function getMarketOverview(): Promise<MarketCoin[] | string> {
  return cached("markets", TTL_TRENDING, async () => {
    const raw = await geckofetch("/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1");
    if (typeof raw === "string") return raw;
    return (raw as { id: string; symbol: string; name: string; current_price: number; price_change_percentage_24h: number; market_cap: number; total_volume: number }[]).map(c => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      marketCap: c.market_cap,
      volume24h: c.total_volume,
    })) satisfies MarketCoin[];
  });
}
