/**
 * Live-agent registry — which sessions are running RIGHT NOW, and where.
 *
 * Session JSONL on disk can't distinguish a live session from a dead one;
 * this registry can: one small JSON per session under ~/.blockrun/agents/,
 * refreshed on every state change, with pid-based reconciliation (the same
 * liveness model as the task subsystem). The panel's Agents tab reads it
 * to render the fleet; serve's AgentHost and the CLI loop both write it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import type { AgentRunState } from '../events/types.js';

export interface LiveAgentRecord {
  sessionId: string;
  pid: number;
  state: AgentRunState;
  label: string;
  model: string;
  /** Which process type hosts the loop — panel can only drive 'serve' agents. */
  host: 'serve' | 'cli';
  startedAt: number;
  updatedAt: number;
  /** Count of approvals parked waiting for a human. */
  pendingApprovals?: number;
}

export function liveAgentsDir(): string {
  return path.join(BLOCKRUN_DIR, 'agents');
}

function recordPath(sessionId: string): string {
  return path.join(liveAgentsDir(), `${sessionId}.json`);
}

export function writeLiveAgent(record: LiveAgentRecord): void {
  try {
    fs.mkdirSync(liveAgentsDir(), { recursive: true });
    const tmp = path.join(liveAgentsDir(), `.${record.sessionId}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ ...record, updatedAt: Date.now() }));
    fs.renameSync(tmp, recordPath(record.sessionId));
  } catch {
    /* registry is best-effort — never break the loop over it */
  }
}

export function removeLiveAgent(sessionId: string): void {
  try {
    fs.unlinkSync(recordPath(sessionId));
  } catch {
    /* already gone */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * All records, with dead-pid reconciliation: a record whose process is gone
 * flips to 'failed' if it claimed to be running (crash without cleanup), and
 * terminal records older than a day are pruned.
 */
export function readLiveAgents(): LiveAgentRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(liveAgentsDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LiveAgentRecord[] = [];
  const dayAgo = Date.now() - 86_400_000;
  for (const f of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(liveAgentsDir(), f), 'utf-8')) as LiveAgentRecord;
      if (!record?.sessionId) continue;
      const terminal = record.state === 'completed' || record.state === 'failed';
      if (!terminal && !pidAlive(record.pid)) {
        record.state = 'failed';
        writeLiveAgent(record); // persist the reconciliation
      }
      if ((record.state === 'completed' || record.state === 'failed') && record.updatedAt < dayAgo) {
        removeLiveAgent(record.sessionId); // prune stale terminals
        continue;
      }
      out.push(record);
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
