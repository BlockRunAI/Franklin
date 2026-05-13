/**
 * Task persistence: meta.json (single record) + events.jsonl (append-only log).
 *
 * Concurrency contract: applyEvent does a read-modify-write on meta.json. It
 * is safe to call from a single writer per task — by convention, that writer
 * is the _task-runner subprocess. CLI commands that need to influence a
 * running task (e.g. `franklin task cancel`) MUST signal the runner pid
 * (SIGTERM) rather than calling applyEvent directly, otherwise the two
 * writers race and one update is silently lost. Lost-task reconciliation
 * is an exception — it runs only when the runner is provably dead, so
 * there is no second writer to race with.
 *
 * Atomicity: writeTaskMeta uses tmp + rename; readers see either old or new
 * meta, never partial. appendTaskEvent relies on POSIX O_APPEND + PIPE_BUF
 * atomicity (~4096 bytes); summaries should stay short. readTaskEvents is
 * tolerant of a torn last line.
 */

import fs from 'node:fs';
import type { TaskRecord, TaskEventRecord } from './types.js';
import { isTerminalTaskStatus } from './types.js';
import {
  ensureTaskDir,
  taskMetaPath,
  taskEventsPath,
  getTasksDir,
  getLegacyTasksDir,
  getTaskDir,
} from './paths.js';

export function writeTaskMeta(record: TaskRecord): void {
  ensureTaskDir(record.runId);
  const target = taskMetaPath(record.runId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    throw err;
  }
}

export function readTaskMeta(runId: string): TaskRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(taskMetaPath(runId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Surface unexpected I/O errors instead of pretending the task doesn't exist.
    throw err;
  }
  try {
    return JSON.parse(raw) as TaskRecord;
  } catch (err) {
    process.stderr.write(`[franklin] meta.json corrupt for ${runId}: ${(err as Error).message}\n`);
    return null;
  }
}

export function appendTaskEvent(runId: string, event: TaskEventRecord): void {
  ensureTaskDir(runId);
  fs.appendFileSync(taskEventsPath(runId), JSON.stringify(event) + '\n');
}

export function readTaskEvents(runId: string): TaskEventRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(taskEventsPath(runId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // Per-line tolerance: a torn last line (concurrent appendFileSync over PIPE_BUF)
  // would otherwise discard the whole log. Mirror storage.ts:loadSessionHistory.
  const out: TaskEventRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as TaskEventRecord); }
    catch { /* skip torn / corrupt line */ }
  }
  return out;
}

export function applyEvent(runId: string, event: TaskEventRecord): TaskRecord {
  const cur = readTaskMeta(runId);
  if (!cur) throw new Error(`applyEvent: no task ${runId}`);
  const next: TaskRecord = { ...cur };
  next.lastEventAt = event.at;
  if (event.summary !== undefined) next.progressSummary = event.summary;

  if (event.kind === 'running' && next.status === 'queued') {
    next.status = 'running';
    next.startedAt = event.at;
  } else if (event.kind !== 'progress' && event.kind !== 'running') {
    // event.kind is now narrowed to terminal statuses
    next.status = event.kind;
    next.endedAt = event.at;
    if (event.summary !== undefined) next.terminalSummary = event.summary;
  }

  appendTaskEvent(runId, event);
  writeTaskMeta(next);
  return next;
}

/**
 * Permanently delete a task — meta.json, events.jsonl, log.txt, the
 * whole per-task directory. Refuses to delete a task that is still
 * `queued` or `running` (the runner subprocess might still hold open
 * fds, and removing meta out from under it leads to confused state).
 * Returns true if anything was actually removed.
 */
export function deleteTask(runId: string): { ok: boolean; reason?: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return { ok: false, reason: 'invalid runId' };
  const meta = readTaskMeta(runId);
  if (meta && (meta.status === 'queued' || meta.status === 'running')) {
    return {
      ok: false,
      reason: `task is still ${meta.status} — cancel it first via SIGTERM (its pid is recorded in meta.json), then delete.`,
    };
  }
  const dir = getTaskDir(runId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Bulk cleanup: delete every task in a terminal state (succeeded /
 * failed / timed_out / cancelled / lost) older than `olderThanMs`.
 * Default cutoff = 24 hours so the panel doesn't accumulate forever.
 * Running / queued tasks are always preserved. Returns counts for
 * UI feedback.
 */
export function pruneCompletedTasks(olderThanMs: number = 24 * 60 * 60 * 1000): {
  deleted: number;
  skipped: number;
} {
  const cutoff = Date.now() - olderThanMs;
  const all = listTasks();
  let deleted = 0;
  let skipped = 0;
  for (const t of all) {
    if (!isTerminalTaskStatus(t.status)) continue;
    const ageRef = t.endedAt ?? t.lastEventAt ?? t.createdAt;
    if (ageRef > cutoff) {
      skipped++;
      continue;
    }
    const result = deleteTask(t.runId);
    if (result.ok) deleted++;
    else skipped++;
  }
  return { deleted, skipped };
}

export function listTasks(): TaskRecord[] {
  // Walk both the primary tasks dir and the legacy ~/.franklin/tasks/
  // location so `franklin task list` keeps showing legacy tasks until
  // their dirs are cleaned up. Dedupe by runId (first-wins, primary
  // ordered first) — protects against the unlikely case of the same
  // runId existing in both locations.
  const dirs = [getTasksDir()];
  if (process.env.FRANKLIN_HOME === undefined) dirs.push(getLegacyTasksDir());

  const seen = new Set<string>();
  const out: TaskRecord[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // Skip junk like .DS_Store — only real per-task subdirectories are valid.
      if (!ent.isDirectory()) continue;
      if (seen.has(ent.name)) continue;
      seen.add(ent.name);
      const meta = readTaskMeta(ent.name);
      if (meta) out.push(meta);
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
