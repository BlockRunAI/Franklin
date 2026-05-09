/**
 * Reader (and limited writer) for `~/.blockrun/cost_log.jsonl` — the
 * append-only ledger of every settled x402 payment.
 *
 * History: this file was originally SDK-only territory. `@blockrun/llm`'s
 * internal `appendCostLog` writes one line per micropayment when callers
 * use SDK helper methods (modal sandbox, prediction market, exa, etc.).
 * But Franklin's main LLM stream — both the in-process agent loop
 * (`src/agent/llm.ts`) and the proxy server (`src/proxy/server.ts`) —
 * have **their own** x402 signers that bypass the SDK entirely. Verified
 * 2026-05-09 on a real machine: a single paid agent turn dropped the
 * wallet by $0.001 and updated `franklin-stats.json` correctly, but
 * cost_log.jsonl gained zero entries. So cost_log was never the
 * "wallet truth" it advertised — it was an SDK-subset.
 *
 * Fix (2026-05-09): expose `appendSettlementRow` so the agent and proxy
 * signers can write the same shape the SDK does. The format contract
 * (snake_case `cost_usd`, `ts` in unix seconds with subsecond precision,
 * one JSON object per line) is preserved exactly so both writers
 * interleave cleanly. Order in the file follows wall-clock arrival.
 *
 * Responsibility: read + append-only write. We never trim or rotate
 * cost_log.jsonl — that contract still belongs to the SDK / hygiene.
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

/**
 * Append one settlement row to ~/.blockrun/cost_log.jsonl in the same
 * shape `@blockrun/llm`'s internal `appendCostLog` writes. Best-effort:
 * silently swallows fs errors so a logging failure never breaks the
 * paid call that just succeeded. Costs <= 0 are treated as no-op (no
 * point logging $0 — the file's purpose is "what was actually paid").
 */
export function appendSettlementRow(endpoint: string, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(getCostLogPath()), { recursive: true });
  } catch { /* best-effort */ }
  // Match SDK conventions exactly: snake_case keys, ts in unix seconds
  // with subsecond precision (Python convention — divide ms epoch by 1e3
  // so the SDK reader and our reader agree on the timestamp).
  const entry = {
    ts: Date.now() / 1e3,
    endpoint,
    cost_usd: costUsd,
  };
  try {
    fs.appendFileSync(getCostLogPath(), JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
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
