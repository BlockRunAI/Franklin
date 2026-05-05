/**
 * Data hygiene for ~/.blockrun/.
 *
 * Several files in this directory are written by the @blockrun/llm SDK or
 * by older Franklin versions that didn't ship retention. Without periodic
 * trimming they grow unbounded:
 *
 *   - ~/.blockrun/data/         — every paid API call gets a JSON blob
 *                                 dropped here for forensic replay. SDK
 *                                 has no rotation; verified 5.7 MB across
 *                                 ~2 months of light use, will be 30 MB
 *                                 by year-end and slow `franklin insights`.
 *   - ~/.blockrun/cost_log.jsonl — append-only ledger of every paid call's
 *                                 cost. Same SDK; no rotation.
 *   - brcc-debug.log / brcc-stats.json / 0xcode-stats.json
 *                               — legacy stats / log files from earlier
 *                                 product names. Not written by any
 *                                 current code path.
 *
 * Hygiene runs once per session start (cheap — just stat() + filter +
 * unlinkSync). Best-effort: every operation is wrapped so a single failure
 * never breaks agent boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import { pruneJunkBrainEntries } from '../brain/store.js';
import { getTasksDir, getLegacyTasksDir } from '../tasks/paths.js';
import { isTerminalTaskStatus, type TaskStatus } from '../tasks/types.js';

// Retention knobs. Tuned conservatively — a power user with 50+ calls/day
// for 30 days still fits in DATA_DIR_MAX_FILES, and 5000 cost-log entries
// covers months of normal use without truncating the running totals.
const DATA_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DATA_DIR_MAX_FILES = 2000;
const COST_LOG_MAX_ENTRIES = 5000;
// Task records (meta + events + log per task dir). Verified 2026-05-05:
// 10 tasks across ~/.franklin/tasks/, oldest "lost" status from 53 hours
// ago, none ever cleaned up. Each task's log.txt can run 1+ MB for ETL
// jobs. Without retention, disk fills slowly. 7 days lets a user inspect
// the previous week's runs but archives anything older. Running tasks
// are NEVER touched (status check + heartbeat freshness).
const TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TASK_MIN_RETAIN = 5; // always keep the 5 most-recent records regardless of age
// Cost log entries are tiny (~60 bytes — ts, endpoint, cost only). 40 bytes
// per entry keeps the probe under the real average so a slightly-overlong
// file always triggers the rescan rather than silently growing past cap.
const COST_LOG_PROBE_BYTES = COST_LOG_MAX_ENTRIES * 40;

// Legacy file names from earlier product iterations. All live directly in
// BLOCKRUN_DIR (only Franklin writes here, so these are safe to remove).
// `runcode-debug.log` is also handled by logs.ts's migration path; we
// delete the residual after migration in case it lingered.
const LEGACY_FILENAMES = [
  'brcc-debug.log',
  'brcc-stats.json',
  '0xcode-stats.json',
  'runcode-debug.log',
];

/**
 * Summary of what hygiene removed/trimmed in one pass. Returned so the
 * caller (agent loop) can log it — silent hygiene is hard to verify
 * without poking at disk yourself, which is exactly the kind of thing
 * users shouldn't have to do.
 */
export interface HygieneReport {
  legacyFilesRemoved: number;
  dataFilesTrimmed: number;
  costLogRowsTrimmed: number;
  orphanToolResultsRemoved: number;
  brainJunkEntitiesRemoved: number;
  oldTasksRemoved: number;
}

const ZERO_REPORT: HygieneReport = {
  legacyFilesRemoved: 0,
  dataFilesTrimmed: 0,
  costLogRowsTrimmed: 0,
  orphanToolResultsRemoved: 0,
  brainJunkEntitiesRemoved: 0,
  oldTasksRemoved: 0,
};

/**
 * Top-level entry. Call once at agent session start. Catches its own
 * errors so a bad disk never blocks startup. Returns counts so callers
 * can log a one-line summary — verified 2026-05-04 from a real session
 * where hygiene was running silently for hours and there was no way to
 * tell from the log whether anything was being cleaned.
 */
export function runDataHygiene(): HygieneReport {
  const report: HygieneReport = { ...ZERO_REPORT };
  try { report.dataFilesTrimmed = trimDataDir(); } catch { /* best effort */ }
  try { report.costLogRowsTrimmed = trimCostLog(); } catch { /* best effort */ }
  try { report.legacyFilesRemoved = removeLegacyFiles(); } catch { /* best effort */ }
  try { report.orphanToolResultsRemoved = sweepOrphanToolResults(); } catch { /* best effort */ }
  try { report.brainJunkEntitiesRemoved = pruneJunkBrainEntries().entitiesRemoved; } catch { /* best effort */ }
  try { report.oldTasksRemoved = pruneOldTaskRecords(); } catch { /* best effort */ }
  return report;
}

/**
 * Remove terminal-state task directories older than TASK_MAX_AGE_MS.
 * Scans both the canonical (~/.blockrun/tasks/) and legacy
 * (~/.franklin/tasks/) locations, since 3.15.42 leaves both readable.
 *
 * Safety:
 *   - Running / queued tasks are NEVER removed (status check).
 *   - Always keep the most-recent TASK_MIN_RETAIN records regardless of
 *     age, so users can see recent history after a long pause.
 *   - Best-effort: corrupt meta or unreadable dirs are skipped silently.
 */
