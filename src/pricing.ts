/**
 * Single source of truth for model pricing (per 1M tokens).
 * Used by agent loop, proxy server, stats tracker, and router.
 */

export const MODEL_PRICING: Record<string, { input: number; output: number; perCall?: number }> = {
  // Routing profiles (blended averages). Auto + Free are the only profiles
  // surfaced after the 2026-05-03 collapse; eco/premium were retired and
  // their parser mapping promotes them to Auto upstream of cost estimation.
  'blockrun/auto': { input: 0.8, output: 4.0 },
  'blockrun/free': { input: 0, output: 0 },
  // FREE — BlockRun gateway free tier (refreshed 2026-08-12 to match live
  // /api/v1/models). nemotron-nano-9b-v2 is the current free default — the
  // one free model that verifiably serves itself on the streaming path
  // (mistral-nemotron is DEGRADED upstream: stream calls 400, non-stream
  // rides a disclosed gateway fallback).
  'nvidia/nemotron-nano-9b-v2': { input: 0, output: 0 },
  'nvidia/mistral-nemotron': { input: 0, output: 0 },
  'nvidia/nemotron-nano-12b-v2-vl': { input: 0, output: 0 },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { input: 0, output: 0 },
  'nvidia/step-3.7-flash': { input: 0, output: 0 },
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
  'anthropic/claude-fable-5': { input: 10.0, output: 50.0 }, // Mythos-class tier above Opus, 1M ctx
  // Opus 5 lands at the same $5/$25 as the 4.x Opus line — a straight upgrade
  // with no cost delta, so nothing downstream needs a pricing carve-out.
  'anthropic/claude-opus-5': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.8': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.7': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0 },
  'anthropic/claude-opus-4.5': { input: 5.0, output: 25.0 },
  'anthropic/claude-sonnet-5': { input: 3.0, output: 15.0 }, // near-Opus at Sonnet cost, 1M ctx
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'anthropic/claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0 },
  // Retired 2026-07-14: the gateway 400s on the dated id (undated is canonical).
  // Kept for cost lookup on sessions recorded before the switch.
  'anthropic/claude-haiku-4.5-20251001': { input: 1.0, output: 5.0 },
  // OpenAI
  'openai/gpt-5-nano': { input: 0.05, output: 0.4 },
  'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.0 },
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  // OpenAI's 2026-07-30 GPT-5.6 price cut, passed through by the gateway
  // (base #326) — mirrored here 2026-08-12.
  'openai/gpt-5.6-luna': { input: 0.2, output: 1.2 }, // cost-efficient GPT-5.6 tier, 1M ctx
  'openai/gpt-5.2': { input: 1.75, output: 14.0 },
  'openai/gpt-5.3': { input: 1.75, output: 14.0 },
  'openai/gpt-5.3-codex': { input: 1.75, output: 14.0 },
  'openai/gpt-4.1': { input: 2.0, output: 8.0 },
  'openai/o3': { input: 2.0, output: 8.0 },
  'openai/gpt-4o': { input: 2.5, output: 10.0 },
  'openai/gpt-5.4': { input: 2.5, output: 15.0 },
  'openai/gpt-5.6-terra': { input: 2.0, output: 12.0 }, // balanced GPT-5.6 tier, 1M ctx (2026-07-30 cut)
  'openai/o1-mini': { input: 1.1, output: 4.4 },
  'openai/o3-mini': { input: 1.1, output: 4.4 },
  'openai/o4-mini': { input: 1.1, output: 4.4 },
  'openai/o1': { input: 15.0, output: 60.0 },
  'openai/gpt-5.5': { input: 5.0, output: 30.0 },
  'openai/gpt-5.6-sol': { input: 5.0, output: 30.0 }, // GPT-5.6 flagship, deepest reasoning, 1M ctx
  // GPT-5.6 Pro tiers + 5.5 Pro + chat-latest, added upstream 2026-08-03
  // (base #329) — priced from the live catalog 2026-08-12.
  'openai/gpt-5.6-luna-pro': { input: 0.1, output: 0.6 },
  'openai/gpt-5.6-terra-pro': { input: 1.0, output: 6.0 },
  'openai/gpt-5.6-sol-pro': { input: 5.0, output: 30.0 },
  'openai/gpt-5.5-pro': { input: 30.0, output: 180.0 },
  'openai/chat-latest': { input: 5.0, output: 30.0 },
  'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
  'openai/gpt-5.4-pro': { input: 30.0, output: 180.0 },
  // Google
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'google/gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  // 2026-08-12 sync: the gateway was billing gemini-3.5-flash at 1/3 of
  // Google's rate and corrected upstream (base #304) — mirror the real price.
  'google/gemini-3.5-flash': { input: 1.5, output: 9.0 }, // latest Flash w/ thinking, 1M ctx
  'google/gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'google/gemini-3.6-flash': { input: 1.5, output: 7.5 }, // added upstream 2026-08-03 (base #329)
  'google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'google/gemini-3-pro-preview': { input: 2.0, output: 12.0 },
  'google/gemini-3.1-pro': { input: 2.0, output: 12.0 },
  // xAI
  'xai/grok-4-fast': { input: 0.2, output: 0.5 },
  'xai/grok-4-fast-reasoning': { input: 0.2, output: 0.5 },
  'xai/grok-4-1-fast': { input: 0.2, output: 0.5 },
  'xai/grok-4-1-fast-reasoning': { input: 0.2, output: 0.5 },
  'xai/grok-4-0709': { input: 3.0, output: 15.0 }, // gateway lists $3/$15 (was mispriced here at $0.2/$1.5)
  'xai/grok-3-mini': { input: 0.3, output: 0.5 },
  'xai/grok-2-vision': { input: 2.0, output: 10.0 },
  'xai/grok-3': { input: 3.0, output: 15.0 },
  'xai/grok-4.3': { input: 1.5, output: 4.0 },        // 1M ctx; demoted from flagship 2026-07-14
  'xai/grok-4.5': { input: 2.5, output: 9.0 },        // xAI flagship — 500K ctx (note: less than 4.3's 1M)
  'xai/grok-build-0.1': { input: 1.5, output: 3.0 },  // agentic coding, OpenRouter resale
  // DeepSeek (gateway re-aliased these to V4 Flash on 2026-05-03; price cut
  // again upstream 2026-08-07 to $0.14/$0.28 — mirrored here 2026-08-12).
  'deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek/deepseek-reasoner': { input: 0.14, output: 0.28 },
  // V4 Pro (1.6T MoE / 49B active, 1M ctx, 65K out). 75% launch promo
  // through 2026-05-31 — list is $2.00/$4.00, promo is $0.50/$1.00.
  'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87 }, // 75% promo became permanent list after 2026-05-31
  // Minimax
  'minimax/minimax-m3': { input: 0.3, output: 1.2 },
  'minimax/minimax-m2.7': { input: 0.3, output: 1.2 },
  'minimax/minimax-m2.5': { input: 0.3, output: 1.2 },
  // Qwen — Plus/Flash tiers added upstream 2026-08-03 (base #329).
  'qwen/qwen3.7-max': { input: 1.475, output: 4.425 },
  'qwen/qwen3.7-plus': { input: 0.32, output: 1.28 },
  'qwen/qwen3.7-flash': { input: 0.03, output: 0.13 },
  // New providers added upstream 2026-08 — priced from the live catalog.
  'tencent/hy3': { input: 0.132, output: 0.528 },
  'xiaomi/mimo-v2.5-pro': { input: 0.435, output: 0.87 },
  // Moonshot — K3 is the gateway flagship (2026-07): 2.8T open MoE, 1M
  // context, multimodal (image+text), returns reasoning_content. Pricier
  // than the K2.x line it replaced ($3/$15 vs K2.7's $0.95/$4).
  'moonshot/kimi-k3': { input: 3.0, output: 15.0 },
  // Retired K2.x line (kept for legacy session-cost records; the gateway no
  // longer serves these and the `kimi`/`k2.*` shortcuts now resolve to K3).
  'moonshot/kimi-k2.7': { input: 0.95, output: 4.0 },
  'moonshot/kimi-k2.6': { input: 0.95, output: 4.0 },
  'moonshot/kimi-k2.5': { input: 0.6, output: 3.0 },
  'nvidia/kimi-k2.5': { input: 0.55, output: 2.5 },
  // PROMOTION (active ~2026-04): flat $0.001/call for all GLM models
  'zai/glm-5': { input: 1.0, output: 3.2 }, // flat promo ended 2026-06-06; raised upstream 2026-08-07
  'zai/glm-5.1': { input: 1.40, output: 4.40 }, // launch promo ended 2026-06-05 — per-token now
  'zai/glm-5.2': { input: 1.40, output: 4.40 }, // new flagship 2026-06 — 1M context, same per-token price as 5.1
  'zai/glm-5-turbo': { input: 1.2, output: 4.0 }, // flat promo ended 2026-06-06 — per-token now
  'zai/glm-5.1-turbo': { input: 1.2, output: 4.0 },  // client alias for zai/glm-5-turbo
};

/** Opus pricing for savings calculations — tracks the current flagship. */
export const OPUS_PRICING = MODEL_PRICING['anthropic/claude-opus-5'];

/**
 * Estimate cost in USD for a request.
 * Falls back to $2/$10 per 1M for unknown models.
 * For per-call models (perCall > 0), uses flat per-call pricing instead of per-token.
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
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}
