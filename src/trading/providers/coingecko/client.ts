/**
 * Shared CoinGecko HTTP client + short-TTL cache.
 *
 * Carved out of the original `src/trading/data.ts` so every CoinGecko
 * fetcher (price, ohlcv, trending, markets) shares the same rate-limit
 * cooldown, user-agent, timeout, and in-memory cache.
 */

import type { ProviderError } from '../standard-models.js';
import { recordFetch } from '../telemetry.js';
import { VERSION } from '../../../config.js';

const BASE = 'https://api.coingecko.com/api/v3';
const UA = `franklin/${VERSION} (trading)`;
const TIMEOUT_MS = 10_000;

// Ticker → CoinGecko slug. Not exhaustive; unknown tickers fall through to
// the dynamic /search resolver below, which caches results.
//
// Verified 2026-05-04 in a live session: user asked Franklin for TON price,
// TradingMarket returned "No CoinGecko data for TON" because TON wasn't in
// this map and the lowercase fallback ("ton") doesn't match CoinGecko's
// actual id ("the-open-network"). Same hole exists for any token whose
// symbol differs from its id slug. Expanded the static map to cover the
// top ~30 currently-missing tokens, and added a /search-based resolver
// for everything else.
export const TICKER_TO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple',
  ADA: 'cardano', DOGE: 'dogecoin', AVAX: 'avalanche-2', DOT: 'polkadot', MATIC: 'matic-network',
  LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos', LTC: 'litecoin', NEAR: 'near',
  APT: 'aptos', ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', SEI: 'sei-network',
  FIL: 'filecoin', AAVE: 'aave', MKR: 'maker', SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token', INJ: 'injective-protocol', TIA: 'celestia',
  PEPE: 'pepe', WIF: 'dogwifcoin', RENDER: 'render-token',
  // ── Added 2026-05-04 after live "No CoinGecko data for TON" report ──
  TON: 'the-open-network', HYPE: 'hyperliquid', TRX: 'tron', TAO: 'bittensor',
  WLD: 'worldcoin-wld', ENA: 'ethena', BERA: 'berachain-bera', JUP: 'jupiter-exchange-solana',
  FET: 'fetch-ai', ONDO: 'ondo-finance', RNDR: 'render-token',
  USDT: 'tether', USDC: 'usd-coin', DAI: 'dai', BCH: 'bitcoin-cash', ETC: 'ethereum-classic',
  XLM: 'stellar', XMR: 'monero', IMX: 'immutable-x', GRT: 'the-graph', SAND: 'the-sandbox',
  MANA: 'decentraland', AXS: 'axie-infinity', KAS: 'kaspa', ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph', VET: 'vechain', ALGO: 'algorand', FTM: 'fantom',
  EGLD: 'elrond-erd-2', CRV: 'curve-dao-token', LDO: 'lido-dao', SHIB: 'shiba-inu',
  BONK: 'bonk', POPCAT: 'popcat', FLOKI: 'floki', PNUT: 'peanut-the-squirrel',
};

// Dynamic ticker→id cache populated by `resolveProviderIdAsync`. Long TTL
// because CoinGecko slugs are stable for a token's lifetime — they only
// change when the project rebrands, which is rare. Sync `resolveProviderId`
// reads the same Map so `transformData` can stay synchronous.
interface IdCacheEntry { id: string; expiresAt: number }
const ID_RESOLUTION_CACHE = new Map<string, IdCacheEntry>();
const ID_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/-USD$/, '').replace(/USDT?$/, '');
}

/** For tests + cache invalidation. */
export function clearIdResolutionCache(): void {
  ID_RESOLUTION_CACHE.clear();
}

/**
 * Resolve a ticker to its CoinGecko id. Synchronous — checks the static
 * map and the dynamic cache. Falls through to lowercase as a final guess.
 *
 * Use this from `transformData` (which is sync). Use `resolveProviderIdAsync`
 * from `fetchData` to populate the cache before the sync read happens.
 */
