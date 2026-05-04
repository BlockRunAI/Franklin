/**
 * Per-task on-disk layout under $FRANKLIN_HOME/tasks/<runId>/.
 *   meta.json    — single TaskRecord, atomically rewritten
 *   events.jsonl — append-only event log
 *   log.txt      — child process stdout/stderr
 *
 * Storage location: defaults to BLOCKRUN_DIR (~/.blockrun), matching
 * every other persistent state in the codebase (sessions, audit, stats,
 * brain, etc.). Earlier releases used ~/.franklin instead, so we
 * lazily fall back to that legacy directory on reads when a task isn't
 * found in the primary location. New tasks always write to the primary.
 *
 * Why a lazy fallback instead of a startup migration: a long-running
 * task runner (`franklin _task-runner <runId>`) captures its task dir
 * path in memory at spawn and continues writing there for the duration
 * of the run. Verified 2026-05-04: an in-flight ETL task at PID 59095
 * had been writing to ~/.franklin/tasks/ for 4 minutes, with ~10 hours
 * of progress still ahead. Moving the directory mid-flight would
 * orphan its writes; the fallback path lets new CLI commands keep
 * reading legacy task state without disturbing an active runner.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

const LEGACY_FRANKLIN_HOME = path.join(os.homedir(), '.franklin');

function franklinHome(): string {
  return process.env.FRANKLIN_HOME || BLOCKRUN_DIR;
}

export function getTasksDir(): string {
  return path.join(franklinHome(), 'tasks');
}

export function getLegacyTasksDir(): string {
  return path.join(LEGACY_FRANKLIN_HOME, 'tasks');
}

export function getTaskDir(runId: string): string {
  // Prefer the primary location. If a task already exists in the
  // legacy ~/.franklin/tasks/ — either created by an older release or
  // by a runner subprocess started before this version was installed —
  // continue to read/write there until it completes, so we don't strand
  // its in-flight events.jsonl + meta.json writes.
  const primary = path.join(getTasksDir(), runId);
  if (fs.existsSync(primary)) return primary;
  if (process.env.FRANKLIN_HOME === undefined) {
    const legacy = path.join(getLegacyTasksDir(), runId);
    if (fs.existsSync(legacy)) return legacy;
  }
  return primary;
}

export function ensureTaskDir(runId: string): string {
  const dir = getTaskDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function taskMetaPath(runId: string): string {
  return path.join(getTaskDir(runId), 'meta.json');
}

export function taskEventsPath(runId: string): string {
  return path.join(getTaskDir(runId), 'events.jsonl');
}

export function taskLogPath(runId: string): string {
  return path.join(getTaskDir(runId), 'log.txt');
}
