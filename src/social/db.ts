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

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const STORE_DIR = path.join(os.homedir(), '.blockrun');
const REPLIES_PATH = path.join(STORE_DIR, 'social-replies.jsonl');
const PREKEYS_PATH = path.join(STORE_DIR, 'social-prekeys.jsonl');

export type ReplyStatus = 'posted' | 'failed' | 'skipped' | 'drafted';
export type Platform = 'x' | 'reddit';

export interface ReplyRecord {
  platform: Platform;
  handle: string;            // the account posting the reply (for multi-account scoping)
  post_url: string;          // canonical URL
  post_title: string;
  post_snippet: string;
  reply_text: string;
  product?: string;          // which product persona was used
  status: ReplyStatus;
  error_msg?: string;
  cost_usd?: number;         // LLM cost for generation
  created_at: string;        // ISO
}

export interface PreKeyRecord {
  platform: Platform;
  handle: string;
  pre_key: string;           // hash(author+snippet[0:80]+time)
  created_at: string;
}

// ─── In-memory indexes, loaded lazily on first use ─────────────────────────

let repliesLoaded = false;
let replies: ReplyRecord[] = [];
let repliesByUrl = new Map<string, ReplyRecord[]>();   // canonical URL → records
let repliesToday = new Map<string, number>();          // handle:platform:date → count

let preKeysLoaded = false;
let preKeysSet = new Set<string>();                     // composite key for O(1) lookup

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function loadReplies(): void {
  if (repliesLoaded) return;
  ensureDir();
  replies = [];
  repliesByUrl.clear();
  repliesToday.clear();
  if (fs.existsSync(REPLIES_PATH)) {
    const text = fs.readFileSync(REPLIES_PATH, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ReplyRecord;
        replies.push(rec);
        const list = repliesByUrl.get(rec.post_url) ?? [];
        list.push(rec);
        repliesByUrl.set(rec.post_url, list);
        if (rec.status === 'posted') {
          const dayKey = `${rec.handle}:${rec.platform}:${rec.created_at.slice(0, 10)}`;
          repliesToday.set(dayKey, (repliesToday.get(dayKey) ?? 0) + 1);
        }
      } catch {
        // Skip malformed lines — append-only file may have a partial last line
      }
    }
  }
  repliesLoaded = true;
}

function loadPreKeys(): void {
  if (preKeysLoaded) return;
  ensureDir();
  preKeysSet.clear();
  if (fs.existsSync(PREKEYS_PATH)) {
    const text = fs.readFileSync(PREKEYS_PATH, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as PreKeyRecord;
        preKeysSet.add(compositePreKey(rec.platform, rec.handle, rec.pre_key));
      } catch {
        // Skip malformed lines
      }
    }
  }
  preKeysLoaded = true;
}

