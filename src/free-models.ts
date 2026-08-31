/**
 * Single source of truth for the BlockRun free tier.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The free default used to be a bare string literal repeated 63 times across
 * 21 files. Every time NVIDIA rotated its free pool — 2026-06-07, 07-11,
 * 07-14, 08-12, 08-19, 08-29 — someone had to find and edit all 63. That is
 * the sixth rotation in three months, and each one shipped with a few stale
 * copies left behind. One constant, imported everywhere, ends that.
 *
 * WHAT THE 2026-08-30 PROBE FOUND
 * -------------------------------
 * Every free id Franklin named had left the Base catalog, and the gateway was
 * answering for them with a different model:
 *
 *   nvidia/nemotron-nano-9b-v2      -> nvidia/nemotron-3-nano-30b
 *   nvidia/mistral-nemotron         -> nvidia/nemotron-3-super-120b-a12b-free
 *   nvidia/nemotron-nano-12b-v2-vl  -> nvidia/nemotron-3-nano-omni-...
 *   nvidia/step-3.7-flash           -> nvidia/nemotron-3.5-lightning
 *
 * That redirection is DELIBERATE upstream, not a gateway bug: the free tier
 * sits on NVIDIA's on-demand NIM tier, which EOLs models (410), pulls
 * deployments (404) and lets cold ones hang, so blockrun runs a self-healing
 * circuit breaker (src/lib/free-health.ts) that routes around dead free
 * models at runtime. It replaced a hand-maintained redirect list precisely
 * because that list was always stale. The substitution is also disclosed —
 * the response's `model` field names whatever actually served the call.
 *
 * So the failure was ours: Franklin named ids that no longer exist and never
 * read that field back. What follows is about not doing that again.
 *
 * Two findings shape everything below, and BOTH were invisible until the
 * probe ran against the endpoint and the chain Franklin actually uses.
 *
 * 1. THE CHAINS ARE NOT IN SYNC. The Base gateway lists 7 free models; the
 *    Solana gateway lists exactly ONE — nemotron-3-nano-omni — and 400s
 *    ("Unknown model") on the other six. A default picked from the Base
 *    catalog is a hard failure on a Solana user's first turn. That is why
 *    FREE_DEFAULT_MODEL is the id present on BOTH chains, and the stronger
 *    Base-only model is an upgrade applied at runtime rather than a
 *    committed literal.
 *
 * 2. SUBSTITUTION IS ENDPOINT-SPECIFIC. The pooling above reproduces on
 *    POST /api/v1/chat/completions. On POST /api/v1/messages — the endpoint
 *    Franklin's ModelClient uses — every id answered as ITSELF across
 *    repeated calls on both chains, with no leaked chain-of-thought. So
 *    "which id serves itself" has a different answer per endpoint, and a
 *    probe is only evidence for the path it was run against.
 *
 * What this file does about it:
 *
 *   1. One constant, imported everywhere, instead of 63 string literals.
 *   2. A chain-safe static default, upgraded from the LIVE catalog at runtime
 *      (freeChain / resolveFreeModel), so a Base user gets the stronger model
 *      and a Solana user gets one that exists.
 *   3. Context sized by the pool floor, not the catalogued window
 *      (FREE_POOL_CONTEXT_FLOOR).
 *   4. No free vision — see freeVisionModel().
 */

import { peekGatewayModel } from './gateway-models.js';

/**
 * The free model Franklin asks for by default.
 *
 * nemotron-3-nano-omni is chosen for AVAILABILITY, not for being the best: it
 * is the only free id present in both the Base and the Solana catalogs. Every
 * other free model is Base-only and 400s on Solana, and Franklin ships with
 * either chain selectable. Base users are upgraded to the stronger model at
 * runtime by freeChain() — see FREE_PREFERENCE_ORDER.
 *
 * Verified on POST /api/v1/messages (Franklin's own endpoint) on both chains:
 * answers as itself, no leaked reasoning, tool calls work.
 */
export const FREE_DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

