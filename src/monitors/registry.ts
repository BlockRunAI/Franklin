/**
 * Monitor registry — session-scoped bookkeeping for line-oriented monitors.
 *
 * A monitor is a detached background command (task subsystem) whose log is
 * swept at turn boundaries; new lines land in the next turn's user content
 * as a bracketed block. The registry owns read offsets so the task-side
 * meta.json single-writer contract (runner only) stays intact.
 *
 * Volume cutoff: a monitor producing more than MAX_LINES_PER_SWEEP lines in
 * one sweep, or MAX_EVENTS_PER_SESSION lines overall, is auto-paused with a
 * note — a flooding monitor must not drown the conversation. Restart it
 * with a tighter filter pattern instead.
 */

import fs from 'node:fs';
import { taskLogPath } from '../tasks/paths.js';
import { readTaskMeta } from '../tasks/store.js';
import { isTerminalTaskStatus } from '../tasks/types.js';

export const MAX_LINES_PER_SWEEP = 50;
export const MAX_EVENTS_PER_SESSION = 200;

export interface MonitorEntry {
  taskRunId: string;
  label: string;
  pattern?: RegExp;
  byteOffset: number;
  eventsDelivered: number;
  paused: boolean;
  pausedReason?: string;
}

const monitors = new Map<string, MonitorEntry>();

export function resetMonitors(): void {
  monitors.clear();
}

export function registerMonitor(entry: {
  taskRunId: string;
  label: string;
  pattern?: RegExp;
}): void {
  monitors.set(entry.taskRunId, {
    ...entry,
    byteOffset: 0,
    eventsDelivered: 0,
    paused: false,
  });
}

export function getMonitor(taskRunId: string): MonitorEntry | undefined {
  return monitors.get(taskRunId);
}

export function removeMonitor(taskRunId: string): boolean {
  return monitors.delete(taskRunId);
}

export function listMonitors(): MonitorEntry[] {
  return [...monitors.values()];
}

export interface MonitorSweepResult {
  /** Ready-to-append blocks, one per monitor with fresh lines. */
  blocks: string[];
}

/**
 * Read fresh log lines for every active monitor. Called at turn boundaries
 * by the agent loop; safe to call often (offset-tracked, no re-reads).
 */
export function sweepMonitors(): MonitorSweepResult {
  const blocks: string[] = [];

  for (const entry of monitors.values()) {
    if (entry.paused) continue;

    const meta = readTaskMeta(entry.taskRunId);
    const logPath = taskLogPath(entry.taskRunId);

    let fresh = '';
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > entry.byteOffset) {
        const fd = fs.openSync(logPath, 'r');
        try {
          const len = stat.size - entry.byteOffset;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, entry.byteOffset);
          fresh = buf.toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
        entry.byteOffset = stat.size;
      }
    } catch {
      /* log not readable yet — nothing fresh */
    }

    let lines = fresh.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    if (entry.pattern) {
      const re = entry.pattern;
      lines = lines.filter(l => re.test(l));
    }

    const ended = meta ? isTerminalTaskStatus(meta.status) : false;

    if (lines.length > MAX_LINES_PER_SWEEP) {
      const dropped = lines.length - MAX_LINES_PER_SWEEP;
      lines = lines.slice(0, MAX_LINES_PER_SWEEP);
      entry.paused = true;
      entry.pausedReason = `flooded (${dropped} lines dropped in one sweep) — restart with a tighter filter pattern`;
    }

    entry.eventsDelivered += lines.length;
    if (!entry.paused && entry.eventsDelivered > MAX_EVENTS_PER_SESSION) {
      entry.paused = true;
      entry.pausedReason = `delivered ${entry.eventsDelivered} events this session — restart with a tighter filter pattern`;
    }

    if (lines.length > 0 || ended || entry.paused) {
      const parts: string[] = [];
      if (lines.length > 0) parts.push(lines.join('\n'));
      if (entry.paused) parts.push(`(monitor auto-paused: ${entry.pausedReason})`);
      if (ended && meta) {
        parts.push(`(monitored command ended: ${meta.status}${meta.exitCode != null ? `, exit ${meta.exitCode}` : ''})`);
      }
      blocks.push(`[monitor: ${entry.label}]\n${parts.join('\n')}`);
    }

    if (ended) monitors.delete(entry.taskRunId);
  }

  return { blocks };
}