function compositePreKey(platform: Platform, handle: string, preKey: string): string {
  return `${platform}|${handle}|${preKey}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Compute a stable pre-key for a candidate post from its snippet fields.
 * Used BEFORE the LLM generates a reply so we can skip duplicates without
 * wasting any tokens.
 */
export function computePreKey(parts: {
  author?: string;
  snippet: string;
  time?: string;
}): string {
  const normalised =
    (parts.author ?? '').trim().toLowerCase() + '|' +
    parts.snippet.trim().slice(0, 80).toLowerCase() + '|' +
    (parts.time ?? '').trim();
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * Has this post been seen before (by pre-key)? If true, skip generation.
 */
export function hasPreKey(platform: Platform, handle: string, preKey: string): boolean {
  loadPreKeys();
  return preKeysSet.has(compositePreKey(platform, handle, preKey));
}

/**
 * Commit a pre-key so we don't re-consider this post. Called after we've
 * decided to act on a post (either drafted, posted, or skipped by AI).
 */
export function commitPreKey(platform: Platform, handle: string, preKey: string): void {
  loadPreKeys();
  const composite = compositePreKey(platform, handle, preKey);
  if (preKeysSet.has(composite)) return;
  preKeysSet.add(composite);
  const rec: PreKeyRecord = {
    platform,
    handle,
    pre_key: preKey,
    created_at: new Date().toISOString(),
  };
  ensureDir();
  fs.appendFileSync(PREKEYS_PATH, JSON.stringify(rec) + '\n');
}

/**
 * Has this canonical URL been successfully posted to before?
 *
 * Only counts status='posted' — unlike social-bot, we do NOT permanently
 * blacklist 'failed' attempts, so transient errors can be retried.
 */
export function hasPosted(platform: Platform, handle: string, postUrl: string): boolean {
  loadReplies();
  const recs = repliesByUrl.get(normaliseUrl(postUrl)) ?? [];
  return recs.some(
    (r) => r.platform === platform && r.handle === handle && r.status === 'posted'
  );
}

/**
 * Count today's successful posts for a handle/platform (used for daily caps).
 */
export function countPostedToday(platform: Platform, handle: string): number {
  loadReplies();
  const today = new Date().toISOString().slice(0, 10);
  const key = `${handle}:${platform}:${today}`;
  return repliesToday.get(key) ?? 0;
}

/**
 * Append a reply record. Status can be 'drafted' (dry-run), 'posted',
 * 'failed' (transient, retry OK), or 'skipped' (AI returned SKIP).
 */
export function logReply(rec: Omit<ReplyRecord, 'created_at' | 'post_url'> & {
  post_url: string;
}): void {
  loadReplies();
  const record: ReplyRecord = {
    ...rec,
    post_url: normaliseUrl(rec.post_url),
    created_at: new Date().toISOString(),
  };
  replies.push(record);
  const list = repliesByUrl.get(record.post_url) ?? [];
  list.push(record);
  repliesByUrl.set(record.post_url, list);
  if (record.status === 'posted') {
    const dayKey = `${record.handle}:${record.platform}:${record.created_at.slice(0, 10)}`;
    repliesToday.set(dayKey, (repliesToday.get(dayKey) ?? 0) + 1);
  }
  ensureDir();
  fs.appendFileSync(REPLIES_PATH, JSON.stringify(record) + '\n');
}

/**
 * Stats summary for `franklin social stats`.
 */
export function getStats(platform?: Platform, handle?: string): {
  total: number;
  posted: number;
  failed: number;
  skipped: number;
  drafted: number;
  today: number;
  totalCost: number;
  byProduct: Record<string, number>;
} {
  loadReplies();
  const today = new Date().toISOString().slice(0, 10);
  const filtered = replies.filter((r) => {
    if (platform && r.platform !== platform) return false;
    if (handle && r.handle !== handle) return false;
    return true;
  });
  const byProduct: Record<string, number> = {};
  let totalCost = 0;
  let todayCount = 0;
  const statusCounts = { posted: 0, failed: 0, skipped: 0, drafted: 0 };
  for (const r of filtered) {
    (statusCounts as Record<string, number>)[r.status] =
      ((statusCounts as Record<string, number>)[r.status] ?? 0) + 1;
    if (r.product) byProduct[r.product] = (byProduct[r.product] ?? 0) + 1;
    if (r.cost_usd) totalCost += r.cost_usd;
    if (r.status === 'posted' && r.created_at.startsWith(today)) todayCount++;
  }
  return {
    total: filtered.length,
    ...statusCounts,
    today: todayCount,
    totalCost,
    byProduct,
  };
}

/**
 * Canonicalise a URL for stable dedup keys:
 *   - lowercase host
 *   - strip trailing slash
 *   - strip tracking params (?s=, ?t=, utm_*)
 *   - x.com and twitter.com are aliases
 */
export function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.toLowerCase();
    if (u.hostname === 'twitter.com' || u.hostname === 'mobile.twitter.com') {
      u.hostname = 'x.com';
    }
    // Strip common tracking params
    const toStrip: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (k.startsWith('utm_') || k === 's' || k === 't' || k === 'ref') toStrip.push(k);
    });
    for (const k of toStrip) u.searchParams.delete(k);
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/**
 * Test helper — reset in-memory indexes so the next call re-reads from disk.
 * Not exported from the public API via index.ts.
 */
export function _resetForTest(): void {
  repliesLoaded = false;
  preKeysLoaded = false;
  replies = [];
  repliesByUrl.clear();
  repliesToday.clear();
  preKeysSet.clear();
}
