import { getModelCatalog, onModelCatalogChange } from './model-catalog.js';
/**
 * Single source of truth for model pricing (per 1M tokens).
 * Used by agent loop, proxy server, stats tracker, and router.
 */

/**
 * Per-1M list rates for one model. `platformFeePercent` is the fee the gateway
 * adds on top of the per-token list rates of a paid chat row (PF-8); it is
 * only ever set from a live catalog row, never typed here.
 */
export interface TokenPricing { input: number; output: number; perCall?: number; platformFeePercent?: number }

const LEGACY_PRICING: Record<string, TokenPricing> = {
  // Routing profiles (blended averages). Auto + Free are the only profiles
  // surfaced after the 2026-05-03 collapse; eco/premium were retired and
  // their parser mapping promotes them to Auto upstream of cost estimation.
  'blockrun/auto': { input: 0.8, output: 4.0 },
  'blockrun/free': { input: 0, output: 0 },
  // FREE — BlockRun gateway free tier (refreshed 2026-10-20 to match live
  // /api/v1/models, identical on Base and Solana). The routing order and
  // the reasoning behind it live in src/free-models.ts; this table only has to
  // price every id at $0 so no free call is ever reported as a charge.
  'nvidia/nemotron-3-ultra-550b': { input: 0, output: 0 },      // strongest free model, but 0/5 reachable — NOT the default
  'nvidia/nemotron-3.5-lightning': { input: 0, output: 0 },
  'nvidia/muse-glimmer-30b': { input: 0, output: 0 },           // Meta Muse Glimmer, free on NVIDIA since 2026-10-02
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { input: 0, output: 0 },
  'nvidia/llama-3.2-11b-vision': { input: 0, output: 0 },
  'cohere/north-mini-code': { input: 0, output: 0 },
  'poolside/laguna-xs-2.1': { input: 0, output: 0 },
  // Substituted free models: gone from /api/v1/models on 2026-08-30, but the
  // gateway still answers for them by serving a different model. Priced at $0
  // for legacy session-cost records — do NOT route to them.
  'nvidia/nemotron-nano-9b-v2': { input: 0, output: 0 },        // -> nemotron-3-nano-30b
  'nvidia/mistral-nemotron': { input: 0, output: 0 },           // -> nemotron-3-super-120b-a12b-free
  'nvidia/nemotron-nano-12b-v2-vl': { input: 0, output: 0 },    // -> nemotron-3-nano-omni
  'nvidia/step-3.7-flash': { input: 0, output: 0 },             // -> nemotron-3.5-lightning
  'nvidia/nemotron-3-super-120b-a12b-free': { input: 0, output: 0 }, // pool backing id, never listed
  'nvidia/nemotron-3-nano-30b': { input: 0, output: 0 },        // delisted 2026-09-08 (NVIDIA deprovisioned it)
  // Retired free models (kept at 0 for legacy session-cost records; gateway no
  // longer serves these — do NOT route to them).
  'nvidia/qwen3-next-80b-a3b-instruct': { input: 0, output: 0 }, // NVIDIA EOL 410, 2026-07-27
  'nvidia/qwen3.5-122b-a10b': { input: 0, output: 0 },
  'nvidia/seed-oss-36b': { input: 0, output: 0 },
  'nvidia/llama-4-maverick': { input: 0, output: 0 },
  'nvidia/mistral-large-3-675b': { input: 0, output: 0 },
  'nvidia/deepseek-v4-flash': { input: 0, output: 0 },
  'nvidia/glm-4.7': { input: 0, output: 0 },
  'nvidia/qwen3-next-80b-a3b-thinking': { input: 0, output: 0 },
  'nvidia/qwen3-coder-480b': { input: 0, output: 0 },
  'nvidia/mistral-small-4-119b': { input: 0, output: 0 },
  'nvidia/deepseek-v3.2': { input: 0, output: 0 },
  'nvidia/gpt-oss-120b': { input: 0, output: 0 },
  'nvidia/gpt-oss-20b': { input: 0, output: 0 },
  'nvidia/nemotron-ultra-253b': { input: 0, output: 0 },
  'nvidia/devstral-2-123b': { input: 0, output: 0 },
  'nvidia/nemotron-3-super-120b': { input: 0, output: 0 },
  'nvidia/nemotron-super-49b': { input: 0, output: 0 },
  // Anthropic
  // 2026-10 gateway additions (live /api/v1/models, 2026-10-02). Opus 5.5 and
  // Sonnet 5.5 come in BELOW the 5.0 line; Fable 5.1 holds Fable 5's price.
  'anthropic/claude-fable-5.1': { input: 10.0, output: 50.0 },
  'anthropic/claude-opus-5.5': { input: 4.0, output: 20.0 },
  'anthropic/claude-sonnet-5.5': { input: 2.0, output: 10.0 },
  'anthropic/claude-fable-5': { input: 10.0, output: 50.0 }, // Mythos-class tier above Opus, 1M ctx
  // Opus 5 lands at the same $5/$25 as the 4.x Opus line — a straight upgrade
  // with no cost delta, so nothing downstream needs a pricing carve-out.
  'anthropic/claude-opus-5': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.8': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.7': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.5': { input: 5.0, output: 25.0 },
  'anthropic/claude-sonnet-5': { input: 2.0, output: 10.0 }, // near-Opus at Sonnet cost, 1M ctx (live list 2026-10-02)
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'anthropic/claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0 },
  // Retired 2026-07-14: the gateway 400s on the dated id (undated is canonical).
  // Kept for cost lookup on sessions recorded before the switch.
  'anthropic/claude-haiku-4.5-20251001': { input: 1.0, output: 5.0 },
  // OpenAI
  // GPT-6 family + GPT-5.1 (live catalog 2026-10-02). Base rates only: GPT-6
  // bills 2x input / 1.5x output above 272K input tokens, which a flat
  // per-1M table cannot express — the catalog's long_context tiers carry that.
  'openai/gpt-6-astra': { input: 10.0, output: 50.0 },
  'openai/gpt-6-sol': { input: 2.0, output: 10.0 },
  'openai/gpt-6.1-sol': { input: 2.0, output: 10.0 }, // refreshed Sol, live 2026-10-20 (same base rate as 6 Sol)
  'openai/gpt-6.2-sol': { input: 2.0, output: 10.0 }, // live 2026-11-27 — gpt-5.5 / gpt-5.4's successor in the router
  'openai/gpt-6-luna': { input: 0.1, output: 0.5 },
  'openai/gpt-5.1': { input: 1.25, output: 10.0 },
  'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.0 }, // retires 2026-12-11 — the gateway then serves (and bills) gpt-5.6-luna
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  // OpenAI's 2026-07-30 GPT-5.6 price cut, passed through by the gateway
  // (base #326) — mirrored here 2026-08-12.
  'openai/gpt-5.6-luna': { input: 0.2, output: 1.2 }, // cost-efficient GPT-5.6 tier, 1M ctx
  'openai/gpt-5.2': { input: 1.75, output: 14.0 },
  'openai/gpt-5.3': { input: 1.75, output: 14.0 },
  'openai/gpt-5.3-codex': { input: 1.75, output: 14.0 },
  'openai/gpt-4.1': { input: 2.0, output: 8.0 },
  'openai/o3': { input: 2.0, output: 8.0 }, // retires 2026-12-11 — the gateway then serves (and bills) gpt-5.4-mini
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-5.4': { input: 2.5, output: 15.0 },
  'openai/gpt-5.6-terra': { input: 2.0, output: 12.0 }, // balanced GPT-5.6 tier, 1M ctx (2026-07-30 cut)
  // Retired by OpenAI 2026-10-23. The gateway redirects each to gpt-5.4-mini
  // BEFORE pricing (blockrun model-redirects.ts, DEAD_PAID_REDIRECTS), so a
  // pinned call is billed gpt-5.4-mini's rate — the same "served as" rule the
  // retired Grok ids below follow. Kept so the id still prices.
  'openai/o3-mini': { input: 0.75, output: 4.5 }, // served as gpt-5.4-mini (was $1.10/$4.40)
  'openai/o4-mini': { input: 0.75, output: 4.5 }, // served as gpt-5.4-mini (was $1.10/$4.40)
  'openai/o1': { input: 0.75, output: 4.5 }, // served as gpt-5.4-mini (was $15/$60)
  'openai/gpt-5.5': { input: 5.0, output: 30.0 },
  'openai/gpt-5.6-sol': { input: 4.0, output: 20.0 }, // GPT-5.6 flagship, 1M ctx — cut from $5/$30 on 2026-08-21
  // GPT-5.6 Pro tiers + 5.5 Pro + chat-latest, added upstream 2026-08-03
  // (base #329) — priced from the live catalog 2026-08-12.
  'openai/gpt-5.6-luna-pro': { input: 0.2, output: 1.2 }, // = Luna list (live 2026-10-02)
  'openai/gpt-5.6-terra-pro': { input: 2.0, output: 12.0 }, // = Terra list (live 2026-10-02)
  'openai/gpt-5.6-sol-pro': { input: 4.0, output: 20.0 }, // cut from $5/$30 on 2026-08-21
  'openai/gpt-5.5-pro': { input: 30.0, output: 180.0 },
  'openai/chat-latest': { input: 5.0, output: 30.0 },
  'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
  'openai/gpt-5.4-pro': { input: 30.0, output: 180.0 },
  // Google
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 }, // retires 2026-12-01 — the gateway then serves gemini-3.5-flash-lite (same price)
  'google/gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  // Retired 2026-11-24: Google has served 3.6 Flash under this name since
  // ~2026-10-10, and the gateway now redirects the id to gemini-3.6-flash
  // BEFORE pricing (DEAD_PAID_REDIRECTS) — a pinned call bills 3.6's rate.
  'google/gemini-3.5-flash': { input: 0.75, output: 3.75 }, // served as gemini-3.6-flash (was $1.50/$9)
  'google/gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'google/gemini-3.6-flash': { input: 0.75, output: 3.75 }, // added upstream 2026-08-03 (base #329); live promo rate 2026-10-02
  'google/gemini-3.8-flash': { input: 0.75, output: 3.75 }, // live 2026-10-20
  'google/gemini-2.5-pro': { input: 1.25, output: 10.0 }, // retires 2026-12-01 — the gateway then serves (and bills) gemini-3.8-flash
  'google/gemini-3.1-pro': { input: 2.0, output: 12.0 },
  // Gemini 4 Argon (live 2026-10-20) and Carbon (live 2026-11-11), both
  // chains. Google's $2/$10 intro rate ended 2026-11-30; both are $4/$20 from
  // 2026-12-01, and the gateway reprices them that day.
  'google/gemini-4-argon': { input: 4.0, output: 20.0 },
  'google/gemini-4-carbon': { input: 4.0, output: 20.0 },
  // xAI
  'xai/grok-4.3': { input: 1.25, output: 2.5 },        // 1M ctx; demoted from flagship 2026-07-14
  'xai/grok-4.7': { input: 2.0, output: 6.0 },        // newest Grok, 500K ctx (2x at >=200K input)
  'xai/grok-4.6': { input: 2.0, output: 6.0 },        // 500K ctx (2x at >=200K input)
  'xai/grok-4.5': { input: 2.0, output: 6.0 },        // 500K ctx (note: less than 4.3's 1M)
  'xai/grok-build-0.1': { input: 1.0, output: 2.0 },  // agentic coding, OpenRouter resale
  // DeepSeek (gateway re-aliased these to V4 Flash on 2026-05-03; price cut
  // again upstream 2026-08-07 to $0.14/$0.28 — mirrored here 2026-08-12).
  'deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek/deepseek-reasoner': { input: 0.14, output: 0.28 },
  // V4.1 Flash — live on Base 2026-10-20; the same model and price as deepseek-chat.
  'deepseek/deepseek-v4.1-flash': { input: 0.14, output: 0.28 },
  // V4 Pro (1.6T MoE / 49B active, 1M ctx, 65K out). Live list 2026-10-02;
  // the old $0.435/$0.87 promo figure no longer matches the gateway.
  'deepseek/deepseek-v4-pro': { input: 1.32, output: 3.96 },
  // V4 Flash Vision (experimental): the image-capable DeepSeek SKU, live 2026-10-20.
  'deepseek/deepseek-v4-flash-vision-exp': { input: 0.3, output: 1.2 },
  // Minimax
  'minimax/minimax-m3': { input: 0.3, output: 1.2 },
  'minimax/minimax-m2.7': { input: 0.3, output: 1.2 },
  // Qwen — Plus/Flash tiers added upstream 2026-08-03 (base #329).
  'qwen/qwen3.7-max': { input: 1.475, output: 4.425 },
  'qwen/qwen3.7-plus': { input: 0.32, output: 1.28 },
  'qwen/qwen3.7-flash': { input: 0.03, output: 0.13 },
  // Qwen 3.8 — live 2026-10-20. Flash is the vision-capable one.
  'qwen/qwen3.8-max': { input: 2.0, output: 6.0 },
  'qwen/qwen3.8-flash': { input: 0.15, output: 0.47 },
  // New providers added upstream 2026-08 — priced from the live catalog.
  'tencent/hy3': { input: 0.132, output: 0.528 }, // retired 2026-09-24 (gateway redirects to qwen3.7-flash) — kept for session-cost records
  'tencent/hy4-preview': { input: 0.834, output: 2.501 }, // live 2026-10-20 — Tencent's current model
  'xiaomi/mimo-v2.5-pro': { input: 0.435, output: 0.87 },
  'xiaomi/mimo-v2.5': { input: 0.14, output: 0.28 }, // live 2026-10-20 — vision-capable, cheaper than Pro
  // Mistral + Poolside paid tiers — live 2026-10-20.
  'mistral/mistral-large-4': { input: 1.36, output: 4.18 },
  'poolside/laguna-s-2.1': { input: 0.09, output: 0.18 }, // paid sibling of the free laguna-xs-2.1
  // Moonshot — K3 is the gateway flagship (2026-07): 2.8T open MoE, 1M
  // context, multimodal (image+text), returns reasoning_content. Pricier
  // than the K2.x line it replaced ($3/$15 vs K2.7's $0.95/$4).
  'moonshot/kimi-k3': { input: 3.0, output: 15.0 },
  // PROMOTION (active ~2026-04): flat $0.001/call for all GLM models
  'zai/glm-5': { input: 1.0, output: 3.2 }, // flat promo ended 2026-06-06; raised upstream 2026-08-07
  'zai/glm-5.1': { input: 1.40, output: 4.40 }, // launch promo ended 2026-06-05 — per-token now
  'zai/glm-5.2': { input: 1.40, output: 4.40 }, // new flagship 2026-06 — 1M context, same per-token price as 5.1
  'zai/glm-5.3': { input: 1.40, output: 4.40 }, // flagship 2026-08 — 1M context, always-on reasoning, priced at 5.2
  // GLM-5.3 Flash (catalog 2026-08-29): 1M context, vision, reasoning — the
  // only GLM SKU tagged multimodal, at roughly a tenth of the flagship price.
  'zai/glm-5.3-flash': { input: 0.15, output: 0.5 },
  'zai/glm-5-turbo': { input: 1.2, output: 4.0 }, // flat promo ended 2026-06-06 — per-token now

  // ── Hidden from /v1/models, still served ──
  // None of these appear in GET /v1/models any more, but the gateway still
  // routes and CHARGES for them: on 2026-08-29 every id marked (probed) below
  // was called through the binary and answered. So they stay priced at list
  // — a pinned `/model opus-4.6` or a router chain that still names one must
  // cost correctly — and the picker keeps their shortcuts. The unmarked ids
  // were not re-probed; they are kept so session-cost records written while
  // they were live still price. The router's kill-switch
  // (src/router/index.ts, markModelUnavailable) is what retires an id from
  // routing, and it fires on a real 400/404/410, never on catalog absence.
  'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0 }, // (probed) superseded by 4.7 / 4.8 / 5 at the same price
  'openai/gpt-5-nano': { input: 0.05, output: 0.4 }, // (probed)
  'openai/o1-mini': { input: 0.75, output: 4.5 }, // served as gpt-5.4-mini (redirected, DEAD_PAID_REDIRECTS)
  'google/gemini-3-pro-preview': { input: 2.0, output: 12.0 }, // GA'd as gemini-3.1-pro
  // Retired at xAI. The gateway pins every retired Grok slug to grok-4.3 and
  // bills grok-4.3's $1.25/$2.50 (blockrun models.ts + model-maps.ts
  // "Retired -> grok-4.3", repriced 2026-09-07/09). The old per-id list
  // prices here overstated grok-3 / grok-4-0709 by 2.4x/6x and understated
  // the fast family, so they now carry what the gateway actually charges.
  'xai/grok-4-fast': { input: 0.2, output: 0.5 }, // not in the gateway catalog — historical only
  'xai/grok-4-fast-reasoning': { input: 1.25, output: 2.5 }, // served as grok-4.3
  'xai/grok-4-1-fast': { input: 0.2, output: 0.5 }, // not in the gateway catalog — historical only
  'xai/grok-4-1-fast-reasoning': { input: 1.25, output: 2.5 }, // served as grok-4.3
  // The two non-reasoning ids sit in the shared Router's SIMPLE chains and
  // were charged, yet once had no row here — Franklin reported them as $0
  // and the portfolio scorer, which treats an unpriced id as infinitely
  // expensive, could never pick them over a priced rung.
  'xai/grok-4-1-fast-non-reasoning': { input: 1.25, output: 2.5 }, // served as grok-4.3
  'xai/grok-4-fast-non-reasoning': { input: 1.25, output: 2.5 }, // served as grok-4.3
  'xai/grok-4-0709': { input: 1.25, output: 2.5 }, // served as grok-4.3 (was $3/$15)
  'xai/grok-3-mini': { input: 1.25, output: 2.5 }, // served as grok-4.3
  'xai/grok-2-vision': { input: 1.25, output: 2.5 }, // served as grok-4.3
  'xai/grok-3': { input: 1.25, output: 2.5 }, // served as grok-4.3 (was $3/$15)
  'minimax/minimax-m2.5': { input: 0.3, output: 1.2 },
  // K2.x (probed): the bare `kimi`/`k2.*` shortcuts resolve to K3, the
  // explicit ids still answer.
  'moonshot/kimi-k2.7': { input: 0.95, output: 4.0 },
  'moonshot/kimi-k2.6': { input: 0.95, output: 4.0 },
  'moonshot/kimi-k2.5': { input: 0.6, output: 3.0 },
  'nvidia/kimi-k2.5': { input: 0.6, output: 3.0 }, // gateway list (falls back to moonshot/kimi-k2.5, same price)
  'zai/glm-5.1-turbo': { input: 1.2, output: 4.0 }, // was a client alias for zai/glm-5-turbo
};

