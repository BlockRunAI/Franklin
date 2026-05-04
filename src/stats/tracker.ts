/**
 * Usage tracking for Franklin
 * Records all requests with cost, tokens, and latency for stats display
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OPUS_PRICING } from '../pricing.js';
import { BLOCKRUN_DIR } from '../config.js';
import { isTestFixtureModel } from './test-fixture.js';

let resolvedStatsFile: string | null = null;

function preferredStatsFile(): string {
  return path.join(BLOCKRUN_DIR, 'franklin-stats.json');
}

function legacyStatsFile(): string {
  return path.join(BLOCKRUN_DIR, 'runcode-stats.json');
}

function fallbackStatsFile(): string {
  return path.join(os.tmpdir(), 'franklin', 'franklin-stats.json');
}

export function getStatsFilePath(): string {
  if (resolvedStatsFile) return resolvedStatsFile;

  // Migrate legacy stats file if it exists and new one doesn't
  const preferred = preferredStatsFile();
  const legacy = legacyStatsFile();
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, preferred); } catch { /* best effort */ }
  }

  for (const file of [preferred, fallbackStatsFile()]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      resolvedStatsFile = file;
      return file;
    } catch {
      // Try the next candidate.
    }
  }

  resolvedStatsFile = preferredStatsFile();
  return resolvedStatsFile;
}

function withWritableStatsFile(action: (statsFile: string) => void): void {
  const preferred = preferredStatsFile();
  const fallback = fallbackStatsFile();

  try {
    action(getStatsFilePath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const shouldFallback =
      (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') &&
      resolvedStatsFile === preferred;

    if (!shouldFallback) throw err;

    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    resolvedStatsFile = fallback;
    action(fallback);
  }
}

export interface UsageRecord {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  fallback?: boolean; // true if this request used fallback
}

export interface ModelStats {
  requests: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  fallbackCount: number;
  avgLatencyMs: number;
  totalLatencyMs: number;
}

export interface Stats {
  version: number;
  totalRequests: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalFallbacks: number;
  byModel: Record<string, ModelStats>;
  history: UsageRecord[]; // Last 1000 records
  firstRequest?: number;
  lastRequest?: number;
}

const EMPTY_STATS: Stats = {
  version: 1,
  totalRequests: 0,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalFallbacks: 0,
  byModel: {},
  history: [],
};

export function loadStats(): Stats {
  try {
    const statsFile = getStatsFilePath();
    if (fs.existsSync(statsFile)) {
      const data = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
      // Migration: add missing fields
      return {
        ...EMPTY_STATS,
        ...data,
        version: 1,
      };
    }
  } catch {
    /* ignore parse errors, return empty */
  }

  return { ...EMPTY_STATS };
}

export function saveStats(stats: Stats): void {
  try {
    withWritableStatsFile((statsFile) => {
      fs.mkdirSync(path.dirname(statsFile), { recursive: true });
      // Keep only last 1000 history records
      stats.history = stats.history.slice(-1000);
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    });
  } catch (err) {
    // Surface write failures (disk full, permission) to stderr so users
    // aren't silently losing usage data.
    try { process.stderr.write(`[franklin-stats] flush failed: ${(err as Error).message}\n`); } catch { /* stderr gone */ }
  }
}

export function clearStats(): void {
  cachedStats = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  resolvedStatsFile = null;
  for (const statsFile of new Set([preferredStatsFile(), fallbackStatsFile()])) {
    try {
      if (fs.existsSync(statsFile)) {
        fs.unlinkSync(statsFile);
      }
    } catch {
      /* ignore */
    }
  }
}

// ─── In-memory stats cache with debounced write ─────────────────────────
// Prevents concurrent load→modify→save from losing data in proxy mode
let cachedStats: Stats | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 2000;

function getCachedStats(): Stats {
  if (!cachedStats) {
    cachedStats = loadStats();
  }
  return cachedStats;
}

function scheduleSave(): void {
  if (flushTimer) return; // Already scheduled
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (cachedStats) saveStats(cachedStats);
  }, FLUSH_DELAY_MS);
}

/** Flush stats to disk immediately (call on process exit) */
export function flushStats(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (cachedStats) saveStats(cachedStats);
}

/**
 * Record a completed request for stats tracking
 */
