/**
 * Session persistence for Franklin.
 * Saves conversation history as JSONL for resume capability.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import type { Dialogue } from '../agent/types.js';

const MAX_SESSIONS = 20; // Keep last 20 sessions
let resolvedSessionsDir: string | null = null;

// When in-process tests run interactiveSession() with model="local/test*",
// session writes were creating real .jsonl + .meta.json files in the
// user's ~/.blockrun/sessions/ — verified 19 of 33 metas (57.6%) on a
// real machine. Toggled at session start by the agent loop based on the
// model name; defaults to enabled so production never accidentally goes
// silent. No-op writes when disabled — reads still work so resume tests
// can pre-seed state with their own writes if they want to.
let persistenceDisabled = false;

export function setSessionPersistenceDisabled(disabled: boolean): void {
  persistenceDisabled = disabled;
}

export function isSessionPersistenceDisabled(): boolean {
  // Also honor FRANKLIN_NO_PERSIST — a separate env var, deliberately
  // NOT piggybacking on FRANKLIN_NO_AUDIT. test/local.mjs sets
  // FRANKLIN_NO_AUDIT=1 at file level expecting session writes to
  // keep working so resume tests can verify state on disk; that
  // contract has to stay intact. FRANKLIN_NO_PERSIST is used by
  // test/e2e.mjs to block home-dir writes from spawned franklin
  // children. Verified 2026-05-04: prior e2e runs left 3 ghost
  // session metas in the user's ~/.blockrun/sessions/ because real
  // model names (zai/glm-5.1, nvidia/qwen3-coder-480b) escaped
  // isTestFixtureModel()'s name-prefix gate.
  return persistenceDisabled || process.env.FRANKLIN_NO_PERSIST === '1';
}

export interface SessionMeta {
  id: string;
  model: string;
  workDir: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  messageCount: number;
  /**
   * Chain (`base` | `solana`) the session was started on. Captured at
   * session creation so `franklin --resume` can restore the same chain
   * even if the user later changed their default via
   * `franklin solana` / `franklin base`. Verified 2026-05-04: a debug
   * invocation flipped `~/.blockrun/.chain` to `solana`; the next
   * `--resume` silently moved the user from their funded Base wallet
   * to an underfunded Solana wallet. Sessions are wallet-bound by
   * conversation context — switching chains mid-resume is a bug.
   * Optional for back-compat with pre-3.15.35 sessions.
   */
  chain?: 'base' | 'solana';
  // Token & cost tracking (added for per-session insights)
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  savedVsOpusUsd?: number;
  /**
   * Origin channel tag. Unset for regular CLI sessions; set to a string like
   * `telegram:<ownerId>` when the session was started by a non-CLI driver.
   * Lets findLatestSessionByChannel pick up the right session on bot restart.
   */
  channel?: string;
  /**
   * Per-tool invocation counts for this session, aggregated across every
   * turn. Populated by the agent loop at each tool-call batch. Used by the
   * opt-in telemetry subsystem to aggregate vertical-usage signals — do NOT
   * add any tool inputs or outputs here, just the count per tool name.
   */
  toolCallCounts?: Record<string, number>;
  /**
   * Sessions imported from another agent (`franklin migrate`). Imports often
   * exceed MAX_SESSIONS by an order of magnitude (a Claude Code user can
   * easily have 200+ historical sessions); without this flag, the very
   * next `franklin` launch would prune all but the 20 most recent and
   * silently destroy the user's history. pruneOldSessions() skips any
   * meta with imported=true.
   */
  imported?: true;
}

function getSessionsDir(): string {
  if (resolvedSessionsDir) return resolvedSessionsDir;

  const preferred = path.join(BLOCKRUN_DIR, 'sessions');
  const fallback = path.join(os.tmpdir(), 'franklin', 'sessions');

  for (const dir of [preferred, fallback]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      resolvedSessionsDir = dir;
      return dir;
    } catch {
      // Try the next candidate.
    }
  }

  // If both locations fail, keep the preferred path so the original error
  // surfaces from the caller rather than hiding the failure.
  resolvedSessionsDir = preferred;
  return resolvedSessionsDir;
}

function sessionPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.jsonl`);
}

/** Get the absolute path to a session's JSONL file (for external readers like search). */
export function getSessionFilePath(id: string): string {
  return sessionPath(id);
}

function metaPath(id: string): string {
  return path.join(getSessionsDir(), `${id}.meta.json`);
}

function withWritableSessionDir(action: () => void): void {
  const preferred = path.join(BLOCKRUN_DIR, 'sessions');
  const fallback = path.join(os.tmpdir(), 'franklin', 'sessions');

  try {
    action();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const shouldFallback =
      (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') &&
      resolvedSessionsDir === preferred;

    if (!shouldFallback) throw err;

    fs.mkdirSync(fallback, { recursive: true });
    resolvedSessionsDir = fallback;
    action();
  }
}

/**
 * Create a new session ID based on timestamp.
 */
export function createSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const suffix = randomUUID().slice(0, 8);
  return `session-${ts}-${suffix}`;
}

/**
 * Save a message to the session transcript (append-only JSONL).
 */
export function appendToSession(
  sessionId: string,
  message: Dialogue
): void {
  if (isSessionPersistenceDisabled()) return;
  const line = JSON.stringify(message) + '\n';
  withWritableSessionDir(() => {
    fs.appendFileSync(sessionPath(sessionId), line);
  });
}

/**
 * Update session metadata.
 */
export function updateSessionMeta(
  sessionId: string,
  meta: Partial<SessionMeta>
): void {
  if (isSessionPersistenceDisabled()) return;
  withWritableSessionDir(() => {
    const existing = loadSessionMeta(sessionId);
    const updated: SessionMeta = {
      id: sessionId,
      model: meta.model || existing?.model || 'unknown',
      workDir: meta.workDir || existing?.workDir || '',
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      turnCount: meta.turnCount ?? existing?.turnCount ?? 0,
      messageCount: meta.messageCount ?? existing?.messageCount ?? 0,
      inputTokens: meta.inputTokens ?? existing?.inputTokens ?? 0,
      outputTokens: meta.outputTokens ?? existing?.outputTokens ?? 0,
      costUsd: meta.costUsd ?? existing?.costUsd ?? 0,
      savedVsOpusUsd: meta.savedVsOpusUsd ?? existing?.savedVsOpusUsd ?? 0,
      ...(meta.channel !== undefined || existing?.channel !== undefined
        ? { channel: meta.channel ?? existing?.channel }
        : {}),
      // Chain (base / solana) is sticky once set. We never let a later
      // update overwrite an existing value with undefined — that would
      // silently drop the bind-to-original-chain guarantee.
      ...(meta.chain !== undefined || existing?.chain !== undefined
        ? { chain: existing?.chain ?? meta.chain }
        : {}),
      ...(meta.toolCallCounts !== undefined || existing?.toolCallCounts !== undefined
        ? { toolCallCounts: meta.toolCallCounts ?? existing?.toolCallCounts }
        : {}),
      // `imported` is sticky like `chain`: once set by `franklin migrate`
      // it must survive every subsequent update so pruneOldSessions keeps
      // shielding the session from auto-deletion. Without preservation, the
      // first turn added via `--resume` would silently drop the flag.
      ...(meta.imported || existing?.imported ? { imported: true as const } : {}),
    };
    // Atomic write: tmp file + rename. Prevents corruption when parent
    // and sub-agent update the same session meta concurrently.
    // On Windows, renameSync can throw EEXIST/EPERM on older filesystems —
    // fall back to a direct write (non-atomic but still functional) and
    // clean up the orphan tmp file.
    const target = metaPath(sessionId);
    const tmp = target + '.tmp';
    const payload = JSON.stringify(updated, null, 2);
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, target);
    } catch {
      // Best-effort: clean up the orphan tmp, then write target directly.
      try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
      try { fs.writeFileSync(target, payload); } catch { /* give up; stats just get stale */ }
    }
  });
}

/**
 * Load session metadata.
 */
export function loadSessionMeta(sessionId: string): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(sessionId), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load full session history from JSONL.
 */
export function loadSessionHistory(sessionId: string): Dialogue[] {
  try {
    const content = fs.readFileSync(sessionPath(sessionId), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const results: Dialogue[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as Dialogue);
      } catch {
        // Skip corrupted lines — partial writes from crashes
        continue;
      }
    }
    return results;
  } catch {
    return [];
  }
}

function readSessionMetas(includeGhosts = false): SessionMeta[] {
  const sessionsDir = getSessionsDir();
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.meta.json'));
    const metas: SessionMeta[] = [];
    for (const file of files) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(sessionsDir, file), 'utf-8')
        ) as SessionMeta;
        metas.push(meta);
      } catch { /* skip corrupted */ }
    }

    const visible = includeGhosts ? metas : metas.filter(m => m.messageCount > 0);
    return visible.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * List all saved sessions, newest first.
 */
export function listSessions(): SessionMeta[] {
  return readSessionMetas(false);
}

/**
 * Find the latest saved session tagged with a given channel (e.g.
 * `telegram:12345`). Used by non-CLI drivers to resume across process
 * restarts. Returns undefined when no matching session exists.
 */
export function findLatestSessionByChannel(channel: string): SessionMeta | undefined {
  return listSessions().find(m => m.channel === channel);
}

/**
 * Prune old sessions beyond MAX_SESSIONS.
 */
/**
 * Prune old sessions beyond MAX_SESSIONS.
 * Accepts optional activeSessionId to protect from deletion.
 */
export function pruneOldSessions(activeSessionId?: string): void {
  // Only count native sessions toward the MAX_SESSIONS budget. Imported
  // sessions (from `franklin migrate`) are user-owned history and must
  // never be auto-deleted just because the user ran the agent again.
  const native = readSessionMetas(false).filter(s => !s.imported);

  if (native.length > MAX_SESSIONS) {
    const toDelete = native
      .slice(MAX_SESSIONS)
      .filter(s => s.id !== activeSessionId); // Never delete active session
    for (const s of toDelete) {
      try { fs.unlinkSync(sessionPath(s.id)); } catch { /* ok */ }
      try { fs.unlinkSync(metaPath(s.id)); } catch { /* ok */ }
    }
  }

  // Also clean up ghost sessions (0 messages, older than 5 minutes).
  // Skip imported sessions — they may legitimately have messageCount=0
  // if the source file had only attachments/system lines.
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const allSessions = readSessionMetas(true);
  for (const s of allSessions) {
    if (s.id === activeSessionId) continue;
    if (s.imported) continue;
    if (s.messageCount === 0 && s.createdAt < fiveMinAgo) {
      try { fs.unlinkSync(sessionPath(s.id)); } catch { /* ok */ }
      try { fs.unlinkSync(metaPath(s.id)); } catch { /* ok */ }
    }
  }

  // Sweep orphan jsonl files (left over from a session-id format change in
  // earlier releases — meta deleted, jsonl stranded). The pre-3.x naming
  // didn't include the random suffix, so the meta-driven prune above has
  // no record of them and they accumulate forever. Verified on a real
  // user machine: 21 metas, 121 jsonl, 100 orphans = ~1 MB stranded.
  pruneOrphanJsonlFiles(activeSessionId);
}

function pruneOrphanJsonlFiles(activeSessionId?: string): void {
  const dir = getSessionsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // Sessions dir doesn't exist yet — nothing to prune.
  }

  const knownIds = new Set<string>();
  for (const f of entries) {
    if (f.endsWith('.meta.json')) {
      knownIds.add(f.slice(0, -'.meta.json'.length));
    }
  }

  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    if (id === activeSessionId) continue;
    if (knownIds.has(id)) continue;
    // No meta partner — orphan. Delete the jsonl.
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ }
  }
}