export function hasHistoricalPrice(model: string): boolean { return model in LEGACY_PRICING; }

const isFeePercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The platform fee (percent) a gateway /v1/models row charges on top of its
 * per-token list rates (blockrun specs/2026-11-16-chat-platform-fee.md PF-8).
 *
 * Read from `pricing.platform_fee_percent` first (the shape Solana publishes
 * and Base publishes too), then from the row's top-level
 * `platform_fee_percent` (Base also publishes it there). Absent or malformed
 * means 0: older gateways and enterprise (PF-9) do not send the field, and
 * enterprise really does charge none. Only `billing_mode: 'paid'` rows carry
 * the fee: free, flat and media rows return 0 even if a field is present,
 * because their published price is already final.
 */
export function platformFeePercent(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const r = row as { billing_mode?: unknown; pricing?: unknown; platform_fee_percent?: unknown };
  if (r.billing_mode !== 'paid') return 0;
  const nested = r.pricing && typeof r.pricing === 'object'
    ? (r.pricing as { platform_fee_percent?: unknown }).platform_fee_percent
    : undefined;
  if (isFeePercent(nested)) return nested;
  if (isFeePercent(r.platform_fee_percent)) return r.platform_fee_percent;
  return 0;
}

/** Multiplier for per-token chat cost: 1 + platformFeePercent/100 (1 when absent). */
export function platformFeeFactor(pricing: Pick<TokenPricing, 'platformFeePercent'>): number {
  const fee = pricing.platformFeePercent;
  return isFeePercent(fee) ? 1 + fee / 100 : 1;
}

