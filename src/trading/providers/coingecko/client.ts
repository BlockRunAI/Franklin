/**
 * Shared CoinGecko HTTP client + short-TTL cache.
 *
 * Carved out of the original `src/trading/data.ts` so every CoinGecko
 * fetcher (price, ohlcv, trending, markets) shares the same rate-limit
 * cooldown, user-agent, timeout, and in-memory cache.
 */

import type { ProviderError } from '../standard-models.js';

const BASE = 'https://api.coingecko.com/api/v3';
const UA = 'franklin/3.8.9 (trading)';
const TIMEOUT_MS = 10_000;

// Ticker → CoinGecko slug. Not exhaustive; unknown tickers fall through to
// lowercase and let CoinGecko either accept the slug or 404.
export const TICKER_TO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple',
  ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2', DOT: 'polkadot', MATIC: 'matic-network',
  LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos', LTC: 'litecoin', NEAR: 'near',
  APT: 'aptos', ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', SEI: 'sei-network',
  FIL: 'filecoin', AAVE: 'aave', MKR: 'maker', SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token', INJ: 'injective-protocol', TIA: 'celestia',
  PEPE: 'pepe', WIF: 'dogwifcoin', RENDER: 'render-token',
};

export function resolveProviderId(ticker: string): string {
  return TICKER_TO_ID[ticker.toUpperCase()] ?? ticker.toLowerCase();
}

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiry > Date.now()) return hit.data;
  const data = await fn();
  cache.set(key, { data, expiry: Date.now() + ttlMs });
  return data;
}

/** For tests: wipe every cached entry. */
export function clearCache(): void {
  cache.clear();
}

export async function coingeckoGet(path: string): Promise<unknown | ProviderError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      return { kind: 'rate-limited', message: 'CoinGecko rate-limited this request (HTTP 429). Retry in a minute.' };
    }
    if (res.status === 404) {
      return { kind: 'not-found', message: `CoinGecko returned 404 for path ${path}` };
    }
    if (!res.ok) {
      return { kind: 'upstream-error', message: `CoinGecko HTTP ${res.status}` };
    }
    return await res.json();
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { kind: 'timeout', message: `CoinGecko request timed out after ${TIMEOUT_MS}ms` };
    }
    return { kind: 'unknown', message: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// TTLs for cache reuse across fetchers.
export const TTL = {
  price: 5 * 60_000,
  ohlcv: 60 * 60_000,
  trending: 15 * 60_000,
  markets: 15 * 60_000,
} as const;
