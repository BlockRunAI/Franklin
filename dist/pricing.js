/**
 * Single source of truth for model pricing (per 1M tokens).
 * Used by agent loop, proxy server, stats tracker, and router.
 */
export const MODEL_PRICING = {
    // Routing profiles (blended averages)
    'blockrun/auto': { input: 0.8, output: 4.0 },
    'blockrun/eco': { input: 0.2, output: 1.0 },
    'blockrun/premium': { input: 3.0, output: 15.0 },
    'blockrun/free': { input: 0, output: 0 },
    // FREE - NVIDIA models
    'nvidia/gpt-oss-120b': { input: 0, output: 0 },
    'nvidia/gpt-oss-20b': { input: 0, output: 0 },
    'nvidia/nemotron-ultra-253b': { input: 0, output: 0 },
    'nvidia/nemotron-3-super-120b': { input: 0, output: 0 },
    'nvidia/nemotron-super-49b': { input: 0, output: 0 },
    'nvidia/deepseek-v3.2': { input: 0, output: 0 },
    'nvidia/mistral-large-3-675b': { input: 0, output: 0 },
    'nvidia/qwen3-coder-480b': { input: 0, output: 0 },
    'nvidia/devstral-2-123b': { input: 0, output: 0 },
    'nvidia/glm-4.7': { input: 0, output: 0 },
    'nvidia/llama-4-maverick': { input: 0, output: 0 },
    // Anthropic
    'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0 },
    'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0 },
    'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0 },
    'anthropic/claude-haiku-4.5-20251001': { input: 1.0, output: 5.0 },
    // OpenAI
    'openai/gpt-5-nano': { input: 0.05, output: 0.4 },
    'openai/gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
    'openai/gpt-5-mini': { input: 0.25, output: 2.0 },
    'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'openai/gpt-5.2': { input: 1.75, output: 14.0 },
    'openai/gpt-5.3': { input: 1.75, output: 14.0 },
    'openai/gpt-5.3-codex': { input: 1.75, output: 14.0 },
    'openai/gpt-4.1': { input: 2.0, output: 8.0 },
    'openai/o3': { input: 2.0, output: 8.0 },
    'openai/gpt-4o': { input: 2.5, output: 10.0 },
    'openai/gpt-5.4': { input: 2.5, output: 15.0 },
    'openai/o1-mini': { input: 1.1, output: 4.4 },
    'openai/o3-mini': { input: 1.1, output: 4.4 },
    'openai/o4-mini': { input: 1.1, output: 4.4 },
    'openai/o1': { input: 15.0, output: 60.0 },
    'openai/gpt-5.2-pro': { input: 21.0, output: 168.0 },
    'openai/gpt-5.4-pro': { input: 30.0, output: 180.0 },
    // Google
    'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
    'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'google/gemini-3-flash-preview': { input: 0.5, output: 3.0 },
    'google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
    'google/gemini-3-pro-preview': { input: 2.0, output: 12.0 },
    'google/gemini-3.1-pro': { input: 2.0, output: 12.0 },
    // xAI
    'xai/grok-4-fast': { input: 0.2, output: 0.5 },
    'xai/grok-4-fast-reasoning': { input: 0.2, output: 0.5 },
    'xai/grok-4-1-fast': { input: 0.2, output: 0.5 },
    'xai/grok-4-1-fast-reasoning': { input: 0.2, output: 0.5 },
    'xai/grok-4-0709': { input: 0.2, output: 1.5 },
    'xai/grok-3-mini': { input: 0.3, output: 0.5 },
    'xai/grok-2-vision': { input: 2.0, output: 10.0 },
    'xai/grok-3': { input: 3.0, output: 15.0 },
    // DeepSeek
    'deepseek/deepseek-chat': { input: 0.28, output: 0.42 },
    'deepseek/deepseek-reasoner': { input: 0.28, output: 0.42 },
    // Minimax
    'minimax/minimax-m2.7': { input: 0.3, output: 1.2 },
    'minimax/minimax-m2.5': { input: 0.3, output: 1.2 },
    // Others
    'moonshot/kimi-k2.5': { input: 0.6, output: 3.0 },
    'nvidia/kimi-k2.5': { input: 0.55, output: 2.5 },
    // PROMOTION (active ~2026-04): flat $0.001/call. Normal pricing: input:1.00, output:3.20
    'zai/glm-5.1': { input: 0, output: 0, perCall: 0.001 },
    // PROMOTION (active ~2026-04): flat $0.001/call. Normal pricing: input:1.20, output:4.00
    'zai/glm-5.1-turbo': { input: 0, output: 0, perCall: 0.001 },
};
/** Opus pricing for savings calculations */
export const OPUS_PRICING = MODEL_PRICING['anthropic/claude-opus-4.6'];
/**
 * Estimate cost in USD for a request.
 * Falls back to $2/$10 per 1M for unknown models.
 * For per-call models (perCall > 0), uses flat per-call pricing instead of per-token.
 */
export function estimateCost(model, inputTokens, outputTokens, calls = 1) {
    const pricing = MODEL_PRICING[model] || { input: 2.0, output: 10.0 };
    if (pricing.perCall) {
        return pricing.perCall * calls;
    }
    return ((inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output);
}