/** Per-token chat cost in USD: list rates x tokens, times the platform fee factor. */
export function tokenCostUsd(pricing: TokenPricing, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  ) * platformFeeFactor(pricing);
}

/** Gateway prices override historical fallbacks without replacing map identities. */
export const MODEL_PRICING: Record<string, TokenPricing> = {};
export const OPUS_PRICING: TokenPricing = { input: 5, output: 25 };
function updatePrices(state: ReturnType<typeof getModelCatalog>): void {
  for (const key of Object.keys(MODEL_PRICING)) delete MODEL_PRICING[key];
  Object.assign(MODEL_PRICING, LEGACY_PRICING, state.pricing);
  // The catalog's projected `pricing` keeps only input/output, so the fee is
  // carried over from the full row. Bundled-snapshot rows and the historical
  // table above carry no fee field and so price at 0 (see platformFeePercent).
  for (const row of state.models) {
    const fee = platformFeePercent(row);
    const price = MODEL_PRICING[row.id];
    if (fee > 0 && price && price.perCall === undefined) {
      MODEL_PRICING[row.id] = { ...price, platformFeePercent: fee };
    }
  }
  const opus = MODEL_PRICING['anthropic/claude-opus-5'];
  // Reset the fee first so a refresh without the field does not keep a stale one.
  if (opus) Object.assign(OPUS_PRICING, { platformFeePercent: undefined }, opus);
}
updatePrices(getModelCatalog());
onModelCatalogChange(updatePrices);

/**
 * Estimate cost in USD for a request.
 * Unknown models price at 0 (see below).
 * For per-call models (perCall > 0), uses flat per-call pricing instead of per-token.
 * Per-token models include the row's platform fee (PF-8). The flat
 * per-transaction fee is not added here: callers use this only when no x402
 * charge was observed (see agent/loop.ts), and the real charge is preferred.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  calls = 1
): number {
  // Unknown models: assume free (0). Prevents false cost accumulation in the UI
  // for models not yet listed — better to under-estimate than scare users with
  // fake charges. Real on-chain charges are tracked separately in cost_log.jsonl.
  const pricing = MODEL_PRICING[model] || { input: 0, output: 0 };
  if (pricing.perCall) {
    return pricing.perCall * calls;
  }
  return tokenCostUsd(pricing, inputTokens, outputTokens);
}
