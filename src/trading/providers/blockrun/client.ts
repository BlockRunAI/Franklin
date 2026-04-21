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
import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';

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
      // Free-path client should never see a 402. If the Gateway starts
      // charging for an endpoint that was free, surface an actionable
      // error and let the caller migrate to `blockrunGetPaid`.
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return {
        kind: 'upstream-error',
        code: 'insufficient-funds',
        message: `Gateway unexpectedly requires payment for ${path}. Move this endpoint to blockrunGetPaid.`,
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

// ─── x402 paid GET ──────────────────────────────────────────────────────
//
// Mirrors the POST payment flow in `src/tools/exa.ts` but for GET requests
// against Pyth paid endpoints (stocks today; historical OHLCV tomorrow).
// Lazy-loads the wallet on first 402 so free endpoints never touch the
// wallet module.
//
// No budget gate, no pre-flight check, no soft refusal — Franklin's whole
// identity is "agent with a wallet that spends USDC for real work". $0.001
// per stock quote is not a category that warrants a permission prompt.

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* ignore */ }
  }
  return header;
}

async function signGatewayPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
): Promise<Record<string, string> | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;
    if (chain === 'solana') {
      const wallet = await getOrCreateSolanaWallet();
      const paymentRequired = parsePaymentRequired(paymentHeader);
      const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
      const secretBytes = await solanaKeyToBytes(wallet.privateKey);
      const feePayer = details.extra?.feePayer || details.recipient;
      const payload = await createSolanaPaymentPayload(
        secretBytes,
        wallet.address,
        details.recipient,
        details.amount,
        feePayer as string,
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'Franklin trading data',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
    const wallet = getOrCreateWallet();
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || 'Franklin trading data',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    // Bubble a typed error up so the caller can turn it into a
    // ProviderError with code: 'insufficient-funds'.
    throw new PaymentSignError((err as Error).message);
  }
}

class PaymentSignError extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentSignError'; }
}

/**
 * GET a paid BlockRun Gateway endpoint with automatic x402 signing.
 * Returns parsed JSON or a structured ProviderError. Never throws.
 */
export async function blockrunGetPaid(
  path: string,
  opts: { endpoint: string; costUsd: number },
): Promise<unknown | ProviderError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const url = `${baseUrl()}${path}`;
  const chain = loadChain();
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  try {
    let res = await fetch(url, { headers, signal: ctrl.signal });
    if (res.status === 402) {
      try {
        const paid = await signGatewayPayment(res, chain, url);
        if (!paid) {
          const latencyMs = Date.now() - startedAt;
          recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
          return {
            kind: 'upstream-error',
            code: 'insufficient-funds',
            message: 'Gateway required payment but did not supply payment-required header. Fund your wallet: franklin wallet fund',
          };
        }
        res = await fetch(url, { headers: { ...headers, ...paid }, signal: ctrl.signal });
      } catch (e: unknown) {
        const latencyMs = Date.now() - startedAt;
        recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
        if (e instanceof PaymentSignError) {
          return {
            kind: 'upstream-error',
            code: 'insufficient-funds',
            message: `Payment failed: ${e.message}. Check wallet balance with "franklin wallet".`,
          };
        }
        throw e;
      }
    }
    const latencyMs = Date.now() - startedAt;
    if (res.status === 429) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'rate-limited', message: 'BlockRun Gateway rate-limited this request. Retry shortly.' };
    }
    if (res.status === 404) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'not-found', message: `BlockRun Gateway 404 for ${path}` };
    }
    if (!res.ok) {
      recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
      return { kind: 'upstream-error', message: `BlockRun Gateway HTTP ${res.status}` };
    }
    const data = await res.json();
    recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: true, latencyMs, costUsd: opts.costUsd });
    return data;
  } catch (e: unknown) {
    const latencyMs = Date.now() - startedAt;
    recordFetch({ provider: 'blockrun', endpoint: opts.endpoint, ok: false, latencyMs });
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { kind: 'timeout', message: `BlockRun Gateway timed out after ${TIMEOUT_MS}ms` };
    }
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
