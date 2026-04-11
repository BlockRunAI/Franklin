/**
 * AI layer for Franklin's social subsystem.
 *
 * Two functions mirroring social-bot/bot/ai_engine.py:
 *   - detectProduct()   — keyword-score product router (no LLM, zero cost)
 *   - generateReply()   — calls Franklin's ModelClient for actual reply text
 *
 * Key improvements over social-bot:
 *   - Uses Franklin's multi-model router (tier-based: free / cheap / premium)
 *     instead of hardcoded Claude Sonnet for every call — throwaway replies
 *     can run on free NVIDIA models, high-value leads can escalate to Opus.
 *   - x402 payment flow handled by ModelClient — no Anthropic billing relationship.
 *   - SKIP detection lives in the caller so we can commit a 'skipped' record
 *     for visibility in stats.
 */
import type { ProductConfig, SocialConfig } from './config.js';
import type { Chain } from '../config.js';
export interface GenerateReplyOptions {
    post: {
        title: string;
        snippet: string;
        platform: 'x' | 'reddit';
    };
    product: ProductConfig;
    config: SocialConfig;
    model: string;
    apiUrl: string;
    chain: Chain;
    debug?: boolean;
}
export interface GenerateReplyResult {
    reply: string | null;
    raw: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    cost: number;
}
/**
 * Score each product by how many of its trigger_keywords appear in the post.
 * Returns the top-scoring product, or null if no product has any matches.
 *
 * Deterministic, zero-cost, debuggable. Social-bot uses the exact same
 * pattern and it's the right call for this stage — no need to pay an LLM
 * to ask "which of my products does this post mention".
 */
export declare function detectProduct(postText: string, products: ProductConfig[]): ProductConfig | null;
/**
 * Build the system prompt for a given product + style ruleset.
 */
export declare function buildSystemPrompt(product: ProductConfig, config: SocialConfig): string;
/**
 * Build the user prompt containing the post content.
 */
export declare function buildUserPrompt(post: GenerateReplyOptions['post']): string;
/**
 * Generate a reply via Franklin's ModelClient. Returns { reply: null } if
 * the model said SKIP or the output was too short to be useful.
 */
export declare function generateReply(opts: GenerateReplyOptions): Promise<GenerateReplyResult>;
