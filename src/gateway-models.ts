import { gatewayFetch as fetch } from './payments/account.js';
/**
 * Dynamic model catalog from BlockRun Gateway.
 *
 * Pulls GET /api/v1/models once on first use, caches for 5 minutes, and
 * exposes estimators + category filters. This replaces the hardcoded
 * pricing/model tables Franklin used to carry — adding a new model or
 * changing a price on BlockRun's side no longer requires a Franklin
 * release. Gateway is the single source of truth.
 *
 * Per gateway team (2026-04-22): every model returns `billing_mode` and
 * a mode-specific `pricing` object. Dispatch on billing_mode to compute
 * an estimated charge. x402 adds a fixed 5% margin on top of base price,
 * plus a flat $0.001 per-transaction fee on paid calls (Base since
 * 2026-07-10; Solana instead enforces a $0.001 minimum per call with no
 * service fee — the flat-fee estimate over-counts there by ≤$0.001, which
 * is the safe direction for budget tracking).
 */

import { loadChain, API_URLS, USER_AGENT, type Chain } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type BillingMode =
  | 'paid'
  | 'free'
  | 'flat'
  | 'per_image'
  | 'per_second'
  | 'per_track'
  | 'per_character'
  | 'per_generation';

export interface PaidPricing { input: number; output: number; }
export interface FlatPricing { flat: number; }
export interface PerImagePricing { per_image: number; }
export interface PerSecondPricing {
  per_second: number;
  default_duration_seconds?: number;
  max_duration_seconds?: number;
}
export interface PerTrackPricing { per_track: number; }
/** ElevenLabs / ByteDance speech — billed per 1K characters of input text. */
export interface PerCharacterPricing {
  per_1k_chars: number;
  max_input_chars?: number;
}
/** ElevenLabs sound effects — flat charge per generation. */
export interface PerGenerationPricing {
  per_generation: number;
  max_duration_seconds?: number;
}

export type ModelPricing =
  | PaidPricing
  | FlatPricing
  | PerImagePricing
  | PerSecondPricing
  | PerTrackPricing
  | PerCharacterPricing
  | PerGenerationPricing;

export interface GatewayModel {
  id: string;
  name: string;
  description?: string;
  owned_by?: string;
  billing_mode: BillingMode;
  categories: string[];
  context_window?: number;
  max_output?: number;
  pricing: ModelPricing;
}

// ─── Cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60_000;   // 5 min — gateway rotates models, but not often
const FETCH_TIMEOUT_MS = 4_000;    // one-shot on init; don't let a slow gateway hang startup

// Keyed by chain. The Base and Solana gateways ship independent catalogs — an
// id free on one can be absent on the other — and loadChain() can change
// in-process (the panel writes it at runtime). A single unkeyed cache meant a
// Base catalog kept answering after a switch to Solana, so free-models.ts
// "confirmed" a Base-only id and routed to something that 400s there. Worse
// than a cold cache, because peekGatewayModel deliberately ignores the TTL, so
// the poisoned entry never aged out.
interface CacheEntry { models: GatewayModel[]; expiresAt: number; chain: Chain; }
let cache: CacheEntry | null = null;
let inflight: Promise<GatewayModel[]> | null = null;

/** Test / reset helper. */
export function clearGatewayModelsCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Synchronous, cache-only lookup. Returns null when the catalog has never been
 * fetched in this process — it never triggers a fetch, so it is safe to call
 * from the hot path and from sync functions like getContextWindow().
 *
 * Deliberately ignores the TTL: a stale gateway record still beats no record
 * at all, and the only callers are fallbacks for models we have no static
 * entry for. Callers must treat the static tables as authoritative — the
 * gateway's own metadata has been wrong for models we already know. As of
 * 2026-07-20 it reported max_output 8192 for claude-haiku-4.5 (Anthropic
 * documents 64000) and 64000 for claude-sonnet-4.6 (documented 128000).
 * Those two specific numbers are being corrected upstream, so do not treat
 * them as current — the point that outlives them is that the catalog can be
 * wrong, and a wrong value here is not cosmetic.
 *
 * Correction to an earlier note here: these values are NOT inert metadata.
 * The gateway clamps with them — Math.min(request.max_tokens, model.maxOutput)
 * in both the messages and chat/completions handlers — and derives its price
 * quote from the clamped ceiling. An over-cap request is accepted rather than
 * rejected: the handler logs "capping to <limit>" server-side and continues,
 * so from here the clamp is invisible until a reply is long enough to hit it.
 * That is why a short smoke test against a wrongly-capped model looks healthy.
 * Treat this as "better than a blind default", nothing more.
 */
export function peekGatewayModel(id: string): GatewayModel | null {
  if (!cache) return null;
  // A catalog fetched for a different chain is not evidence about this one.
  if (cache.chain !== currentChain()) return null;
  return cache.models.find(m => m.id === id) ?? null;
}

/** loadChain() with the throw swallowed — this is a hot, sync path. */
function currentChain(): Chain {
  try { return loadChain(); } catch { return 'base'; }
}

/** Test helper — seed the cache without a network call. */
export function __primeGatewayModelsCache(models: GatewayModel[]): void {
  cache = { models, expiresAt: Date.now() + CACHE_TTL_MS, chain: currentChain() };
}

