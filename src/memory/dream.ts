/**
 * /dream — consolidation. Distills accumulated session logs into the
 * curated workspace MEMORY.md (deduplicated, organized), then archives
 * the consumed logs. Auto-gated: runs only when enough time and sessions
 * have accumulated, with a cross-process lock so concurrent sessions
 * can't double-dream.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ModelClient } from '../agent/llm.js';
import { recordUsage } from '../stats/tracker.js';
import { estimateCost } from '../pricing.js';
import { memoryEnabled, sessionLogsDir, workspaceDir, workspaceMemoryPath } from './store.js';

export const DREAM_MIN_HOURS = 4;
export const DREAM_MIN_SESSIONS = 3;
const LOCK_STALE_MS = 3600_000;

function lockPath(workDir: string): string {
  return path.join(workspaceDir(workDir), 'dream.lock');
}

function lastDreamPath(workDir: string): string {
  return path.join(workspaceDir(workDir), '.last-dream');
}

export function dreamGatesPass(workDir: string, now = Date.now()): boolean {
  if (!memoryEnabled()) return false;
  let logs: string[] = [];
  try {
    logs = fs.readdirSync(sessionLogsDir(workDir)).filter(f => f.endsWith('.md'));
  } catch {
    return false;
  }
  if (logs.length < DREAM_MIN_SESSIONS) return false;
  try {
    const last = Number(fs.readFileSync(lastDreamPath(workDir), 'utf-8'));
    if (Number.isFinite(last) && now - last < DREAM_MIN_HOURS * 3600_000) return false;
  } catch { /* never dreamed */ }
  return true;
}

function acquireLock(workDir: string): boolean {
  const p = lockPath(workDir);
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false; // held
    fs.unlinkSync(p); // stale — reclaim
  } catch { /* no lock */ }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(workDir: string): void {
  try {
    fs.unlinkSync(lockPath(workDir));
  } catch { /* already gone */ }
}

const DREAM_PROMPT = (curated: string, logs: string) => `You are consolidating an agent's memory. Below is the CURATED long-term memory
file followed by accumulated raw session logs. Produce the NEW COMPLETE curated
memory file: merge durable knowledge from the logs into the curated content,
deduplicate aggressively, drop stale/superseded observations, keep it organized
under ## headings, and stay under 6000 characters. Output ONLY the new file
content (markdown, starting with a # title).

=== CURATED MEMORY ===
${curated || '(empty)'}

=== SESSION LOGS ===
${logs}`;

export interface DreamResult {
  consolidated: boolean;
  logsConsumed: number;
  reason?: string;
}

export async function runDream(opts: {
  client: ModelClient;
  model: string;
  workDir: string;
  signal?: AbortSignal;
  /** Skip the time/count gates (explicit /dream command). */
  force?: boolean;
}): Promise<DreamResult> {
  if (!memoryEnabled()) return { consolidated: false, logsConsumed: 0, reason: 'memory disabled' };
  if (!opts.force && !dreamGatesPass(opts.workDir)) {
    return { consolidated: false, logsConsumed: 0, reason: 'gates not met (needs ≥3 session logs and ≥4h since last dream)' };
  }
  if (!acquireLock(opts.workDir)) {
    return { consolidated: false, logsConsumed: 0, reason: 'another session is consolidating' };
  }

  try {
    const dir = sessionLogsDir(opts.workDir);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    } catch { /* none */ }
    if (files.length === 0) return { consolidated: false, logsConsumed: 0, reason: 'no session logs' };

    let curated = '';
    try {
      curated = fs.readFileSync(workspaceMemoryPath(opts.workDir), 'utf-8');
    } catch { /* fresh */ }

    const logs = files
      .map(f => {
        try {
          return `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 4000)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 40_000);

    const { content, usage } = await opts.client.complete(
      {
        model: opts.model,
        messages: [{ role: 'user', content: DREAM_PROMPT(curated, logs) }],
        max_tokens: 2048,
        stream: true,
      },
      opts.signal ?? new AbortController().signal
    );
    try {
      recordUsage(opts.model, usage.inputTokens, usage.outputTokens, estimateCost(opts.model, usage.inputTokens, usage.outputTokens), 0);
    } catch { /* best-effort */ }

    const newMemory = content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('\n')
      .trim();
    if (!newMemory.startsWith('#')) {
      return { consolidated: false, logsConsumed: 0, reason: 'consolidation produced no usable file' };
    }

    fs.writeFileSync(workspaceMemoryPath(opts.workDir), newMemory.slice(0, 12_000) + '\n');
    // Archive consumed logs (kept for forensics, out of the search path).
    const archive = path.join(dir, 'archived');
    fs.mkdirSync(archive, { recursive: true });
    for (const f of files) {
      try {
        fs.renameSync(path.join(dir, f), path.join(archive, f));
      } catch { /* best-effort */ }
    }
    fs.writeFileSync(lastDreamPath(opts.workDir), String(Date.now()));
    return { consolidated: true, logsConsumed: files.length };
  } finally {
    releaseLock(opts.workDir);
  }
}
