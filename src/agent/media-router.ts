/**
 * Media router — one LLM call that picks which image/video model fits
 * the user's request, with alternatives and cost estimates, so the agent
 * can show a clean AskUser proposal before spending.
 *
 * Principle (matches turn-analyzer): harness orchestrates, free model
 * decides. No keyword-to-model mapping in TypeScript. Classifier reads
 * the prompt + the current gateway catalog (pulled dynamically), picks
 * one recommended model plus a cheaper + a premium alternative, and
 * explains the choice in one sentence.
 *
 * Cost estimates come from `gateway-models.ts` — always dynamic,
 * margin-adjusted.
 */

import type { ModelClient } from './llm.js';
import {
  getModelsByCategory,
  estimateCostUsd,
  defaultDurationSeconds,
  maxDurationSeconds,
  type GatewayModel,
} from '../gateway-models.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type MediaKind = 'image' | 'video';
export type MediaStyle = 'photoreal' | 'illustration' | 'anime' | 'logo' | 'concept' | 'other';
export type MediaPriority = 'cost' | 'quality' | 'balanced';

export interface MediaChoice {
  model: string;
  estimatedCostUsd: number;
  rationale: string;
}

export interface MediaProposal {
  kind: MediaKind;
  quantity: number;
  durationSeconds?: number;
  maxDurationSeconds?: number;
  recommended: MediaChoice;
  cheaper?: MediaChoice;
  premium?: MediaChoice;
  intent: {
    style: MediaStyle;
    priority: MediaPriority;
  };
  totalCostUsd: number;
}

// ─── Classifier ─────────────────────────────────────────────────────────

const CLASSIFIER_MODEL = process.env.FRANKLIN_MEDIA_ROUTER_MODEL || 'nvidia/llama-4-maverick';
const TIMEOUT_MS = 3_500; // slightly more lenient than the turn-analyzer — we're asking for JSON with reasoning
const MAX_TOKENS = 256;

function buildSystemPrompt(kind: MediaKind, catalog: GatewayModel[]): string {
  const catalogLines = catalog.map(m => {
    const p = m.pricing as unknown as Record<string, number | undefined>;
    const price = kind === 'image'
      ? `$${(p.per_image ?? 0).toFixed(4)}/image`
      : `$${(p.per_second ?? 0).toFixed(2)}/s (default ${p.default_duration_seconds ?? 8}s, max ${p.max_duration_seconds ?? 8}s)`;
    return `  - ${m.id} · ${price} · ${m.description || m.name}`;
  }).join('\n');

  return `You pick the best ${kind} model for a user's Franklin request. Output ONE LINE of compact JSON. No markdown, no code fences, no explanation.

## Catalog (${catalog.length} available ${kind} models)
${catalogLines}

## Output schema

{"style":"photoreal|illustration|anime|logo|concept|other",
 "priority":"cost|quality|balanced",
 "recommended":{"model":"<id from catalog>","rationale":"<one sentence, <=140 chars>"},
 "cheaper":{"model":"<id from catalog | null>","rationale":"<one sentence>"},
 "premium":{"model":"<id from catalog | null>","rationale":"<one sentence>"}}

Rules:
- recommended is always set to an id from the catalog.
- cheaper / premium may be null if no strictly cheaper / better option exists.
- Never invent a model id. Use EXACTLY one of the catalog ids.
- Match style → model: anime/illustration prefers CogView, photoreal prefers Nano Banana Pro / Grok Imagine Pro, budget-conscious picks cheapest-acceptable.
- One sentence rationale, user-visible.

Examples:

Input: "a photo of a cat on Mars, photoreal"
Output: {"style":"photoreal","priority":"balanced","recommended":{"model":"google/nano-banana-pro","rationale":"Photoreal scenes — Nano Banana Pro has strong realism at moderate cost."},"cheaper":{"model":"google/nano-banana","rationale":"Same family, lower cost, slightly less detail."},"premium":{"model":"openai/gpt-image-2","rationale":"Best photoreal fidelity when budget allows."}}

Input: "赛博朋克风格的动漫角色"
Output: {"style":"anime","priority":"balanced","recommended":{"model":"zai/cogview-4","rationale":"CogView-4 specializes in stylized/anime imagery."},"cheaper":{"model":"google/nano-banana","rationale":"Cheaper but less stylized."},"premium":{"model":"xai/grok-imagine-image-pro","rationale":"Premium detail for complex scenes."}}

Input: "a 10-second cinematic drone shot over Tokyo at night"
Output: {"style":"concept","priority":"quality","recommended":{"model":"bytedance/seedance-2.0","rationale":"Seedance 2.0 delivers the best cinematic quality."},"cheaper":{"model":"bytedance/seedance-2.0-fast","rationale":"Faster + cheaper, minor quality trade-off."},"premium":{"model":null,"rationale":"2.0 is already the top tier."}}

Output JSON only, single line.`;
}

