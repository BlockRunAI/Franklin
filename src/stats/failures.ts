/**
 * Structured failure logging for self-evolution analysis.
 * Append-only JSONL at ~/.blockrun/failures.jsonl (capped 500 records).
 *
 * 2026-05-11: Adopted a Cursor-style tool-failure taxonomy on the
 * `category` field. Lets us:
 *   1. Tell at a glance whether a spike of failures is the model's
 *      fault (InvalidArguments), the environment's fault
 *      (UnexpectedEnvironment), an upstream's fault (ProviderError),
 *      a user action (UserAborted), or a slow path (Timeout).
 *   2. Build per-(tool, category) baselines for anomaly detection —
 *      see `getToolAnomalies()` below.
 *
 * The existing single-line errorMessage column is preserved so older
 * records still parse. classifyToolFailure() auto-classifies records
 * without a category field on read, so historical entries flow into
 * the same dashboards without a migration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

/**
 * Resolve the failures-file path at call time, not module-load time, so
 * tests can sandbox via FRANKLIN_HOME (already an established convention
 * — see src/tasks/paths.ts). Production keeps the default
 * ~/.blockrun/failures.jsonl path unchanged.
 */
function failuresFile(): string {
  const home = process.env.FRANKLIN_HOME;
  return home
    ? path.join(home, 'failures.jsonl')
    : path.join(BLOCKRUN_DIR, 'failures.jsonl');
}

/**
 * Coarse classification of a tool failure. Mirrors Cursor's published
 * "Tool reliability" taxonomy so error dashboards translate cleanly
 * across the industry, but tuned for Franklin's tool surface.
 */
export type ToolFailureCategory =
  | 'InvalidArguments'      // model passed bad params (wrong type, missing required field, schema reject)
  | 'UnexpectedEnvironment' // file/path doesn't exist, command not found, wallet not configured
  | 'ProviderError'         // upstream API/tool failed (rate-limit, 5xx, gateway, network)
  | 'UserAborted'           // user Ctrl+C / cancel / abort signal
  | 'Timeout'               // tool exceeded its time budget
  | 'Unknown';              // didn't match a known pattern — bug in the harness

export interface FailureRecord {
  timestamp: number;
  model: string;
  failureType: 'tool_error' | 'model_error' | 'permission_denied' | 'agent_loop';
  toolName?: string;
  errorMessage: string;
  recoveryAction?: string;
  /**
   * Coarse classification of the failure. Set by recordFailure() when
   * a record is written, or auto-filled by loadFailures() for older
   * records that pre-date this field.
   */
  category?: ToolFailureCategory;
}

/**
 * Classify a tool failure by matching the error message + tool name
 * against known patterns. Layered top-to-bottom — first match wins.
 * `Unknown` is the catch-all; if you see one in production, the
 * classifier needs a new branch (file a follow-up).
 */
export function classifyToolFailure(
  errorMessage: string,
  toolName?: string,
): ToolFailureCategory {
  const m = (errorMessage || '').toLowerCase();
  // UserAborted — user-initiated cancel or harness abort signal.
  // Check first because abort messages often *contain* the word
  // "timeout" or "error" and would otherwise misclassify.
  if (/this operation was aborted|user aborted|user cancel|user_cancel|sigint|sigterm|operation cancell?ed|abortcontroller/.test(m)) {
    return 'UserAborted';
  }
  // Timeout — distinct from ProviderError because the *call* succeeded
  // (we sent the request) but exceeded our budget. Tool-level retries
  // shouldn't retry these without escalating the budget.
  if (/timed out after|timeout|deadline exceeded|etimedout|operation timed out|exceeded.*time/.test(m)) {
    return 'Timeout';
  }
  // UnexpectedEnvironment — the world isn't as the model assumed.
  // ENOENT / wallet missing / chain mismatch / cwd not a repo / etc.
  if (/enoent|no such file|cannot find|does not exist|not a (git|directory)|wallet not (configured|found)|insufficient.*(balance|funds|lamports)|not logged in|chain mismatch|invalid wallet|command not found/.test(m)) {
    return 'UnexpectedEnvironment';
  }
  // ProviderError — an upstream service we don't control returned bad.
  // Rate limits, 5xx, gateway 4xx, network failures, fetch failures.
  if (/rate.?limit|429|5\d\d|gateway|upstream|provider|fetch failed|econn(refused|reset)|enotfound|socket hang up|network error|http \d{3}|api error|gateway timeout/.test(m)) {
    return 'ProviderError';
  }
  // InvalidArguments — the model called the tool wrong. Covers schema
  // rejects, missing/extra fields, type mismatches, and the very common
  // "cannot read properties of undefined" pattern that means we got an
  // object shape we didn't expect from the model's input.
  if (/invalid (argument|input|parameter|value|schema)|missing (required|argument|field|parameter)|expected.*(but|got|received)|cannot read (properties|property) of (undefined|null)|typeerror|schema (rejected|mismatch|validation)|bad request|400|invalid.*format|unrecognized/.test(m)) {
    return 'InvalidArguments';
  }
  // Tool-specific tells.
  if (toolName) {
    const t = toolName.toLowerCase();
    if (t === 'searchx' || t === 'posttox') {
      if (/login wall|sign in|create account/.test(m)) return 'UnexpectedEnvironment';
    }
    if (t === 'bash') {
      if (/permission denied|eacces/.test(m)) return 'UnexpectedEnvironment';
    }
  }
  return 'Unknown';
}

