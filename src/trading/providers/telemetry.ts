/**
 * Provider-layer telemetry.
 *
 * Records every fetcher call so the Panel Markets page can show live health
 * ("• CoinGecko OK", "• BlockRun OK"), today's call count, today's spend,
 * and a p50 latency estimate. Entirely in-memory — dies with the process
 * and re-hydrates from the on-disk wallet/stats files if we ever care to
 * persist (we don't yet).
 *
 * Tiny by design: zero deps, no background timers, no DB. Callers push a
 * single record per fetch; the Panel pulls a snapshot on demand.
 */

type ProviderName = 'coingecko' | 'blockrun';

interface FetchRecord {
  provider: ProviderName;
  endpoint: string;
  ok: boolean;
  latencyMs: number;
  costUsd?: number;
  ts: number;
}

interface ProviderRoll {
  calls: number;
  ok: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  spendUsdToday: number;
  spendResetAt: number; // epoch-ms marking the start of the current UTC day
  latencies: number[]; // ring of last N for p50
}

interface PaidCallRow {
  endpoint: string;
  costUsd: number;
  ts: number;
}

const LATENCY_RING = 64;
const PAID_ROW_RING = 32;

function newRoll(): ProviderRoll {
  return {
    calls: 0,
    ok: 0,
    failures: 0,
    lastOkAt: null,
    lastErrorAt: null,
    spendUsdToday: 0,
    spendResetAt: startOfUtcDay(Date.now()),
    latencies: [],
  };
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const rolls: Record<ProviderName, ProviderRoll> = {
  coingecko: newRoll(),
  blockrun: newRoll(),
};

const paidRecent: PaidCallRow[] = [];

export function recordFetch(evt: Omit<FetchRecord, 'ts'>): void {
  const roll = rolls[evt.provider];
  const now = Date.now();

  // Daily rollover for spend.
  const dayNow = startOfUtcDay(now);
  if (dayNow !== roll.spendResetAt) {
    roll.spendUsdToday = 0;
    roll.spendResetAt = dayNow;
  }

  roll.calls++;
  if (evt.ok) {
    roll.ok++;
    roll.lastOkAt = now;
  } else {
    roll.failures++;
    roll.lastErrorAt = now;
  }

  if (evt.latencyMs >= 0) {
    roll.latencies.push(evt.latencyMs);
    if (roll.latencies.length > LATENCY_RING) roll.latencies.shift();
  }

  if (evt.costUsd && evt.costUsd > 0) {
    roll.spendUsdToday += evt.costUsd;
    paidRecent.push({ endpoint: evt.endpoint, costUsd: evt.costUsd, ts: now });
    if (paidRecent.length > PAID_ROW_RING) paidRecent.shift();
  }
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface ProviderSnapshot {
  name: ProviderName;
  calls: number;
  ok: number;
  failures: number;
  p50LatencyMs: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  spendUsdToday: number;
  status: 'ok' | 'degraded' | 'cold';
}

export interface TelemetrySnapshot {
  providers: ProviderSnapshot[];
  totals: {
    callsToday: number;
    spendUsdToday: number;
    p50LatencyMs: number | null;
  };
  recentPaidCalls: PaidCallRow[];
}

function snapshotProvider(name: ProviderName): ProviderSnapshot {
  const r = rolls[name];
  const p = p50(r.latencies);
  const now = Date.now();
  let status: ProviderSnapshot['status'] = 'cold';
  if (r.calls > 0) {
    const freshError = r.lastErrorAt && now - r.lastErrorAt < 60_000;
    const freshOk = r.lastOkAt && now - r.lastOkAt < 5 * 60_000;
    if (freshError && !freshOk) status = 'degraded';
    else status = 'ok';
  }
  return {
    name,
    calls: r.calls,
    ok: r.ok,
    failures: r.failures,
    p50LatencyMs: p,
    lastOkAt: r.lastOkAt,
    lastErrorAt: r.lastErrorAt,
    spendUsdToday: r.spendUsdToday,
    status,
  };
}

export function snapshot(): TelemetrySnapshot {
  const providers: ProviderSnapshot[] = [snapshotProvider('coingecko'), snapshotProvider('blockrun')];
  const allLatencies = [...rolls.coingecko.latencies, ...rolls.blockrun.latencies];
  return {
    providers,
    totals: {
      callsToday: providers.reduce((s, p) => s + p.calls, 0),
      spendUsdToday: providers.reduce((s, p) => s + p.spendUsdToday, 0),
      p50LatencyMs: p50(allLatencies),
    },
    recentPaidCalls: [...paidRecent].reverse(),
  };
}

/** Test helper: reset all counters. Do not call in production code paths. */
export function resetTelemetry(): void {
  rolls.coingecko = newRoll();
  rolls.blockrun = newRoll();
  paidRecent.length = 0;
}