// ─── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry { value: MediaProposal; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 32;

function hashKey(parts: string[]): string {
  const s = parts.join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

export function clearMediaRouterCache(): void { cache.clear(); }

// ─── Parser ─────────────────────────────────────────────────────────────

const VALID_STYLES: ReadonlySet<MediaStyle> = new Set<MediaStyle>(['photoreal', 'illustration', 'anime', 'logo', 'concept', 'other']);
const VALID_PRIORITIES: ReadonlySet<MediaPriority> = new Set<MediaPriority>(['cost', 'quality', 'balanced']);

interface RawChoice { model?: unknown; rationale?: unknown; }
interface RawResponse {
  style?: unknown;
  priority?: unknown;
  recommended?: RawChoice | null;
  cheaper?: RawChoice | null;
  premium?: RawChoice | null;
}

function validateChoice(raw: RawChoice | null | undefined, catalog: Map<string, GatewayModel>): { model: GatewayModel; rationale: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.model === 'string' ? raw.model : '';
  const model = catalog.get(id);
  if (!model) return null;
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.slice(0, 240) : '';
  return { model, rationale };
}

// ─── Main API ───────────────────────────────────────────────────────────

export interface AnalyzeMediaOpts {
  kind: MediaKind;
  prompt: string;
  client: ModelClient;
  quantity?: number;           // images: count; videos: always 1
  durationSeconds?: number;    // videos only (user-specified)
  signal?: AbortSignal;
}

/**
 * Pick the best model + alternatives for this media request. Returns null
 * on any failure path (classifier timeout, parse error, empty catalog) so
 * the caller can fall back to its old hardcoded default rather than
 * blocking the user.
 */
export async function analyzeMediaRequest(opts: AnalyzeMediaOpts): Promise<MediaProposal | null> {
  if (process.env.FRANKLIN_NO_MEDIA_ROUTER === '1') return null;
  const { kind, prompt, client } = opts;
  if (!prompt || prompt.trim().length === 0) return null;

  // Pull catalog first — if the gateway doesn't have any models in this
  // category, there's nothing to recommend.
  const catalog = await getModelsByCategory(kind).catch(() => [] as GatewayModel[]);
  if (catalog.length === 0) return null;

  // Cache check — classifier output is stable for a given prompt + catalog
  // version, so re-asking within 30s is waste.
  const quantity = Math.max(1, Math.floor(opts.quantity ?? 1));
  const key = hashKey([kind, prompt.trim().slice(0, 500), String(quantity), String(opts.durationSeconds ?? '')]);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // Call the classifier.
  const catalogMap = new Map(catalog.map(m => [m.id, m]));
  const system = buildSystemPrompt(kind, catalog);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const signal = opts.signal ? combineSignals([opts.signal, ctrl.signal]) : ctrl.signal;

  let raw = '';
  try {
    const response = await client.complete(
      {
        model: CLASSIFIER_MODEL,
        system,
        messages: [{ role: 'user', content: prompt.slice(0, 1000) }],
        tools: [],
        max_tokens: MAX_TOKENS,
      },
      signal,
    );
    for (const part of response.content) {
      if (typeof part === 'object' && part.type === 'text' && part.text) raw += part.text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Parse one-line JSON (may be wrapped in stray text).
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(match[0]) as RawResponse;
  } catch {
    return null;
  }

  const style = typeof parsed.style === 'string' && VALID_STYLES.has(parsed.style as MediaStyle)
    ? (parsed.style as MediaStyle) : 'other';
  const priority = typeof parsed.priority === 'string' && VALID_PRIORITIES.has(parsed.priority as MediaPriority)
    ? (parsed.priority as MediaPriority) : 'balanced';

  const rec = validateChoice(parsed.recommended, catalogMap);
  if (!rec) return null;
  const cheaperChoice = validateChoice(parsed.cheaper, catalogMap);
  const premiumChoice = validateChoice(parsed.premium, catalogMap);

  // Build proposal with live cost estimates.
  const durationSeconds = kind === 'video'
    ? (opts.durationSeconds ?? defaultDurationSeconds(rec.model))
    : undefined;
  const maxDur = kind === 'video' ? (maxDurationSeconds(rec.model) ?? undefined) : undefined;

  const toChoice = (c: { model: GatewayModel; rationale: string } | null): MediaChoice | undefined => {
    if (!c || c.model.id === rec.model.id) return undefined;
    return {
      model: c.model.id,
      estimatedCostUsd: estimateCostUsd(c.model, { quantity, duration_seconds: durationSeconds }),
      rationale: c.rationale,
    };
  };

  const recommended: MediaChoice = {
    model: rec.model.id,
    estimatedCostUsd: estimateCostUsd(rec.model, { quantity, duration_seconds: durationSeconds }),
    rationale: rec.rationale,
  };

  const proposal: MediaProposal = {
    kind,
    quantity,
    durationSeconds,
    maxDurationSeconds: maxDur,
    recommended,
    cheaper: toChoice(cheaperChoice),
    premium: toChoice(premiumChoice),
    intent: { style, priority },
    totalCostUsd: recommended.estimatedCostUsd,
  };

  // Evict oldest if bounded
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { value: proposal, expiresAt: Date.now() + CACHE_TTL_MS });

  return proposal;
}

// ─── Presentation ───────────────────────────────────────────────────────

/**
 * Render a proposal as the user-facing AskUser question. Layout matches
 * the spec from v3.8.31 planning: recommended first with • bullet,
 * alternatives below with ○ bullets, prices include the 5% margin note.
 */
export function renderProposalForAskUser(p: MediaProposal, userPrompt: string): {
  question: string;
  options: Array<{ id: string; label: string }>;
} {
  const lines: string[] = [];
  lines.push(`*Media generation proposal*`);
  lines.push('');
  lines.push(`Prompt: "${userPrompt.trim().slice(0, 200)}"`);
  if (p.kind === 'video' && p.durationSeconds) {
    const maxNote = p.maxDurationSeconds ? ` (max ${p.maxDurationSeconds}s)` : '';
    lines.push(`Duration: ${p.durationSeconds}s${maxNote}`);
  } else if (p.kind === 'image' && p.quantity > 1) {
    lines.push(`Quantity: ${p.quantity} images`);
  }
  lines.push('');
  lines.push(`  ● Recommended  ${p.recommended.model.padEnd(32)} ~${formatUsd(p.recommended.estimatedCostUsd)}  ${p.recommended.rationale}`);
  if (p.cheaper) {
    lines.push(`  ○ Cheaper      ${p.cheaper.model.padEnd(32)} ~${formatUsd(p.cheaper.estimatedCostUsd)}  ${p.cheaper.rationale}`);
  }
  if (p.premium) {
    lines.push(`  ○ Premium      ${p.premium.model.padEnd(32)} ~${formatUsd(p.premium.estimatedCostUsd)}  ${p.premium.rationale}`);
  }
  lines.push('');
  lines.push(`  (prices include the 5% gateway fee)`);

  const options: Array<{ id: string; label: string }> = [];
  options.push({ id: 'recommended', label: `Continue with ${p.recommended.model}` });
  if (p.cheaper) options.push({ id: 'cheaper', label: `Use cheaper (${p.cheaper.model})` });
  if (p.premium) options.push({ id: 'premium', label: `Use premium (${p.premium.model})` });
  options.push({ id: 'cancel', label: 'Cancel (no charge)' });

  return { question: lines.join('\n'), options };
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
