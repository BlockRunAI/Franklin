/**
 * Workflow tracker — SQLite-based dedup, stats, and history.
 * Shared by all workflows. Each workflow gets its own table namespace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import type { WorkflowStats } from './types.js';

// Use JSON file storage instead of SQLite to avoid native dependency.
// SQLite would be better for queries but adds install complexity.

interface TrackerEntry {
  workflow: string;
  action: string;
  key: string;
  metadata: Record<string, unknown>;
  costUsd: number;
  createdAt: string;
}

const DB_DIR = path.join(BLOCKRUN_DIR, 'workflows');

function getDbPath(workflow: string): string {
  return path.join(DB_DIR, `${workflow}.jsonl`);
}

function ensureDir(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

/** Append a tracked action */
export function trackAction(
  workflow: string,
  action: string,
  key: string,
  metadata: Record<string, unknown> = {},
  costUsd = 0,
): void {
  ensureDir();
  const entry: TrackerEntry = {
    workflow,
    action,
    key,
    metadata,
    costUsd,
    createdAt: new Date().toISOString(),
  };
  fs.appendFileSync(getDbPath(workflow), JSON.stringify(entry) + '\n');
}

/** Check if a key was already processed (dedup) */
export function isDuplicate(workflow: string, key: string): boolean {
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return false;
  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TrackerEntry;
        if (entry.key === key) return true;
      } catch { /* skip malformed */ }
    }
  } catch { /* no db */ }
  return false;
}

/** Get workflow stats */
export function getStats(workflow: string): WorkflowStats {
  const dbPath = getDbPath(workflow);
  const stats: WorkflowStats = {
    totalRuns: 0,
    totalActions: 0,
    totalCostUsd: 0,
    todayActions: 0,
    todayCostUsd: 0,
    byAction: {},
  };

  if (!fs.existsSync(dbPath)) return stats;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TrackerEntry;
        stats.totalActions++;
        stats.totalCostUsd += entry.costUsd;
        stats.byAction[entry.action] = (stats.byAction[entry.action] || 0) + 1;

        if (entry.action === 'run_start') stats.totalRuns++;
        if (entry.createdAt.startsWith(today)) {
          stats.todayActions++;
          stats.todayCostUsd += entry.costUsd;
        }
        stats.lastRun = entry.createdAt;
      } catch { /* skip */ }
    }
  } catch { /* no db */ }

  return stats;
}

/** Get recent entries for a workflow */
export function getRecent(workflow: string, limit = 20): TrackerEntry[] {
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return [];

  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => {
      try { return JSON.parse(line) as TrackerEntry; } catch { return null; }
    }).filter(Boolean) as TrackerEntry[];
  } catch {
    return [];
  }
}

/** Get entries by action type (e.g. "lead" for lead tracking) */
export function getByAction(workflow: string, action: string): TrackerEntry[] {
  const dbPath = getDbPath(workflow);
  if (!fs.existsSync(dbPath)) return [];

  try {
    const lines = fs.readFileSync(dbPath, 'utf-8').split('\n').filter(Boolean);
    return lines.map(line => {
      try { return JSON.parse(line) as TrackerEntry; } catch { return null; }
    }).filter((e): e is TrackerEntry => e !== null && e.action === action);
  } catch {
    return [];
  }
}
