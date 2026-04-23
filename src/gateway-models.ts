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
 * so actual charge = base * 1.05 (confirmed against a live 402 response
 * on seedance-2.0-fast: 5s × $0.15 × 1.05 = $0.7875).
 */

import { loadChain, API_URLS, USER_AGENT } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type BillingMode = 'paid' | 'free' | 'flat' | 'per_image' | 'per_second' | 'per_track';

export interface PaidPricing { input: number; output: number; }
export interface FlatPricing { flat: number; }
export interface PerImagePricing { per_image: number; }
export interface PerSecondPricing {
  per_second: number;
  default_duration_seconds?: number;
  max_duration_seconds?: number;
}
export interface PerTrackPricing { per_track: number; }

export type ModelPricing =
  | PaidPricing
  | FlatPricing
  | PerImagePricing
  | PerSecondPricing
  | PerTrackPricing;

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

interface CacheEntry { models: GatewayModel[]; expiresAt: number; }
let cache: CacheEntry | null = null;
let inflight: Promise<GatewayModel[]> | null = null;

/** Test / reset helper. */
export function clearGatewayModelsCache(): void {
  cache = null;
  inflight = null;
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
  if (cache && cache.expiresAt > Date.now()) return cache.models;
  if (inflight) return inflight;
  inflight = doFetch()
    .then(models => {
      cache = { models, expiresAt: Date.now() + CACHE_TTL_MS };
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

export interface EstimateContext {
  /** Number of images (per_image). Default 1. */
  quantity?: number;
  /** Clip length in seconds (per_second). Falls back to model's default_duration_seconds, then 8. */
  duration_seconds?: number;
}

/**
 * Estimated USD charge to generate one response from this model under the
 * given context. Includes the 5% gateway margin. Returns 0 for free and
 * token-metered (paid) models where a pre-call estimate isn't meaningful.
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
  return +(base * GATEWAY_MARGIN).toFixed(6);
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
