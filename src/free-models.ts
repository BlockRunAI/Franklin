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
 * Ordering rationale — AVAILABILITY FIRST, quality second. Measured on
 * /v1/messages, Base, max_tokens 300, 5 calls each (2026-08-31):
 *
 *   nemotron-3-nano-30b   5/5 healthy, 0.8-2.9s
 *   nemotron-3-nano-omni  2/5 healthy, three HTTP 503s
 *   nemotron-3-ultra-550b 0/5 healthy — every call timed out at 40s
 *
 *   - nemotron-3-nano-30b leads on Base. It is the pool's own backing model,
 *     which is why it is the one id that never comes back as a substitute and
 *     the one that stays up when the rest of the pool is congested.
 *   - nemotron-3-ultra-550b is NOT in this list, and that reverses an earlier
 *     revision which had it leading. It gives the best answers when it answers
 *     — the only free model to name Aerodrome for "three Base-chain DEXes"
 *     while the others hallucinated Uniswap forks — but a model you cannot
 *     reach is not a better model. The andy session measured it independently
 *     at 1/3 and 1/5, with NVIDIA congestion relayed as HTTP 200; here it was
 *     0/5 with hard timeouts. It stays reachable by explicit pin
 *     (`/model ultra-550b`), it just cannot lead a chain.
 *   - the two non-NVIDIA rungs are last on purpose: they are what keeps the
 *     chain alive through an NVIDIA-wide outage instead of it being four names
 *     for one upstream.
 *
 * Not listed, and why:
 *   - nvidia/nemotron-3.5-lightning — LATENCY, and only latency. Measured
 *     10.9s / 12.2s / 22.5s for a one-sentence answer at max_tokens 800,
 *     against ~0.8-3s for the rest of the pool. Its name is a lie. (An
 *     earlier revision of this file quarantined it for leaking reasoning
 *     prose; that was wrong — see TRUNCATION below.)
 *   - nvidia/llama-3.2-11b-vision — catalogued as vision, cannot accept an
 *     image (see freeVisionModel), and is otherwise the weakest text model in
 *     the pool.
 *
 * TRUNCATION: THE FREE POOL NEEDS ROOM TO THINK
 * ---------------------------------------------
 * Every free model here is a reasoning model, and a tight max_tokens makes
 * them look broken in two different ways that are the SAME bug. Measured on
 * chat/completions, 2026-08-31:
 *
 *   nemotron-3-nano-30b, "what does approve() do":
 *     max_tokens 20  -> finish_reason "length", content is truncated thinking
 *                       ("Okay, the user is asking about...")
 *     max_tokens 120 -> finish_reason "length", still truncated thinking
 *     max_tokens 300 -> finish_reason "stop", content is a clean answer and
 *                       the thinking sits in reasoning_content
 *
 *   cohere/north-mini-code, "name three Base-chain DEXes":
 *     max_tokens 200  -> EMPTY stream, 0 content chunks, 6 of 8 calls
 *     max_tokens 2000 -> 6 of 6 clean, finish_reason "stop"
 *
 * So "leaks chain-of-thought into content" and "returns an empty stream" are
 * both the budget running out before the model stops reasoning. Neither is a
 * property of the model, and neither is worth a workaround — give the call
 * room. This is why the router's tier classifier no longer asks for a
 * one-word answer in 8 tokens (see router/index.ts).
 *
 * The andy session traced the mechanism further, and it changes what the
 * discriminator is. Probed three ways at max_tokens 20: the NIM upstream
 * returns a clean `content: "OK"` with finish_reason "stop", while sol's
 * /chat/completions returns the thinking in `content` with finish_reason
 * "length". The upstream separates the fields correctly; the GATEWAY's
 * extractor falls back to reasoning text when the answer field is empty. So
 * raising max_tokens does not fix the bug, it stops triggering it, and
 * finish_reason "length" is the real discriminator — treat any truncated
 * free-tier reply as suspect regardless of budget.
 *
 * One claim of theirs did NOT reproduce here: they reported /v1/messages
 * leaking on nano-omni at a small budget. Probed at max_tokens 20, 60 and 300
 * on both chains, /v1/messages came back clean 12 of 12, with proper
 * thinking+text block separation and stop_reason "end_turn". Recording the
 * disagreement rather than picking a winner — if it resurfaces, the block
 * separation is the thing to check.
 *
 * Credit: the andy session, which re-measured across budgets, then retracted
 * its own retraction with the three-way upstream probe, and the clawrouter
 * session, which nearly shipped a textual <tool_call> extractor for a model
 * that returns a clean structured tool_calls array once given room.
 */