const MAX_RECORDS = 500;

export function recordFailure(record: FailureRecord): void {
  if (process.env.FRANKLIN_NO_AUDIT === '1' || process.env.FRANKLIN_NO_PERSIST === '1') return;
  try {
    // Auto-classify on write so callsites don't need to know the
    // taxonomy. Callers can still override by passing `category`
    // explicitly (e.g. when the abort came from a known SIGINT handler).
    const enriched: FailureRecord = {
      ...record,
      category: record.category ?? classifyToolFailure(record.errorMessage, record.toolName),
    };
    fs.mkdirSync(path.dirname(failuresFile()), { recursive: true });
    fs.appendFileSync(failuresFile(), JSON.stringify(enriched) + '\n');

    // Trim to MAX_RECORDS (only check periodically to avoid constant reads)
    if (Math.random() < 0.1) {
      trimFailures();
    }
  } catch {
    // Fire-and-forget — never block the critical path
  }
}

function trimFailures(): void {
  try {
    if (!fs.existsSync(failuresFile())) return;
    const lines = fs.readFileSync(failuresFile(), 'utf-8').trim().split('\n');
    if (lines.length > MAX_RECORDS) {
      const trimmed = lines.slice(-MAX_RECORDS).join('\n') + '\n';
      fs.writeFileSync(failuresFile(), trimmed);
    }
  } catch {
    // ignore
  }
}

export function loadFailures(limit = 100): FailureRecord[] {
  try {
    if (!fs.existsSync(failuresFile())) return [];
    const lines = fs.readFileSync(failuresFile(), 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => {
      const parsed = JSON.parse(l) as FailureRecord;
      // Auto-classify historical records that pre-date the `category`
      // field. We don't rewrite the file — read-side enrichment keeps
      // the on-disk shape append-only and idempotent.
      if (!parsed.category) {
        parsed.category = classifyToolFailure(parsed.errorMessage, parsed.toolName);
      }
      return parsed;
    });
  } catch {
    return [];
  }
}

export function getFailureStats(): {
  byTool: Map<string, number>;
  byType: Map<string, number>;
  byCategory: Map<ToolFailureCategory, number>;
  total: number;
  recentFailures: FailureRecord[];
} {
  const records = loadFailures(500);
  const byTool = new Map<string, number>();
  const byType = new Map<string, number>();
  const byCategory = new Map<ToolFailureCategory, number>();

  for (const r of records) {
    if (r.toolName) byTool.set(r.toolName, (byTool.get(r.toolName) ?? 0) + 1);
    byType.set(r.failureType, (byType.get(r.failureType) ?? 0) + 1);
    if (r.category) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  }

  return {
    byTool,
    byType,
    byCategory,
    total: records.length,
    recentFailures: records.slice(-10),
  };
}

// ─── Anomaly detection ──────────────────────────────────────────────────────
//
// "Is the agent broken right now?" — answered by comparing recent failure
// rates per (tool, category) against a longer-window baseline. A 3×+ spike
// over a non-trivial baseline is a strong signal that something in the
// harness or upstream changed; a brand-new failure type with zero baseline
// is a weaker signal but still worth surfacing.
//
// The math is intentionally simple — we're not building a time-series
// engine, we're replacing "user manually skims failures.jsonl every day"
// with a one-line CLI summary.

