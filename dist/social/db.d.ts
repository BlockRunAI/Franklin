/**
 * JSONL-backed dedup + reply log for Franklin's social subsystem.
 *
 * Deliberately avoids SQLite (no new native dep). Two files at:
 *
 *   ~/.blockrun/social-replies.jsonl    — append-only reply log
 *   ~/.blockrun/social-prekeys.jsonl    — append-only snippet-level dedup
 *
 * Both are read into memory at startup for O(1) lookups. At 30 replies/day
 * this hits 10K rows after a year — still <1MB, still fits in memory.
 *
 * Schema improvements over social-bot's bot/db.py:
 *   - `status: 'failed'` does NOT block retry (social-bot blacklists failures
 *     permanently, which breaks on transient network errors)
 *   - Pre-key dedup happens BEFORE LLM call, saving tokens on duplicates
 *   - Per-platform + per-handle scoping so running the bot with two accounts
 *     against the same DB doesn't cross-contaminate
 */
export type ReplyStatus = 'posted' | 'failed' | 'skipped' | 'drafted';
export type Platform = 'x' | 'reddit';
export interface ReplyRecord {
    platform: Platform;
    handle: string;
    post_url: string;
    post_title: string;
    post_snippet: string;
    reply_text: string;
    product?: string;
    status: ReplyStatus;
    error_msg?: string;
    cost_usd?: number;
    created_at: string;
}
export interface PreKeyRecord {
    platform: Platform;
    handle: string;
    pre_key: string;
    created_at: string;
}
/**
 * Compute a stable pre-key for a candidate post from its snippet fields.
 * Used BEFORE the LLM generates a reply so we can skip duplicates without
 * wasting any tokens.
 */
export declare function computePreKey(parts: {
    author?: string;
    snippet: string;
    time?: string;
}): string;
/**
 * Has this post been seen before (by pre-key)? If true, skip generation.
 */
export declare function hasPreKey(platform: Platform, handle: string, preKey: string): boolean;
/**
 * Commit a pre-key so we don't re-consider this post. Called after we've
 * decided to act on a post (either drafted, posted, or skipped by AI).
 */
export declare function commitPreKey(platform: Platform, handle: string, preKey: string): void;
/**
 * Has this canonical URL been successfully posted to before?
 *
 * Only counts status='posted' — unlike social-bot, we do NOT permanently
 * blacklist 'failed' attempts, so transient errors can be retried.
 */
export declare function hasPosted(platform: Platform, handle: string, postUrl: string): boolean;
/**
 * Count today's successful posts for a handle/platform (used for daily caps).
 */
export declare function countPostedToday(platform: Platform, handle: string): number;
/**
 * Append a reply record. Status can be 'drafted' (dry-run), 'posted',
 * 'failed' (transient, retry OK), or 'skipped' (AI returned SKIP).
 */
export declare function logReply(rec: Omit<ReplyRecord, 'created_at' | 'post_url'> & {
    post_url: string;
}): void;
/**
 * Stats summary for `franklin social stats`.
 */
export declare function getStats(platform?: Platform, handle?: string): {
    total: number;
    posted: number;
    failed: number;
    skipped: number;
    drafted: number;
    today: number;
    totalCost: number;
    byProduct: Record<string, number>;
};
/**
 * Canonicalise a URL for stable dedup keys:
 *   - lowercase host
 *   - strip trailing slash
 *   - strip tracking params (?s=, ?t=, utm_*)
 *   - x.com and twitter.com are aliases
 */
export declare function normaliseUrl(raw: string): string;
/**
 * Test helper — reset in-memory indexes so the next call re-reads from disk.
 * Not exported from the public API via index.ts.
 */
export declare function _resetForTest(): void;