/**
 * Free models in preference order, best first.
 *
 * Only FREE_DEFAULT_MODEL is available on both chains; the rest are Base-only
 * as of 2026-08-30. freeChain() filters this against the live catalog for the
 * CURRENT chain, so this list can name Base-only ids without breaking Solana.
 *
 * Ordering rationale:
 *   - nemotron-3-ultra-550b leads on Base. It was the only free model to
 *     answer the "name three Base-chain DEXes" control question correctly (it
 *     named Aerodrome; the others hallucinated Uniswap forks), and it carries
 *     the largest catalogued context.
 *   - poolside/laguna-xs-2.1 is last on purpose: it is the only rung from a
 *     different PROVIDER, so the chain survives an NVIDIA-wide outage instead
 *     of being four names for one upstream.
 *
 * Not listed, and why (all probed 2026-08-30):
 *   - nvidia/nemotron-3.5-lightning — slowest measured, and the one id that
 *     leaked its full "Here's a thinking process:" trace into content on
 *     /v1/messages as well as on chat/completions.
 *   - cohere/north-mini-code — returned an EMPTY stream on 3 of 5 streaming
 *     calls. Franklin's agent loop streams, so an empty stream is a dead turn.
 *   - nvidia/llama-3.2-11b-vision — catalogued as vision, cannot accept an
 *     image (see freeVisionModel), and is otherwise the weakest text model in
 *     the pool.
 */
export const FREE_PREFERENCE_ORDER: readonly string[] = [
  'nvidia/nemotron-3-ultra-550b',   // Base only
  FREE_DEFAULT_MODEL,               // both chains — the floor this never drops below
  'nvidia/nemotron-3-nano-30b',     // Base only
  'poolside/laguna-xs-2.1',         // Base only, different provider
];

/**
 * Context budget for ANY free-tier request, regardless of the catalogued
 * window of the id we asked for.
 *
 * The strongest free model is catalogued at 1M, but the free tier is a pool:
 * on chat/completions a request for it can be served by the 131K
 * nemotron-3-nano-30b with no warning, and the chain-safe default is 256K.
 * Sizing compaction off 1M would build a prompt the substitute cannot accept,
 * and it would fail mid-session on a user who never chose the substitute.
 * 131_072 is the floor of every model currently in the free pool.
 */
export const FREE_POOL_CONTEXT_FLOOR = 131_072;

/**
 * Catalogued free ids Franklin will not route to, with the reason each was
 * rejected in the 2026-08-30 probe. These are real, billable-at-$0 ids — they
 * are excluded on behaviour, not availability.
 */
export const QUARANTINED_FREE_MODELS: readonly string[] = [
  // Catalogued as vision-capable, but cannot accept an image on the endpoint
  // Franklin uses: Base returns 502 "Failed to load image", and on
  // chat/completions it comes back from a text-only substitute replying
  // "There's no image provided". Weakest text model in the pool otherwise.
  'nvidia/llama-3.2-11b-vision',
  // Slowest free model measured (8.2s), and leaks its full reasoning trace
  // into content on both endpoints.
  'nvidia/nemotron-3.5-lightning',
  // Self-serving, but returned an EMPTY stream on 3 of 5 streaming calls.
  // Franklin's agent loop streams, so an empty stream is a dead turn.
  'cohere/north-mini-code',
];

/**
 * Free ids Franklin used to name. The gateway still answers for all of them
 * (via substitution), but they are gone from /api/v1/models. Kept so old
 * session-cost records still price at $0 and so stale aliases can be remapped
 * rather than handed back to the user as-is.
 */
export const LEGACY_FREE_MODEL_IDS: readonly string[] = [
  'nvidia/nemotron-nano-9b-v2',
  'nvidia/mistral-nemotron',
  'nvidia/nemotron-nano-12b-v2-vl',
  'nvidia/step-3.7-flash',
  'nvidia/nemotron-3-super-120b',
  'nvidia/nemotron-3-super-120b-a12b-free',
];