export interface AnomalyReport {
  toolName: string;
  category: ToolFailureCategory;
  recentCount: number;       // failures in the last `recentWindowMs`
  baselineCount: number;     // failures in the baseline window (excl. recent)
  baselineWindowMs: number;
  recentWindowMs: number;
  /**
   * Multiplier of recent-rate vs baseline-rate. Infinity when the
   * baseline is zero (i.e. a new failure type appeared). 1.0 = same
   * rate as baseline.
   */
  spikeRatio: number;
  /** Most recent error message in this bucket — useful for triage. */
  sampleMessage: string;
}

export interface AnomalyOptions {
  /** Recent window in ms. Default 24h. */
  recentWindowMs?: number;
  /** Baseline window in ms (counted from now, includes the recent window). Default 30d. */
  baselineWindowMs?: number;
  /** Minimum recent count to consider — filters out single-flake noise. Default 3. */
  minRecent?: number;
  /** Minimum spike ratio to surface. Default 3.0. */
  minSpikeRatio?: number;
}

/**
 * Compute (tool, category) anomalies vs a rolling baseline.
 *
 * Returns the buckets where the recent failure rate is dramatically
 * higher than baseline — sorted by spike severity. Skips buckets where
 * `recentCount` is below `minRecent` to avoid surfacing every flaky
 * one-off.
 *
 * A bucket with `baselineCount=0` and `recentCount >= minRecent` is
 * always surfaced (spikeRatio = Infinity) — these are brand-new failure
 * modes that the harness has never seen before, and they're the most
 * important kind to investigate.
 */
export function getToolAnomalies(opts: AnomalyOptions = {}): AnomalyReport[] {
  const recentWindowMs = opts.recentWindowMs ?? 24 * 60 * 60 * 1000;
  const baselineWindowMs = opts.baselineWindowMs ?? 30 * 24 * 60 * 60 * 1000;
  const minRecent = opts.minRecent ?? 3;
  const minSpikeRatio = opts.minSpikeRatio ?? 3.0;

  const now = Date.now();
  const recentCutoff = now - recentWindowMs;
  const baselineCutoff = now - baselineWindowMs;

  // Bucket key = `${toolName}::${category}`.
  const recentByBucket = new Map<string, { count: number; sample: string }>();
  const baselineByBucket = new Map<string, number>();

  for (const r of loadFailures(500)) {
    if (r.timestamp < baselineCutoff) continue;
    const tool = r.toolName ?? '<no-tool>';
    const cat = r.category ?? 'Unknown';
    const key = `${tool}::${cat}`;

    if (r.timestamp >= recentCutoff) {
      const existing = recentByBucket.get(key) ?? { count: 0, sample: r.errorMessage };
      existing.count += 1;
      existing.sample = r.errorMessage; // last seen wins; useful for triage
      recentByBucket.set(key, existing);
    } else {
      baselineByBucket.set(key, (baselineByBucket.get(key) ?? 0) + 1);
    }
  }

  const reports: AnomalyReport[] = [];
  for (const [key, { count: recentCount, sample }] of recentByBucket) {
    if (recentCount < minRecent) continue;
    const baselineCount = baselineByBucket.get(key) ?? 0;

    // Normalize rates by window length so spikes are comparable across
    // different (recent, baseline) sizes. baseline window excludes the
    // recent window by construction (we partitioned above).
    const baselineWindowExclRecent = baselineWindowMs - recentWindowMs;
    const recentRate = recentCount / recentWindowMs;
    const baselineRate = baselineCount > 0
      ? baselineCount / Math.max(1, baselineWindowExclRecent)
      : 0;
    const spikeRatio = baselineRate > 0
      ? recentRate / baselineRate
      : Number.POSITIVE_INFINITY;

    if (spikeRatio < minSpikeRatio) continue;
    const [toolName, category] = key.split('::') as [string, ToolFailureCategory];
    reports.push({
      toolName,
      category,
      recentCount,
      baselineCount,
      baselineWindowMs,
      recentWindowMs,
      spikeRatio,
      sampleMessage: sample,
    });
  }

  // Sort: brand-new failures (spikeRatio = Infinity) first, then by ratio desc.
  reports.sort((a, b) => {
    if (a.spikeRatio === b.spikeRatio) return b.recentCount - a.recentCount;
    return b.spikeRatio - a.spikeRatio;
  });

  return reports;
}
