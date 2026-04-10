/**
 * Session search — find past conversations by keyword.
 *
 * Inspired by Hermes Agent's FTS5 search (`hermes_state.py`). For RunCode's
 * scale (last 20 sessions) we use a lightweight in-memory tokenized search
 * instead of SQLite FTS5 — zero install cost, same user experience.
 */
import type { SessionMeta } from './storage.js';
export interface SearchMatch {
    session: SessionMeta;
    /** Relevance score (higher = better) */
    score: number;
    /** Number of times all query terms appear in this session */
    hitCount: number;
    /** Best snippet (~200 chars) around the first match */
    snippet: string;
    /** Which message role contained the match */
    matchedRole: 'user' | 'assistant';
}
export interface SearchOptions {
    /** Maximum number of results */
    limit?: number;
    /** Filter by model substring (e.g. "sonnet") */
    model?: string;
    /** Only sessions newer than this timestamp (ms) */
    since?: number;
}
/**
 * Search sessions for a query string.
 * Returns results ranked by relevance (term frequency + recency).
 */
export declare function searchSessions(query: string, options?: SearchOptions): SearchMatch[];
export declare function formatSearchResults(matches: SearchMatch[], query: string): string;
