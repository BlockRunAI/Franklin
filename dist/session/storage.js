/**
 * Session persistence for runcode.
 * Saves conversation history as JSONL for resume capability.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
const SESSIONS_DIR = path.join(BLOCKRUN_DIR, 'sessions');
const MAX_SESSIONS = 20; // Keep last 20 sessions
function ensureDir() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
function sessionPath(id) {
    return path.join(SESSIONS_DIR, `${id}.jsonl`);
}
function metaPath(id) {
    return path.join(SESSIONS_DIR, `${id}.meta.json`);
}
/**
 * Create a new session ID based on timestamp.
 */
export function createSessionId() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `session-${ts}`;
}
/**
 * Save a message to the session transcript (append-only JSONL).
 */
export function appendToSession(sessionId, message) {
    ensureDir();
    const line = JSON.stringify(message) + '\n';
    fs.appendFileSync(sessionPath(sessionId), line);
}
/**
 * Update session metadata.
 */
export function updateSessionMeta(sessionId, meta) {
    ensureDir();
    const existing = loadSessionMeta(sessionId);
    const updated = {
        id: sessionId,
        model: meta.model || existing?.model || 'unknown',
        workDir: meta.workDir || existing?.workDir || '',
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        turnCount: meta.turnCount ?? existing?.turnCount ?? 0,
        messageCount: meta.messageCount ?? existing?.messageCount ?? 0,
    };
    fs.writeFileSync(metaPath(sessionId), JSON.stringify(updated, null, 2));
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
        return lines.map(line => JSON.parse(line));
    }
    catch {
        return [];
    }
}
/**
 * List all saved sessions, newest first.
 */
export function listSessions() {
    ensureDir();
    try {
        const files = fs.readdirSync(SESSIONS_DIR)
            .filter(f => f.endsWith('.meta.json'));
        const metas = [];
        for (const file of files) {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
                metas.push(meta);
            }
            catch { /* skip corrupted */ }
        }
        return metas.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    catch {
        return [];
    }
}
/**
 * Prune old sessions beyond MAX_SESSIONS.
 */
export function pruneOldSessions() {
    const sessions = listSessions();
    if (sessions.length <= MAX_SESSIONS)
        return;
    const toDelete = sessions.slice(MAX_SESSIONS);
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
}
