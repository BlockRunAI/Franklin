import fs from 'node:fs';
import type { TaskRecord, TaskEventRecord } from './types.js';
import { isTerminalTaskStatus } from './types.js';
import {
  ensureTaskDir,
  taskMetaPath,
  taskEventsPath,
} from './paths.js';

export function writeTaskMeta(record: TaskRecord): void {
  ensureTaskDir(record.runId);
  const target = taskMetaPath(record.runId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, target);
}

export function readTaskMeta(runId: string): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(taskMetaPath(runId), 'utf-8')) as TaskRecord;
  } catch {
    return null;
  }
}

export function appendTaskEvent(runId: string, event: TaskEventRecord): void {
  ensureTaskDir(runId);
  fs.appendFileSync(taskEventsPath(runId), JSON.stringify(event) + '\n');
}

export function readTaskEvents(runId: string): TaskEventRecord[] {
  try {
    const raw = fs.readFileSync(taskEventsPath(runId), 'utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as TaskEventRecord);
  } catch {
    return [];
  }
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
  } else if (isTerminalTaskStatus(event.kind as never)) {
    next.status = event.kind as TaskRecord['status'];
    next.endedAt = event.at;
    if (event.summary !== undefined) next.terminalSummary = event.summary;
  }

  appendTaskEvent(runId, event);
  writeTaskMeta(next);
  return next;
}
