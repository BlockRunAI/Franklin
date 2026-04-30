/**
 * Per-task on-disk layout under $FRANKLIN_HOME/tasks/<runId>/.
 *   meta.json    — single TaskRecord, atomically rewritten
 *   events.jsonl — append-only event log
 *   log.txt      — child process stdout/stderr
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function franklinHome(): string {
  return process.env.FRANKLIN_HOME || path.join(os.homedir(), '.franklin');
}

export function getTasksDir(): string {
  return path.join(franklinHome(), 'tasks');
}

export function getTaskDir(runId: string): string {
  return path.join(getTasksDir(), runId);
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
