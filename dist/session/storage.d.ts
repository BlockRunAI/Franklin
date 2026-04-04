/**
 * Session persistence for runcode.
 * Saves conversation history as JSONL for resume capability.
 */
import type { Dialogue } from '../agent/types.js';
export interface SessionMeta {
    id: string;
    model: string;
    workDir: string;
    createdAt: number;
    updatedAt: number;
    turnCount: number;
    messageCount: number;
}
/**
 * Create a new session ID based on timestamp.
 */
export declare function createSessionId(): string;
/**
 * Save a message to the session transcript (append-only JSONL).
 */
export declare function appendToSession(sessionId: string, message: Dialogue): void;
/**
 * Update session metadata.
 */
export declare function updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void;
/**
 * Load session metadata.
 */
export declare function loadSessionMeta(sessionId: string): SessionMeta | null;
/**
 * Load full session history from JSONL.
 */
export declare function loadSessionHistory(sessionId: string): Dialogue[];
/**
 * List all saved sessions, newest first.
 */
export declare function listSessions(): SessionMeta[];
/**
 * Prune old sessions beyond MAX_SESSIONS.
 */
export declare function pruneOldSessions(): void;
