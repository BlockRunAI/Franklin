/**
 * Reader for `~/.blockrun/cost_log.jsonl` — the SDK-owned ledger of every
 * settled x402 payment.
 *
 * Franklin's own `franklin-stats.json` and `franklin-audit.jsonl` only
 * capture calls that pass through specific code paths (the main agent
 * loop and the proxy). Helper LLM calls (analyzeTurn, prefetchForIntent,
 * compaction, evaluator, verification, MoA, subagent, learning extraction,
 * etc.) all settle x402 payments through the SDK — those payments DO get
 * recorded in cost_log.jsonl by `@blockrun/llm` itself, but Franklin's
 * stats infra had been ignoring this file entirely.
 *
 * Verified 2026-05-06 against a real machine: cost_log.jsonl is written
 * by the SDK with snake_case keys (`cost_usd`, `ts` in unix seconds with
 * subsecond precision — Python convention) and Franklin's reads/writes
 * use camelCase + ms. This module bridges the format gap so stats /
 * insights / `franklin balance` can surface the wallet-truth total
 * alongside the recorded total.
 *
 * Responsibility: read-only. We never write or trim cost_log.jsonl —
 * the SDK owns it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

export interface SettlementRow {
  /** Endpoint path that was paid for, e.g. `/v1/chat/completions`. */
  endpoint: string;
  /** USD settled on-chain via x402. */
  costUsd: number;
  /** Unix milliseconds (normalized — SDK writes seconds). */
  ts: number;
}

export interface SettlementSummary {
  /** Path to cost_log.jsonl (or the fallback location). */
  path: string;
  /** Total entries read. */
  count: number;
  /** Sum of `costUsd` across all rows in window. */
  totalUsd: number;
  /** Per-endpoint breakdown sorted by cost descending. */
  byEndpoint: Array<{ endpoint: string; count: number; costUsd: number }>;
  /** First and last timestamps observed in the window (unix ms), or null. */
  firstTs: number | null;
  lastTs: number | null;
}

function getCostLogPath(): string {
  return path.join(BLOCKRUN_DIR, 'cost_log.jsonl');
}

interface ReadOptions {
  /** Override the cost_log path (for tests). Defaults to ~/.blockrun/cost_log.jsonl. */
  path?: string;
  sinceMs?: number;
  untilMs?: number;
}

/**
 * Load + parse cost_log.jsonl. Optional time window in unix milliseconds.
 * Skips malformed lines silently (the SDK's JSONL writer is well-behaved
 * but we don't want a single corrupted line to nuke the whole readout).
 *
 * Returns an empty list if the file doesn't exist — callers should treat
 * that as "no SDK ledger available" rather than an error, since the file
 * is only created on the first paid call.
 */
export function loadSdkSettlements(opts?: ReadOptions): SettlementRow[] {
  const file = opts?.path ?? getCostLogPath();
  if (!fs.existsSync(file)) return [];

  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }

  const rows: SettlementRow[] = [];
  const sinceMs = opts?.sinceMs ?? 0;
  const untilMs = opts?.untilMs ?? Number.POSITIVE_INFINITY;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const endpoint = typeof obj.endpoint === 'string' ? obj.endpoint : '';
    if (!endpoint) continue;

    // SDK writes `cost_usd`. Defensively also accept `costUsd` in case a
    // future SDK release switches conventions.
    const costRaw = obj.cost_usd ?? obj.costUsd;
    const costUsd = typeof costRaw === 'number' && Number.isFinite(costRaw) ? costRaw : 0;

    // SDK writes `ts` as unix SECONDS with subsecond precision (1773424791.43...).
    // Normalize to ms so callers can compare against `Date.now()` directly.
    const tsRaw = obj.ts;
    if (typeof tsRaw !== 'number' || !Number.isFinite(tsRaw)) continue;
    const ts = tsRaw < 1e12 ? Math.round(tsRaw * 1000) : Math.round(tsRaw);

    if (ts < sinceMs || ts > untilMs) continue;
    rows.push({ endpoint, costUsd, ts });
  }

  return rows;
}

/** Aggregate the SDK ledger into a single summary object. */
export function summarizeSdkSettlements(opts?: ReadOptions): SettlementSummary {
  const rows = loadSdkSettlements(opts);
  let totalUsd = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const byEndpointMap = new Map<string, { count: number; costUsd: number }>();

  for (const r of rows) {
    totalUsd += r.costUsd;
    if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
    if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
    const acc = byEndpointMap.get(r.endpoint) ?? { count: 0, costUsd: 0 };
    acc.count += 1;
    acc.costUsd += r.costUsd;
    byEndpointMap.set(r.endpoint, acc);
  }

  const byEndpoint = Array.from(byEndpointMap.entries())
    .map(([endpoint, v]) => ({ endpoint, count: v.count, costUsd: v.costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    path: opts?.path ?? getCostLogPath(),
    count: rows.length,
    totalUsd,
    byEndpoint,
    firstTs,
    lastTs,
  };
}
