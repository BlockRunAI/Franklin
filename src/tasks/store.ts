import fs from 'node:fs';
import type { TaskRecord, TaskEventRecord } from './types.js';
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