export function recordUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  latencyMs: number,
  fallback: boolean = false
): void {
  // Same rationale as appendAudit — tests run in-process with
  // local/test* models and would otherwise mix into franklin-stats.json
  // history (verified: 8.4% of a real user's 1000-entry history was
  // test fixtures before this gate).
  if (isTestFixtureModel(model)) return;
  // Test fixtures using real model names (`zai/glm-5.1` after 3.15.17's
  // rename) escape the prefix gate. Env-var override lets tests opt
  // out at file level. Mirrors the audit.ts guard; same env var so
  // tests flip a single switch.
  if (process.env.FRANKLIN_NO_AUDIT === '1') return;

  const stats = getCachedStats();
  const now = Date.now();

  // Update totals
  stats.totalRequests++;
  stats.totalCostUsd += costUsd;
  stats.totalInputTokens += inputTokens;
  stats.totalOutputTokens += outputTokens;
  if (fallback) stats.totalFallbacks++;

  // Update timestamps
  if (!stats.firstRequest) stats.firstRequest = now;
  stats.lastRequest = now;

  // Update per-model stats
  if (!stats.byModel[model]) {
    stats.byModel[model] = {
      requests: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallbackCount: 0,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
    };
  }

  const modelStats = stats.byModel[model];
  modelStats.requests++;
  modelStats.costUsd += costUsd;
  modelStats.inputTokens += inputTokens;
  modelStats.outputTokens += outputTokens;
  modelStats.totalLatencyMs += latencyMs;
  modelStats.avgLatencyMs = modelStats.totalLatencyMs / modelStats.requests;
  if (fallback) modelStats.fallbackCount++;

  // Add to history
  stats.history.push({
    timestamp: now,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    fallback,
  });

  scheduleSave();
}

/**
 * Get stats summary for display
 */
export function getStatsSummary(): {
  stats: Stats;
  opusCost: number;
  /** All chat / token-billed model spend (excludes image / video / music). */
  chatOnlyCost: number;
  /** Per-image / per-second / per-track media generation spend. */
  mediaCost: number;
  saved: number;
  savedPct: number;
  avgCostPerRequest: number;
  period: string;
} {
  const stats = loadStats();

  // Hypothetical "if you'd used Opus for everything" baseline. Opus is a
  // chat model — it can't replace ImageGen / VideoGen / Music (per_image,
  // per_second, per_track billing), so for those rows the Opus-equivalent
  // cost IS just the actual cost (no alternative). For chat rows, the
  // baseline is the same tokens repriced at Opus rates.
  //
  // Walk byModel: rows with zero tokens are media (recordUsage stores
  // image/video calls with inputTokens=0 outputTokens=0). Those count
  // towards both sides equally; chat rows count at actual price on the
  // "actual" side and at Opus rates on the "baseline" side. Keeping them
  // on both sides means the displayed totals match the user's real
  // spend rather than an unfamiliar chat-only subset.
  let chatOnlyCost = 0;
  let mediaCost = 0;
  for (const m of Object.values(stats.byModel)) {
    if ((m.inputTokens + m.outputTokens) > 0) chatOnlyCost += m.costUsd;
    else mediaCost += m.costUsd;
  }
  const opusChatCost =
    (stats.totalInputTokens / 1_000_000) * OPUS_PRICING.input +
    (stats.totalOutputTokens / 1_000_000) * OPUS_PRICING.output;
  // Display-side baseline: include media on both sides so "you spent X
  // instead of Y" shows real, comparable totals.
  const opusCost = opusChatCost + mediaCost;

  // Saved is the chat-side delta only — media nets to zero. Clamp to 0
  // so a session where the user paid more than Opus-equivalent for chat
  // (e.g. Sonnet 4.6 with extended thinking enabled) doesn't show a
  // negative "savings" number; we just say zero saved.
  const saved = Math.max(0, opusChatCost - chatOnlyCost);
  const savedPct = opusCost > 0 ? (saved / opusCost) * 100 : 0;
  const avgCostPerRequest =
    stats.totalRequests > 0 ? stats.totalCostUsd / stats.totalRequests : 0;

  // Calculate period
  let period = 'No data';
  if (stats.firstRequest && stats.lastRequest) {
    const days = Math.ceil(
      (stats.lastRequest - stats.firstRequest) / (1000 * 60 * 60 * 24)
    );
    if (days === 0) period = 'Today';
    else if (days === 1) period = '1 day';
    else period = `${days} days`;
  }

  return { stats, opusCost, chatOnlyCost, mediaCost, saved, savedPct, avgCostPerRequest, period };
}
