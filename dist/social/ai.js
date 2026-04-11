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
import { ModelClient } from '../agent/llm.js';
import { estimateCost } from '../pricing.js';
/**
 * Score each product by how many of its trigger_keywords appear in the post.
 * Returns the top-scoring product, or null if no product has any matches.
 *
 * Deterministic, zero-cost, debuggable. Social-bot uses the exact same
 * pattern and it's the right call for this stage — no need to pay an LLM
 * to ask "which of my products does this post mention".
 */
export function detectProduct(postText, products) {
    if (products.length === 0)
        return null;
    const text = postText.toLowerCase();
    let best = null;
    for (const p of products) {
        let score = 0;
        for (const kw of p.trigger_keywords) {
            if (text.includes(kw.toLowerCase()))
                score++;
        }
        if (!best || score > best.score) {
            best = { product: p, score };
        }
    }
    return best && best.score > 0 ? best.product : null;
}
/**
 * Build the system prompt for a given product + style ruleset.
 */
export function buildSystemPrompt(product, config) {
    const rules = config.reply_style.rules.map((r) => `- ${r}`).join('\n');
    return (`You are replying on behalf of the maker of "${product.name}".\n\n` +
        `Product description:\n${product.description}\n\n` +
        `Reply style rules:\n${rules}\n\n` +
        `You are hands-on, experienced, and speak from lived reality. ` +
        `You never sound like a marketer. You do not use emojis or hashtags. ` +
        `If the post is not a good fit for the product, reply with exactly: SKIP`);
}
/**
 * Build the user prompt containing the post content.
 */
export function buildUserPrompt(post) {
    return (`Platform: ${post.platform}\n` +
        `Post title: ${post.title.slice(0, 200)}\n\n` +
        `Post content:\n${post.snippet.slice(0, 800)}\n\n` +
        `Write a reply following the rules in the system prompt. ` +
        `If the post is not relevant to the product, respond with SKIP only.`);
}
/**
 * Generate a reply via Franklin's ModelClient. Returns { reply: null } if
 * the model said SKIP or the output was too short to be useful.
 */
export async function generateReply(opts) {
    const system = buildSystemPrompt(opts.product, opts.config);
    const user = buildUserPrompt(opts.post);
    const maxLen = opts.config.x.max_length;
    const client = new ModelClient({
        apiUrl: opts.apiUrl,
        chain: opts.chain,
        debug: opts.debug,
    });
    const result = await client.complete({
        model: opts.model,
        messages: [{ role: 'user', content: user }],
        system,
        max_tokens: 400,
        stream: true,
        temperature: 0.7,
    });
    // Extract the text from content parts
    const text = result.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('')
        .trim();
    const cost = estimateCost(opts.model, result.usage.inputTokens, result.usage.outputTokens, 1);
    // SKIP detection — model may say "SKIP", "SKIP." or short/empty
    if (!text || text.toUpperCase().startsWith('SKIP') || text.length < 20) {
        return { reply: null, raw: text, usage: result.usage, cost };
    }
    // Trim to max length with a small buffer
    let reply = text;
    if (reply.length > maxLen + 50) {
        reply = reply.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
    }
    return { reply, raw: text, usage: result.usage, cost };
}