export function resolveProviderId(ticker: string): string {
  const normalized = normalizeTicker(ticker);
  if (TICKER_TO_ID[normalized]) return TICKER_TO_ID[normalized];
  if (TICKER_TO_ID[ticker.toUpperCase()]) return TICKER_TO_ID[ticker.toUpperCase()];
  const cached = ID_RESOLUTION_CACHE.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.id;
  return normalized.toLowerCase();
}

/**
 * Like `resolveProviderId`, but on a static-map miss, hits CoinGecko's
 * `/search?query=` to find the canonical id. Caches the result for 7 days
 * so `resolveProviderId` (sync) can read it back during `transformData`.
 *
 * Why not always async: `transformData` is part of the Fetcher contract
 * and is intentionally sync. `fetchData` is async, runs first, and is the
 * right place to do network resolution. The two share state via the cache.
 */
export async function resolveProviderIdAsync(ticker: string): Promise<string> {
  const normalized = normalizeTicker(ticker);
  // Static map and dynamic cache — fast path.
  if (TICKER_TO_ID[normalized]) return TICKER_TO_ID[normalized];
  if (TICKER_TO_ID[ticker.toUpperCase()]) return TICKER_TO_ID[ticker.toUpperCase()];
  const cached = ID_RESOLUTION_CACHE.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  // Network: ask CoinGecko's search endpoint.
  try {
    const result = await coingeckoGet(`/search?query=${encodeURIComponent(normalized)}`);
    if (result && typeof result === 'object' && !('kind' in result) && 'coins' in result) {
      const coins = (result as { coins?: Array<{ id?: string; symbol?: string; market_cap_rank?: number | null }> }).coins;
      if (Array.isArray(coins) && coins.length > 0) {
        // Prefer an exact symbol match; fall back to the highest-ranked
        // coin (lowest market_cap_rank value, ignoring null/undefined).
        const exact = coins.find(c => c.symbol?.toUpperCase() === normalized && typeof c.id === 'string');
        const fallback = [...coins]
          .filter((c): c is { id: string; symbol?: string; market_cap_rank?: number | null } =>
            typeof c.id === 'string')
          .sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity))[0];
        const resolved = exact?.id ?? fallback?.id;
        if (resolved) {
          ID_RESOLUTION_CACHE.set(normalized, { id: resolved, expiresAt: Date.now() + ID_TTL_MS });
          return resolved;
        }
      }
    }
  } catch {
    // /search itself failed — fall through to the lowercase guess.
  }
  return normalized.toLowerCase();
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
  const endpoint = path.split('?')[0];
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.status === 429) {
      recordFetch({ provider: 'coingecko', endpoint, ok: false, latencyMs });
      return { kind: 'rate-limited', message: 'CoinGecko rate-limited this request (HTTP 429). Retry in a minute.' };
    }
    if (res.status === 404) {
      recordFetch({ provider: 'coingecko', endpoint, ok: false, latencyMs });
      return { kind: 'not-found', message: `CoinGecko returned 404 for path ${path}` };
    }
    if (!res.ok) {
      recordFetch({ provider: 'coingecko', endpoint, ok: false, latencyMs });
      return { kind: 'upstream-error', message: `CoinGecko HTTP ${res.status}` };
    }
    recordFetch({ provider: 'coingecko', endpoint, ok: true, latencyMs });
    return await res.json();
  } catch (e: unknown) {
    const latencyMs = Date.now() - startedAt;
    if (e instanceof DOMException && e.name === 'AbortError') {
      recordFetch({ provider: 'coingecko', endpoint, ok: false, latencyMs });
      return { kind: 'timeout', message: `CoinGecko request timed out after ${TIMEOUT_MS}ms` };
    }
    recordFetch({ provider: 'coingecko', endpoint, ok: false, latencyMs });
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
