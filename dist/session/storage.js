/**
 * Session persistence for runcode.
 * Saves conversation history as JSONL for resume capability.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
const MAX_SESSIONS = 20; // Keep last 20 sessions
let resolvedSessionsDir = null;
function getSessionsDir() {
    if (resolvedSessionsDir)
        return resolvedSessionsDir;
    const preferred = path.join(BLOCKRUN_DIR, 'sessions');
    const fallback = path.join(os.tmpdir(), 'runcode', 'sessions');
    for (const dir of [preferred, fallback]) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            resolvedSessionsDir = dir;
            return dir;
        }
        catch {
            // Try the next candidate.
        }
    }
    // If both locations fail, keep the preferred path so the original error
    // surfaces from the caller rather than hiding the failure.
    resolvedSessionsDir = preferred;
    return resolvedSessionsDir;
}
function sessionPath(id) {
    return path.join(getSessionsDir(), `${id}.jsonl`);
}
/** Get the absolute path to a session's JSONL file (for external readers like search). */
export function getSessionFilePath(id) {
    return sessionPath(id);
}
function metaPath(id) {
    return path.join(getSessionsDir(), `${id}.meta.json`);
}
function withWritableSessionDir(action) {
    const preferred = path.join(BLOCKRUN_DIR, 'sessions');
    const fallback = path.join(os.tmpdir(), 'runcode', 'sessions');
    try {
        action();
    }
    catch (err) {
        const code = err.code;
        const shouldFallback = (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') &&
            resolvedSessionsDir === preferred;
        if (!shouldFallback)
            throw err;
        fs.mkdirSync(fallback, { recursive: true });
        resolvedSessionsDir = fallback;
        action();
    }
}
/**
 * Create a new session ID based on timestamp.
 */
export function createSessionId() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const suffix = randomUUID().slice(0, 8);
    return `session-${ts}-${suffix}`;
}
/**
 * Save a message to the session transcript (append-only JSONL).
 */
export function appendToSession(sessionId, message) {
    const line = JSON.stringify(message) + '\n';
    withWritableSessionDir(() => {
        fs.appendFileSync(sessionPath(sessionId), line);
    });
}
/**
 * Update session metadata.
 */
export function updateSessionMeta(sessionId, meta) {
    withWritableSessionDir(() => {
        const existing = loadSessionMeta(sessionId);
        const updated = {
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
        };
        fs.writeFileSync(metaPath(sessionId), JSON.stringify(updated, null, 2));
    });
}
/**
 * Load session metadata.
 */
export function loadSessionMeta(sessionId) {
    try {
        return JSON.parse(fs.readFileSync(metaPath(sessionId), 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Load full session history from JSONL.
 */
export function loadSessionHistory(sessionId) {
    try {
        const content = fs.readFileSync(sessionPath(sessionId), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const results = [];
        for (const line of lines) {
            try {
                results.push(JSON.parse(line));
            }
            catch {
                // Skip corrupted lines — partial writes from crashes
                continue;
            }
        }
        return results;
    }
    catch {
        return [];
    }
}
/**
 * List all saved sessions, newest first.
 */
export function listSessions() {
    const sessionsDir = getSessionsDir();
    try {
        const files = fs.readdirSync(sessionsDir)
            .filter(f => f.endsWith('.meta.json'));
        const metas = [];
        for (const file of files) {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'));
                metas.push(meta);
            }
            catch { /* skip corrupted */ }
        }
        // Filter out ghost sessions (0 messages)
        const filtered = metas.filter(m => m.messageCount > 0);
        return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    catch {
        return [];
    }
}
/**
 * Prune old sessions beyond MAX_SESSIONS.
 */
/**
 * Prune old sessions beyond MAX_SESSIONS.
 * Accepts optional activeSessionId to protect from deletion.
 */
export function pruneOldSessions(activeSessionId) {
    const sessions = listSessions();
    if (sessions.length <= MAX_SESSIONS)
        return;
    const toDelete = sessions
        .slice(MAX_SESSIONS)
        .filter(s => s.id !== activeSessionId); // Never delete active session
    for (const s of toDelete) {
        try {
            fs.unlinkSync(sessionPath(s.id));
        }
        catch { /* ok */ }
        try {
            fs.unlinkSync(metaPath(s.id));
        }
        catch { /* ok */ }
    }
    // Also clean up ghost sessions (0 messages, older than 5 minutes)
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    for (const s of sessions) {
        if (s.id === activeSessionId)
            continue;
        if (s.messageCount === 0 && s.createdAt < fiveMinAgo) {
            try {
                fs.unlinkSync(sessionPath(s.id));
            }
            catch { /* ok */ }
            try {
                fs.unlinkSync(metaPath(s.id));
            }
            catch { /* ok */ }
        }
    }
}
