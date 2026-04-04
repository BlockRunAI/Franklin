/**
 * Single source of truth for model pricing (per 1M tokens).
 * Used by agent loop, proxy server, stats tracker, and router.
 */
export declare const MODEL_PRICING: Record<string, {
    input: number;
    output: number;
}>;
/** Opus pricing for savings calculations */
export declare const OPUS_PRICING: {
    input: number;
    output: number;
};
/**
 * Estimate cost in USD for a request.
 * Falls back to $2/$10 per 1M for unknown models.
 */
export declare function estimateCost(model: string, inputTokens: number, outputTokens: number): number;