function pruneOldTaskRecords(): number {
  const cutoff = Date.now() - TASK_MAX_AGE_MS;
  let removed = 0;
  const dirs = [getTasksDir()];
  if (process.env.FRANKLIN_HOME === undefined) dirs.push(getLegacyTasksDir());
  for (const dir of dirs) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    // Build a list of (runId, mtimeMs, terminal?) so we can sort and
    // protect the N most-recent regardless of age.
    type Cand = { runId: string; mtime: number; terminal: boolean; metaPath: string };
    const cands: Cand[] = [];
    for (const name of entries) {
      const taskDir = path.join(dir, name);
      const metaPath = path.join(taskDir, 'meta.json');
      try {
        const stat = fs.statSync(taskDir);
        if (!stat.isDirectory()) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { status?: TaskStatus };
        const terminal = typeof meta.status === 'string' && isTerminalTaskStatus(meta.status);
        cands.push({ runId: name, mtime: stat.mtimeMs, terminal, metaPath });
      } catch {
        // Unreadable meta or stat — skip silently. We never delete a dir
        // we can't confirm is terminal, to avoid killing a running task
        // whose meta we just couldn't read.
      }
    }
    // Sort newest-first so the slice for retention is at index 0..N-1.
    cands.sort((a, b) => b.mtime - a.mtime);
    const protectedIds = new Set(cands.slice(0, TASK_MIN_RETAIN).map(c => c.runId));
    for (const c of cands) {
      if (protectedIds.has(c.runId)) continue;
      if (!c.terminal) continue;            // never touch running/queued
      if (c.mtime >= cutoff) continue;      // young enough to keep
      try { fs.rmSync(path.join(dir, c.runId), { recursive: true, force: true }); removed++; } catch { /* ok */ }
    }
  }
  return removed;
}

function trimDataDir(): number {
  const dir = path.join(BLOCKRUN_DIR, 'data');
  if (!fs.existsSync(dir)) return 0;

  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return 0;

  const cutoff = Date.now() - DATA_DIR_MAX_AGE_MS;
  type Entry = { name: string; mtime: number };
  const stats: Entry[] = [];
  for (const name of entries) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      stats.push({ name, mtime: st.mtimeMs });
    } catch {
      // Best effort — skip unreadable entries.
    }
  }

  let removed = 0;
  // Pass 1: age-based delete.
  for (const e of stats) {
    if (e.mtime < cutoff) {
      try { fs.unlinkSync(path.join(dir, e.name)); removed++; } catch { /* ok */ }
    }
  }

  // Pass 2: file-count cap. After age trim, if we still have too many,
  // drop the oldest until we're under the cap. Power users can hit this
  // when running multiple paid tools in tight loops.
  const survivors = stats
    .filter(e => e.mtime >= cutoff)
    .sort((a, b) => a.mtime - b.mtime); // oldest first
  const excess = survivors.length - DATA_DIR_MAX_FILES;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(dir, survivors[i].name)); removed++; } catch { /* ok */ }
    }
  }
  return removed;
}

function trimCostLog(): number {
  const file = path.join(BLOCKRUN_DIR, 'cost_log.jsonl');
  if (!fs.existsSync(file)) return 0;

  // Cheap probe — skip the full read+rewrite when the file is small.
  const stat = fs.statSync(file);
  if (stat.size < COST_LOG_PROBE_BYTES) return 0;

  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  if (lines.length <= COST_LOG_MAX_ENTRIES) return 0;

  const dropped = lines.length - COST_LOG_MAX_ENTRIES;
  const kept = lines.slice(lines.length - COST_LOG_MAX_ENTRIES);
  fs.writeFileSync(file, kept.join('\n') + '\n');
  return dropped;
}

function removeLegacyFiles(): number {
  let removed = 0;
  for (const name of LEGACY_FILENAMES) {
    const p = path.join(BLOCKRUN_DIR, name);
    if (!fs.existsSync(p)) continue;
    try { fs.unlinkSync(p); removed++; } catch { /* ok */ }
  }
  return removed;
}

/**
 * `streaming-executor` writes large tool outputs to
 * `~/.blockrun/tool-results/<sessionId>/<toolUseId>.txt`. When a session is
 * pruned by `pruneOldSessions`, the meta + jsonl are deleted but the
 * tool-results dir is left dangling. Verified on a real machine: 5 dirs,
 * oldest from 4/14 (3 weeks past MAX_SESSIONS=20 retention).
 *
 * A tool-results dir is considered orphan when its name (the session id)
 * has no `<sessionId>.meta.json` partner in the sessions/ dir. The active
 * session is implicitly protected because its meta exists.
 */
function sweepOrphanToolResults(): number {
  const toolResultsDir = path.join(BLOCKRUN_DIR, 'tool-results');
  const sessionsDir = path.join(BLOCKRUN_DIR, 'sessions');
  if (!fs.existsSync(toolResultsDir)) return 0;

  const knownSessionIds = new Set<string>();
  if (fs.existsSync(sessionsDir)) {
    try {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (f.endsWith('.meta.json')) {
          knownSessionIds.add(f.slice(0, -'.meta.json'.length));
        }
      }
    } catch {
      // Best-effort — if we can't read sessions/, skip the sweep so
      // we never delete tool-results that might still belong to a
      // live session.
      return 0;
    }
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(toolResultsDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (knownSessionIds.has(name)) continue;
    const dir = path.join(toolResultsDir, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Skip — best-effort cleanup.
    }
  }
  return removed;
}
