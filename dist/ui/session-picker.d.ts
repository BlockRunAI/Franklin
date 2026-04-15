/**
 * Interactive session picker for `franklin resume`.
 * Lists recent sessions (newest first) and returns the selected ID.
 */
import { type SessionMeta } from '../session/storage.js';
/**
 * Resolve a user-provided session identifier to a full session ID.
 * Supports exact match and unambiguous prefix match (minimum 8 chars).
 * Returns { ok, id } on success, or { ok, error, candidates } on failure.
 */
export declare function resolveSessionIdInput(input: string): {
    ok: true;
    id: string;
} | {
    ok: false;
    error: 'not-found' | 'ambiguous';
    candidates: SessionMeta[];
};
/**
 * Find the most recent session for a given working directory.
 * Returns null if none exists.
 */
export declare function findLatestSessionForDir(workDir: string): SessionMeta | null;
/**
 * Show an interactive session picker. Returns the selected session ID,
 * or null if the user cancels / no sessions exist.
 */
export declare function pickSession(opts?: {
    workDir?: string;
}): Promise<string | null>;
