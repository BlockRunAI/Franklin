/**
 * Shared BlockRun Gateway HTTP client + short-TTL cache.
 *
 * Used by every BlockRun-backed fetcher (price, future OHLCV, etc). Mirrors
 * the shape of `coingecko/client.ts` so the two providers feel the same to
 * callers and tests.
 *
 * Chain-aware: base URL follows `loadChain()` — Base mainnet users hit
 * `blockrun.ai`, Solana users hit `sol.blockrun.ai`. Trading data endpoints
 * live under `/v1/*` (not `/api/v1`, which is the LLM proxy surface).
 *
 * PR 1 scope: free endpoints only (crypto / fx / commodity price). Paid
 * stocks endpoints (`/v1/stocks/{market}/price/{symbol}`) arrive in PR 2
 * together with the x402 signing wrapper.
 */

import type { ProviderError } from '../standard-models.js';
import { USER_AGENT, loadChain } from '../../../config.js';
import { recordFetch } from '../telemetry.js';

const TIMEOUT_MS = 10_000;

function baseUrl(): string {
  // `loadChain()` dispatches on env / ~/.blockrun/payment-chain. We match it
  // every call so mid-session chain switches take effect without restart.
  return loadChain() === 'solana' ? 'https://sol.blockrun.ai' : 'https://blockrun.ai';
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

/**
 * Fire-and-parse: GET a BlockRun Gateway REST endpoint. Returns parsed JSON
 * or a structured ProviderError — never throws. Records latency + outcome
 * to the telemetry singleton so the Panel Markets page can show live health.
 */
export async function blockrunGet(
  path: string,
  opts: { endpoint: string; paid?: boolean; costUsd?: number } = { endpoint: path },
): Promise<unknown | ProviderError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const url = `${baseUrl()}${path}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;

    if (res.status === 429) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return {
        kind: 'rate-limited',
        message: `BlockRun Gateway rate-limited this request (HTTP 429). Retry shortly.`,
      };
    }
    if (res.status === 404) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'not-found', message: `BlockRun Gateway 404 for ${path}` };
    }
    if (res.status === 402) {
      // PR 1 does not yet sign payments. Any 402 here means a caller pointed
      // this client at a paid endpoint before the x402 wrapper lands.
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return {
        kind: 'upstream-error',
        code: 'insufficient-funds',
        message: `BlockRun Gateway requires payment for ${path} — paid endpoints arrive in the next release.`,
      };
    }
    if (!res.ok) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'upstream-error', message: `BlockRun Gateway HTTP ${res.status}` };
    }
    const data = await res.json();
    recordFetch({
      provider: 'blockrun',
      endpoint: opts.endpoint,
      ok: true,
      latencyMs,
      costUsd: opts.paid ? opts.costUsd ?? 0 : 0,
    });
    return data;
  } catch (e: unknown) {
    const latencyMs = Date.now() - startedAt;
    if (e instanceof DOMException && e.name === 'AbortError') {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'timeout', message: `BlockRun Gateway timed out after ${TIMEOUT_MS}ms` };
    }
    recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
    return { kind: 'unknown', message: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pyth-style symbols always end in `-USD`. Agents may pass `BTC` meaning
 * `BTC-USD`; normalize so both shapes work.
 */
export function normalizePythSymbol(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (!upper) return upper;
  if (upper.includes('-')) return upper;
  return `${upper}-USD`;
}

/** TTLs chosen to match CoinGecko's; Pyth pushes more often but we don't
 *  need sub-minute freshness for Franklin's agent cadence. */
export const TTL = {
  price: 5 * 60_000,
  ohlcv: 60 * 60_000,
} as const;