export const FREE_PREFERENCE_ORDER: readonly string[] = [
  'nvidia/nemotron-3-nano-30b',     // Base only; 5/5 healthy, fastest
  FREE_DEFAULT_MODEL,               // both chains — the floor this never drops below
  'poolside/laguna-xs-2.1',         // Base only, different provider
  'cohere/north-mini-code',         // Base only, different provider; needs max_tokens >= 1200
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
  // Nothing is quarantined right now.
  //
  // llama-3.2-11b-vision was here until the gateway's image_url fix deployed
  // to Solana; it is now the free VISION model there (5/5 on a valid 64x64
  // PNG) and is reached through freeVisionModel(), not through the text
  // chain. It stays out of FREE_PREFERENCE_ORDER because it is the weakest
  // text model in the pool, which is a ranking, not a ban.
  //
  // nemotron-3.5-lightning and cohere/north-mini-code were both here on
  // measurement artifacts (see the TRUNCATION note above) and were released.
  // NOT quarantined, deliberately, though an earlier revision had them here:
  //   nvidia/nemotron-3.5-lightning — the "CoT leak" was max_tokens truncation.
  //     It is merely slow, which keeps it out of FREE_PREFERENCE_ORDER but is
  //     no reason to refuse to route to it if a user asks.
  //   cohere/north-mini-code — the "empty stream" was the same truncation, and
  //     it is a cascade rung other BlockRun components depend on.
  // See the MAX_TOKENS note in FREE_PREFERENCE_ORDER above.
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
 * The free model that can accept an image, or null when this chain has none.
 *
 * Chain-aware because the gateways are at different deploy states, not
 * because the models differ. The original defect was gateway-side: both
 * NVIDIA paths dropped every `image_url` unconditionally under a stale
 * comment, which is why it presented as a confident wrong answer with no
 * error. The allow-list fix reached Solana first.
 *
 * FOUR measurement passes, each of which reversed the previous conclusion.
 * The history stays because the reversals are the lesson:
 *
 *   1. 2x2 PNG, both ids fail.        INVALID — images under 10px per side
 *      are rejected upstream, so the fixture proved nothing.
 *   2. 64x64, 5 calls, llama 5/5 sol. Shipped. Too small a sample.
 *   3. 64x64, 10 calls, llama 5/10.   Reverted. A real bad window: the
 *      gateway fix was still settling. Fixture validated, so not a repeat
 *      of mistake 1.
 *   4. 64x64, 30 calls across both    RE-ENABLED. See below.
 *      HTTP paths and three runs.
 *
 * Pass 4, validated fixture (`sips` decodes it, and every PNG chunk CRC
 * checks against zlib.crc32 — `file` reports dimensions from the header and
 * will happily accept a corrupt image, which is how a broken fixture
 * masquerades as a broken product):
 *
 *   sol  llama-3.2-11b-vision  /v1/messages          10/10 sees, 0/10 substituted
 *   sol  llama-3.2-11b-vision  /chat/completions     10/10 sees, 0/10 substituted
 *   sol  llama-3.2-11b-vision  /v1/messages (repeat) 10/10 sees, 0/10 substituted
 *   base llama-3.2-11b-vision  /v1/messages           0/10 sees, 0/10 substituted
 *   sol  nemotron-3-nano-omni  /v1/messages           6/10 sees, 0/10 substituted
 *   sol  nemotron-3-nano-omni  /chat/completions      4/10 sees, 7/10 SUBSTITUTED
 *
 * So Solana gets llama-3.2-11b-vision and Base honestly reports none. On
 * Base the model serves itself and simply cannot see — 0 substitutions, so
 * this is the missing allow-list fix, not a cascade problem.
 *
 * nano-omni is NEVER used for vision despite its catalog tag. On
 * chat/completions it is substituted 7 times in 10 by nemotron-3-nano-30b,
 * a model with no vision at all (the andy session captured the same thing
 * 3/3), and even unsubstituted it only sees the image 6 times in 10.
 *
 * ACCEPTANCE BAR for changing any of this — all four are required, and each
 * one exists because skipping it produced a wrong answer above:
 *   - a fixture >=64x64 that a real decoder accepts and whose CRCs verify;
 *   - at least 10 calls (5 is inside the noise);
 *   - assert the served `model` echoes the id you requested;
 *   - assert the answer is actually right, not merely non-empty.
 *
 * AND YET THIS RETURNS NULL. Pass 5 measured the thing that actually
 * matters — the whole feature, end to end through the binary, not the API
 * call — and it is 1 in 5:
 *
 *   bare vision call, validated fixture   30/30
 *   end-to-end `franklin --model free`     1/5
 *
 * llama-3.2-11b-vision is reliable as a vision CALL and too weak to drive an
 * agent turn. Given the full tool set it re-called `Read` on the same path
 * until the repeat guard fired. Given no tools after the image was in
 * history (the one-shot path below, which is implemented and stays) it
 * stopped looping and instead ended the turn after `Read` without producing
 * an answer at all. So the blocker is no longer the gateway — it is
 * Franklin's own wiring, which hands a vision turn to a weak model by
 * swapping the AGENT model for the whole turn.
 *
 * A capability that works 30/30 in isolation and 1/5 in the product is not a
 * capability. By the rule this file already applies to nano-omni — an
 * intermittent confident wrong answer is worse than declining, because the
 * caller cannot tell which half they got — Franklin declines and says the
 * image was not seen.
 *
 * THE FIX, for whoever picks this up: do not swap the agent model. Make the
 * vision turn a dedicated one-shot side-call — inline the image, ask the
 * vision model directly, feed the answer back as context, and let the normal
 * agent model finish the turn. The 30/30 says that call will work. The
 * groundwork is in place: the one-shot tool suppression in agent/loop.ts
 * fires whenever this function returns a model.
 *
 * FRANKLIN_FREE_VISION_MODEL overrides ('none' disables), so the whole path
 * above can be exercised without a code change.
 */
export function freeVisionModel(): string | null {
  const override = process.env.FRANKLIN_FREE_VISION_MODEL;
  if (override) return override === 'none' ? null : override;
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
