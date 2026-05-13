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
  /** Wallet that signed (lowercased). Used for test-wallet filtering. */
  wallet?: string;
  /** Model that was charged (e.g. `openai/gpt-5.5`). */
  model?: string;
  /** Which client wrote the row (LLMClient / AgentClient / ProxyClient / AsyncLLMClient). */
  clientKind?: string;
}

/**
 * Anvil/Hardhat deterministic test accounts. The first one
 * (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) leaked into a real
 * cost_log on 2026-05-13 — some SDK path signed with a hardcoded test
 * key in production. These addresses are public knowledge (the private
 * keys are in the Anvil source), so a settlement signed by them is
 * definitionally not a real user spend. Filter them out at read time
 * so dashboards / stats don't surface phantom rows.
 */
const KNOWN_TEST_WALLETS = new Set([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // Anvil #0
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', // Anvil #1
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', // Anvil #2
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906', // Anvil #3
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', // Anvil #4
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', // Anvil #5
  '0x976ea74026e726554db657fa54763abd0c3a0aa9', // Anvil #6
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955', // Anvil #7
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', // Anvil #8
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720', // Anvil #9
]);

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

    // Filter out known test-wallet leaks. Verified 2026-05-13: a real
    // cost_log had a $1 entry written under Anvil account #0
    // (0xf39Fd6...) — public test key. Any settlement under those
    // addresses is by definition not real user spend; drop.
    const walletRaw = typeof obj.wallet === 'string' ? obj.wallet : undefined;
    const wallet = walletRaw?.toLowerCase();
    if (wallet && KNOWN_TEST_WALLETS.has(wallet)) continue;

    const model = typeof obj.model === 'string' ? obj.model : undefined;
    const clientKindRaw = obj.client_kind ?? obj.clientKind;
    const clientKind = typeof clientKindRaw === 'string' ? clientKindRaw : undefined;

    rows.push({ endpoint, costUsd, ts, wallet, model, clientKind });
  }

  return dedupeRows(rows);
}

/**
 * Collapse SDK double-writes. Verified 2026-05-13: a single
 * `gpt-5.5 / /v1/chat/completions / $1.00` call generated THREE
 * cost_log rows in the same physical second (two `LLMClient`, one
 * `AsyncLLMClient`) because the SDK wraps the same fetch through two
 * client classes, both of which call `appendCostLog`. Bucket by
 * `(second, endpoint, model, cost-in-micro-USDC)` and keep the first;
 * the others were always duplicates.
 *
 * Edge case: two legitimate same-second / same-model / same-price
 * calls would also dedupe to one. Accepting that trade-off — the SDK
 * bug currently inflates by 200-300%; a worst-case 1-row undercount
 * on rapid-fire identical calls is a much smaller error and the user's
 * dashboards round to cents anyway.
 */
function dedupeRows(rows: SettlementRow[]): SettlementRow[] {
  const seen = new Map<string, SettlementRow>();
  for (const r of rows) {
    const bucket = Math.floor(r.ts / 1000);
    const microUsd = Math.round(r.costUsd * 1e6);
    const key = `${bucket}|${r.endpoint}|${r.model ?? ''}|${microUsd}`;
    // Keep the FIRST row in each bucket (chronologically earliest by ts).
    // If the existing row in the map already has earlier ts, leave it.
    const existing = seen.get(key);
    if (!existing || r.ts < existing.ts) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Optional metadata fields the SDK writes alongside `endpoint` / `cost_usd`.
 * Adding these to agent + proxy entries keeps cost_log.jsonl uniformly
 * queryable (group by model, filter by wallet, etc.). Verified 2026-05-10
 * against a real cost_log: the SDK writes
 *   {endpoint, cost_usd, model, wallet, network, client_kind}
 * Without these on agent rows you can't tell which model burned a $0.001
 * — the row is just `/v1/messages: 0.001`. With them, every line is a
 * complete forensic record.
 */
export interface SettlementMeta {
  model?: string;
  wallet?: string;
  network?: string;
  client_kind?: string;
}

/**
 * Append one settlement row to ~/.blockrun/cost_log.jsonl in the same
 * shape `@blockrun/llm`'s internal `appendCostLog` writes. Best-effort:
 * silently swallows fs errors so a logging failure never breaks the
 * paid call that just succeeded. Costs <= 0 are treated as no-op (no
 * point logging $0 — the file's purpose is "what was actually paid").
 *
 * Honors FRANKLIN_NO_AUDIT=1 the same way `appendAudit` and `recordUsage`
 * do, so test runs (test/e2e.mjs sets this) don't pollute the user's
 * real cost_log. Verified 2026-05-10 on a real machine: two
 * `/v1/messages: $0.000001` rows leaked into the user's cost_log from
 * a paid e2e run because this gate was missing — paid e2e was hitting
 * the real gateway with a real wallet, but the test framework expected
 * NO writes to land. Restoring the gate keeps cost_log a clean ledger
 * of REAL traffic.
 */
export function appendSettlementRow(
  endpoint: string,
  costUsd: number,
  meta?: SettlementMeta,
): void {
  if (process.env.FRANKLIN_NO_AUDIT === '1' || process.env.FRANKLIN_NO_PERSIST === '1') return;
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  if (typeof endpoint !== 'string' || endpoint.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(getCostLogPath()), { recursive: true });
  } catch { /* best-effort */ }
  // Match SDK conventions exactly: snake_case keys, ts in unix seconds
  // with subsecond precision (Python convention — divide ms epoch by 1e3
  // so the SDK reader and our reader agree on the timestamp).
  const entry: Record<string, unknown> = {
    ts: Date.now() / 1e3,
    endpoint,
    cost_usd: costUsd,
  };
  if (meta?.model) entry.model = meta.model;
  if (meta?.wallet) entry.wallet = meta.wallet;
  if (meta?.network) entry.network = meta.network;
  if (meta?.client_kind) entry.client_kind = meta.client_kind;
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
