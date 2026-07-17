/**
 * Scheduler persistence — one JSON file per task under
 * ~/.blockrun/scheduler/<id>.json, atomically rewritten (tmp + rename),
 * mirroring the task subsystem's meta.json convention.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import {
  DEFAULT_TTL_MS,
  MAX_LIVE_TASKS,
  MIN_INTERVAL_SEC,
  type ScheduledTask,
} from './types.js';

export function schedulerDir(): string {
  return path.join(BLOCKRUN_DIR, 'scheduler');
}

// The Scheduler capability is constructed once at module load (allCapabilities),
// before any session exists — the current session id is threaded through this
// setter by the agent loop at session start instead of through the factory.
let currentSessionId = 'default';

export function setSchedulerSessionId(id: string): void {
  currentSessionId = id;
}

export function getSchedulerSessionId(): string {
  return currentSessionId;
}

function taskPath(id: string): string {
  return path.join(schedulerDir(), `${id}.json`);
}

export function saveScheduledTask(task: ScheduledTask): void {
  const dir = schedulerDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${task.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskPath(task.id));
}

export function deleteScheduledTask(id: string): boolean {
  try {
    fs.unlinkSync(taskPath(id));
    return true;
  } catch {
    return false;
  }
}

/** All non-expired tasks, pruning expired files as a side effect. */
export function listScheduledTasks(): ScheduledTask[] {
  let files: string[];
  try {
    files = fs.readdirSync(schedulerDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  const tasks: ScheduledTask[] = [];
  for (const file of files) {
    try {
      const task = JSON.parse(
        fs.readFileSync(path.join(schedulerDir(), file), 'utf-8')
      ) as ScheduledTask;
      if (!task?.id || typeof task.prompt !== 'string') continue;
      if (task.expiresAt <= now) {
        deleteScheduledTask(task.id); // expired — prune
        continue;
      }
      tasks.push(task);
    } catch {
      /* skip unreadable entries */
    }
  }
  return tasks.sort((a, b) => a.nextFireAt - b.nextFireAt);
}

export function createScheduledTask(opts: {
  prompt: string;
  intervalSec: number;
  sessionId: string;
  recurring?: boolean;
  durable?: boolean;
  fireImmediately?: boolean;
  ttlMs?: number;
}): ScheduledTask | { error: string } {
  const prompt = opts.prompt.trim();
  if (!prompt) return { error: 'prompt must not be empty' };
  const intervalSec = Math.max(MIN_INTERVAL_SEC, Math.floor(opts.intervalSec));

  const live = listScheduledTasks();
  if (live.length >= MAX_LIVE_TASKS) {
    return { error: `scheduler is full (${MAX_LIVE_TASKS} tasks) — delete one first` };
  }

  const now = Date.now();
  const task: ScheduledTask = {
    id: crypto.randomBytes(6).toString('hex'),
    prompt,
    intervalSec,
    recurring: opts.recurring ?? true,
    durable: opts.durable ?? true,
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    nextFireAt: opts.fireImmediately ? now : now + intervalSec * 1000,
    firedCount: 0,
    enabled: true,
    sessionId: opts.sessionId,
  };
  saveScheduledTask(task);
  return task;
}

/** Record a firing: advance nextFireAt, or disable a one-shot. */
export function markFired(task: ScheduledTask): ScheduledTask {
  const now = Date.now();
  const updated: ScheduledTask = {
    ...task,
    lastFiredAt: now,
    firedCount: task.firedCount + 1,
    // Anchor the next slot to now, not to the missed slot — a task that
    // slept through 10 intervals fires once, not 10 times.
    nextFireAt: now + task.intervalSec * 1000,
    enabled: task.recurring,
  };
  if (!updated.enabled) {
    deleteScheduledTask(task.id);
  } else {
    saveScheduledTask(updated);
  }
  return updated;
}