/**
 * Fire-and-forget catalog warm. Populates the cache so the sync peek above has
 * something to read. Errors are swallowed — every caller has a static fallback.
 */
export function warmGatewayModelsCache(): void {
  void getGatewayModels().catch(() => { /* fallbacks cover this */ });
}

// ─── Fetch ──────────────────────────────────────────────────────────────

async function doFetch(): Promise<GatewayModel[]> {
  const chain = loadChain();
  const base = API_URLS[chain].replace(/\/api$/, '');
  // The schema/JSON gate: without ?format=json the gateway returns a
  // typed schema placeholder instead of the data envelope. Documented
  // quirk across other endpoints too.
  const url = `${base}/api/v1/models?format=json`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Gateway models list returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('Gateway models list missing data[]');
    return body.data as GatewayModel[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the model catalog, honoring the 5-minute cache. Concurrent callers
 * during a cold cache share a single in-flight promise so we don't stampede
 * the gateway at process start.
 */
export async function getGatewayModels(): Promise<GatewayModel[]> {
  if (cache && cache.chain === currentChain() && cache.expiresAt > Date.now()) return cache.models;
  if (inflight) return inflight;
  inflight = doFetch()
    .then(models => {
      cache = { models, expiresAt: Date.now() + CACHE_TTL_MS, chain: currentChain() };
      return models;
    })
    .catch(err => {
      // On failure, keep the last good cache if we have one (serve stale
      // rather than break the agent). Only hard-fail cold start.
      if (cache) return cache.models;
      throw err;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Return models filtered to a specific category (e.g. 'image', 'video', 'music'). */
export async function getModelsByCategory(category: string): Promise<GatewayModel[]> {
  const all = await getGatewayModels();
  return all.filter(m => Array.isArray(m.categories) && m.categories.includes(category));
}

/** Find a single model by ID, or null if it's not in the current catalog. */
export async function findModel(id: string): Promise<GatewayModel | null> {
  const all = await getGatewayModels();
  return all.find(m => m.id === id) ?? null;
}

// ─── Cost estimation ────────────────────────────────────────────────────

/** x402 gateway's fixed margin percentage applied on top of the base price. */
export const GATEWAY_MARGIN = 1.05;

/**
 * Flat per-transaction fee (USD) the gateway adds on top of the margined
 * price on every PAID call (no-op on $0 calls). Introduced upstream
 * 2026-07-10, briefly $0.002, back to $0.001 since 2026-07-29
 * (blockrun src/lib/transaction-fee.ts).
 */
export const GATEWAY_TRANSACTION_FEE_USD = 0.001;

export interface EstimateContext {
  /** Number of images (per_image). Default 1. */
  quantity?: number;
  /** Clip length in seconds (per_second). Falls back to model's default_duration_seconds, then 8. */
  duration_seconds?: number;
  /** Input text length (per_character). Required for a meaningful speech estimate. */
  characters?: number;
}

/**
 * Estimated USD charge to generate one response from this model under the
 * given context. Includes the 5% gateway margin and the flat $0.001
 * per-transaction fee on paid calls. Returns 0 for free and token-metered
 * (paid) models where a pre-call estimate isn't meaningful.
 */
export function estimateCostUsd(model: GatewayModel, ctx: EstimateContext = {}): number {
  const p = model.pricing as unknown as Record<string, number | undefined>;
  let base = 0;
  switch (model.billing_mode) {
    case 'per_image':
      base = (p.per_image ?? 0) * (ctx.quantity ?? 1);
      break;
    case 'per_second': {
      const dur = ctx.duration_seconds ?? p.default_duration_seconds ?? 8;
      base = (p.per_second ?? 0) * dur;
      break;
    }
    case 'per_track':
      base = p.per_track ?? 0;
      break;
    case 'per_character':
      // Priced per 1K characters of input text. Without a length there's no
      // meaningful estimate, so fall through to 0 rather than invent one.
      base = ((p.per_1k_chars ?? 0) * (ctx.characters ?? 0)) / 1000;
      break;
    case 'per_generation':
      base = p.per_generation ?? 0;
      break;
    case 'flat':
      base = p.flat ?? 0;
      break;
    case 'free':
      base = 0;
      break;
    case 'paid':
      // Token-metered — no pre-call estimate possible without counting
      // the exact request/response tokens. Return 0 so the caller shows
      // "~tokens" instead of a made-up number.
      base = 0;
      break;
  }
  // The flat transaction fee only applies to non-zero charges (the gateway's
  // addTransactionFee is a no-op at $0, keeping free flows free).
  const margined = base * GATEWAY_MARGIN;
  return +(margined > 0 ? margined + GATEWAY_TRANSACTION_FEE_USD : 0).toFixed(6);
}

/** Effective default duration for a per_second model (falls back to 8s). */
export function defaultDurationSeconds(model: GatewayModel): number {
  if (model.billing_mode !== 'per_second') return 8;
  const p = model.pricing as PerSecondPricing;
  return p.default_duration_seconds ?? 8;
}

/** Max duration the gateway will accept for a per_second model. */
export function maxDurationSeconds(model: GatewayModel): number | null {
  if (model.billing_mode !== 'per_second') return null;
  const p = model.pricing as PerSecondPricing;
  return p.max_duration_seconds ?? null;
}
