/**
 * Document memory — curated markdown files with identity-keyed scoping.
 *
 * Layout under ~/.blockrun/memory/:
 *   MEMORY.md                              global, cross-project facts
 *   <slug>-<hash8>/MEMORY.md               workspace-scoped (curated)
 *   <slug>-<hash8>/sessions/YYYY-MM-DD-*.md  per-session logs (decaying)
 *   trading-<chain>-<addr8>/JOURNAL.md     trade journal (curated)
 *   trading-<chain>-<addr8>/theses/<asset>.md  one thesis file per asset
 *
 * Identity keying: a workspace is keyed by its git origin (org/repo form)
 * so clones and worktrees of the same repo share memory; non-repos fall
 * back to the directory path. Trading memory is keyed by WALLET ADDRESS —
 * the journal follows the money, not the directory.
 *
 * This subsystem is additive to the Brain entity graph (src/brain/): the
 * graph answers "what do I know about entity X", documents answer "what
 * was my SOL thesis" / "what did we do last week". MemoryRecall facades
 * both. Kill switch: FRANKLIN_MEMORY=0.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BLOCKRUN_DIR } from '../config.js';

export function memoryEnabled(): boolean {
  return process.env.FRANKLIN_MEMORY !== '0';
}

export function memoryRoot(): string {
  return path.join(BLOCKRUN_DIR, 'memory');
}

export function globalMemoryPath(): string {
  return path.join(memoryRoot(), 'MEMORY.md');
}

// ─── Identity keying ───────────────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
}

/** org/repo from the git origin remote, or null outside a repo. */
export function repoIdentity(workDir: string): string | null {
  try {
    const url = execFileSync('git', ['-C', workDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : url || null;
  } catch {
    return null;
  }
}

export function workspaceKey(workDir: string): { slug: string; hash8: string } {
  const identity = repoIdentity(workDir) ?? workDir;
  return {
    slug: slugify(path.basename(identity)),
    hash8: crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8),
  };
}

export function workspaceDir(workDir: string): string {
  const { slug, hash8 } = workspaceKey(workDir);
  return path.join(memoryRoot(), `${slug}-${hash8}`);
}

export function workspaceMemoryPath(workDir: string): string {
  return path.join(workspaceDir(workDir), 'MEMORY.md');
}

export function sessionLogsDir(workDir: string): string {
  return path.join(workspaceDir(workDir), 'sessions');
}

export function tradingDir(chain: string, address: string): string {
  return path.join(memoryRoot(), `trading-${chain}-${address.slice(0, 8).toLowerCase()}`);
}

export function tradingJournalPath(chain: string, address: string): string {
  return path.join(tradingDir(chain, address), 'JOURNAL.md');
}

export function thesisPath(chain: string, address: string, asset: string): string {
  return path.join(tradingDir(chain, address), 'theses', `${slugify(asset)}.md`);
}

// ─── Writes ────────────────────────────────────────────────────────────────

function appendToFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text.endsWith('\n') ? text : text + '\n');
}

/**
 * Append a note under a markdown heading, creating file/heading as needed.
 * Used by /remember and the trading capture.
 */
export function appendUnderHeading(filePath: string, heading: string, note: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- (${stamp}) ${note.trim()}`;
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch { /* new file */ }

  const headingLine = `## ${heading}`;
  if (!content.includes(headingLine)) {
    appendToFile(filePath, `${content && !content.endsWith('\n') ? '\n' : ''}${headingLine}\n${line}`);
    return;
  }
  // Insert directly after the heading's existing block (before the next ##).
  const lines = content.split('\n');
  const idx = lines.findIndex(l => l.trim() === headingLine);
  let insertAt = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { insertAt = i; break; }
  }
  lines.splice(insertAt, 0, line);
  fs.writeFileSync(filePath, lines.join('\n'));
}

/** Dated session log path for today. */
export function sessionLogPath(workDir: string, sessionId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(sessionLogsDir(workDir), `${day}-${sessionId.slice(0, 8)}.md`);
}

export function writeSessionLog(workDir: string, sessionId: string, content: string): void {
  const p = sessionLogPath(workDir, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.endsWith('\n') ? content : content + '\n');
}

// ─── Reads (for the indexer) ───────────────────────────────────────────────

export interface MemoryFileRef {
  path: string;
  /** Curated files never decay; session logs do. */
  scope: 'global' | 'workspace' | 'trading' | 'session';
  mtimeMs: number;
}

export function listMemoryFiles(workDir: string): MemoryFileRef[] {
  const refs: MemoryFileRef[] = [];
  const push = (p: string, scope: MemoryFileRef['scope']) => {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) refs.push({ path: p, scope, mtimeMs: stat.mtimeMs });
    } catch { /* missing */ }
  };

  push(globalMemoryPath(), 'global');
  push(workspaceMemoryPath(workDir), 'workspace');
  try {
    for (const f of fs.readdirSync(sessionLogsDir(workDir))) {
      if (f.endsWith('.md')) push(path.join(sessionLogsDir(workDir), f), 'session');
    }
  } catch { /* no session logs yet */ }

  // Every trading identity the user has — journals + theses.
  try {
    for (const dir of fs.readdirSync(memoryRoot())) {
      if (!dir.startsWith('trading-')) continue;
      const base = path.join(memoryRoot(), dir);
      push(path.join(base, 'JOURNAL.md'), 'trading');
      try {
        for (const f of fs.readdirSync(path.join(base, 'theses'))) {
          if (f.endsWith('.md')) push(path.join(base, 'theses', f), 'trading');
        }
      } catch { /* no theses */ }
    }
  } catch { /* no memory root yet */ }

  return refs;
}
