/**
 * Structured failure logging for self-evolution analysis.
 * Append-only JSONL at ~/.blockrun/failures.jsonl (capped 500 records).
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

export interface FailureRecord {
  timestamp: number;
  model: string;
  failureType: 'tool_error' | 'model_error' | 'permission_denied' | 'agent_loop';
  toolName?: string;
  errorMessage: string;
  recoveryAction?: string;
}

const FAILURES_FILE = path.join(BLOCKRUN_DIR, 'failures.jsonl');
const MAX_RECORDS = 500;

export function recordFailure(record: FailureRecord): void {
  try {
    fs.mkdirSync(path.dirname(FAILURES_FILE), { recursive: true });
    fs.appendFileSync(FAILURES_FILE, JSON.stringify(record) + '\n');

    // Trim to MAX_RECORDS (only check periodically to avoid constant reads)
    if (Math.random() < 0.1) {
      trimFailures();
    }
  } catch {
    // Fire-and-forget — never block the critical path
  }
}

function trimFailures(): void {
  try {
    if (!fs.existsSync(FAILURES_FILE)) return;
    const lines = fs.readFileSync(FAILURES_FILE, 'utf-8').trim().split('\n');
    if (lines.length > MAX_RECORDS) {
      const trimmed = lines.slice(-MAX_RECORDS).join('\n') + '\n';
      fs.writeFileSync(FAILURES_FILE, trimmed);
    }
  } catch {
    // ignore
  }
}

export function loadFailures(limit = 100): FailureRecord[] {
  try {
    if (!fs.existsSync(FAILURES_FILE)) return [];
    const lines = fs.readFileSync(FAILURES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l) as FailureRecord);
  } catch {
    return [];
  }
}

export function getFailureStats(): {
  byTool: Map<string, number>;
  byType: Map<string, number>;
  total: number;
  recentFailures: FailureRecord[];
} {
  const records = loadFailures(500);
  const byTool = new Map<string, number>();
  const byType = new Map<string, number>();

  for (const r of records) {
    if (r.toolName) byTool.set(r.toolName, (byTool.get(r.toolName) ?? 0) + 1);
    byType.set(r.failureType, (byType.get(r.failureType) ?? 0) + 1);
  }

  return {
    byTool,
    byType,
    total: records.length,
    recentFailures: records.slice(-10),
  };
}