/**
 * Every free id in the live Base catalog as of 2026-08-30, mapped to its
 * catalogued context window. Used for metadata display; NOT for sizing a
 * request — use FREE_POOL_CONTEXT_FLOOR for that.
 */
export const FREE_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'nvidia/nemotron-3-ultra-550b': 1_000_000,
  'nvidia/nemotron-3.5-lightning': 1_000_000,
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': 256_000,
  'cohere/north-mini-code': 256_000,
  'nvidia/nemotron-3-nano-30b': 131_072,
  'poolside/laguna-xs-2.1': 131_072,
  'nvidia/llama-3.2-11b-vision': 128_000,
};

/**
 * Free vision is unavailable.
 *
 * Probed 2026-08-30 with a real PNG on POST /api/v1/messages — the endpoint
 * Franklin uses — against both ids the catalog tags free + vision:
 *
 *   Solana, nemotron-3-nano-omni : answers as itself, image dropped —
 *                                  "I can't view the image, so I can't list
 *                                  its colors."
 *   Base,   nemotron-3-nano-omni : 502 from the upstream, "Failed to load
 *                                  image from data:image/png..."
 *   Base,   llama-3.2-11b-vision : served by a text-only model replying
 *                                  "There's no image provided."
 *
 * A dropped image produces a confidently wrong answer, the worst outcome for
 * a vision turn. Returning null makes the free profile say so instead of
 * guessing, and the free profile must never fall back to a paid model.
 *
 * This is a claim about what the gateway currently serves, not about the
 * models' capabilities — re-add when a real image probe succeeds.
 */
export function freeVisionModel(): string | null {
  return null;
}

/**
 * Is this id billed at $0?
 *
 * Replaces the `m.startsWith('nvidia/')` heuristic that was spread across the
 * subagent tool, the /model command and the compaction picker. That heuristic
 * was wrong in both directions once the pool rotated:
 *
 *   - nvidia/kimi-k2.5 is a PAID model ($0.55/$2.50 per 1M). Treating it as
 *     free meant `/model kimi-k2.5` skipped the "charges from your wallet"
 *     warning, and a free-tier parent could hand compaction a paid model.
 *   - poolside/laguna-xs-2.1 and cohere/north-mini-code are free and carry no
 *     `nvidia/` prefix, so they were treated as paid.
 *
 * The live catalog is consulted first (it is authoritative and picks up new
 * free ids without a release); the static sets answer when the cache is cold.
 */
export function isFreeModelId(id: string | undefined | null): boolean {
  if (!id) return false;
  if (id === 'blockrun/free' || id === '') return true;
  const entry = peekGatewayModel(id);
  if (entry) return entry.billing_mode === 'free';
  if (id in FREE_MODEL_CONTEXT_WINDOWS) return true;
  return LEGACY_FREE_MODEL_IDS.includes(id);
}

/**
 * The free chain to try right now, best first, filtered to what the CURRENT
 * chain's gateway actually lists.
 *
 * peekGatewayModel reads the cached catalog and never triggers a fetch, so
 * this is safe on the hot path and in sync callers. When the cache is cold
 * there is no evidence either way, and the answer is the one id that exists
 * on both chains — guessing the Base-only model there would 400 every Solana
 * user's first turn, which is the exact failure this function exists to
 * prevent.
 *
 * `exclude` drops rungs that already failed this turn.
 */
export function freeChain(exclude: ReadonlySet<string> = new Set()): string[] {
  const candidates = FREE_PREFERENCE_ORDER.filter(id => !exclude.has(id));
  const confirmed = candidates.filter(
    id => peekGatewayModel(id)?.billing_mode === 'free',
  );
  if (confirmed.length > 0) return confirmed;
  // Cold cache, or a catalog listing none of them: fall back to the only id
  // known to exist on every chain.
  return candidates.filter(id => id === FREE_DEFAULT_MODEL);
}

/** Pick the single free model to request right now. See freeChain(). */
export function resolveFreeModel(exclude: ReadonlySet<string> = new Set()): string {
  return freeChain(exclude)[0] ?? FREE_DEFAULT_MODEL;
}
