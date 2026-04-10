/**
 * Session search — find past conversations by keyword.
 *
 * Inspired by Hermes Agent's FTS5 search (`hermes_state.py`). For RunCode's
 * scale (last 20 sessions) we use a lightweight in-memory tokenized search
 * instead of SQLite FTS5 — zero install cost, same user experience.
 */
import fs from 'node:fs';
import { listSessions, getSessionFilePath } from './storage.js';
// ─── Tokenization ─────────────────────────────────────────────────────────
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}
function parseQuery(query) {
    const phrases = [];
    // Extract quoted phrases first
    const cleaned = query.replace(/"([^"]+)"/g, (_, phrase) => {
        phrases.push(phrase.toLowerCase());
        return ' ';
    });
    const terms = tokenize(cleaned);
    return { terms, phrases };
}
// ─── Snippet Extraction ───────────────────────────────────────────────────
function extractSnippet(content, query, maxLen = 200) {
    const lower = content.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) {
        // Fall back to first token match
        const firstToken = tokenize(query)[0];
        if (firstToken) {
            const tIdx = lower.indexOf(firstToken);
            if (tIdx !== -1)
                return centerSnippet(content, tIdx, firstToken.length, maxLen);
        }
        return content.slice(0, maxLen);
    }
    return centerSnippet(content, idx, q.length, maxLen);
}
function centerSnippet(content, matchStart, matchLen, maxLen) {
    const padding = Math.floor((maxLen - matchLen) / 2);
    const start = Math.max(0, matchStart - padding);
    const end = Math.min(content.length, matchStart + matchLen + padding);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < content.length ? '...' : '';
    return (prefix + content.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}
function extractMessageText(msg) {
    if (typeof msg.content === 'string')
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((part) => {
            if (typeof part === 'string')
                return part;
            if (!part || typeof part !== 'object')
                return '';
            const p = part;
            if (p.type === 'text' && typeof p.text === 'string')
                return p.text;
            if (p.type === 'tool_use' && typeof p.name === 'string')
                return `[tool:${p.name}]`;
            if (p.type === 'tool_result') {
                const c = p.content;
                if (typeof c === 'string')
                    return c;
                if (Array.isArray(c)) {
                    return c.map((cp) => {
                        if (typeof cp === 'string')
                            return cp;
                        if (cp && typeof cp === 'object' && 'text' in cp)
                            return String(cp.text);
                        return '';
                    }).join(' ');
                }
            }
            return '';
        })
            .join(' ');
    }
    return '';
}
// ─── Core Search ──────────────────────────────────────────────────────────
/**
 * Search sessions for a query string.
 * Returns results ranked by relevance (term frequency + recency).
 */
export function searchSessions(query, options = {}) {
    const { limit = 10, model, since } = options;
    const { terms, phrases } = parseQuery(query);
    if (terms.length === 0 && phrases.length === 0)
        return [];
    const sessions = listSessions();
    const results = [];
    for (const session of sessions) {
        if (model && !session.model.toLowerCase().includes(model.toLowerCase()))
            continue;
        if (since && session.updatedAt < since)
            continue;
        const match = scoreSession(session, terms, phrases, query);
        if (match)
            results.push(match);
    }
    // Sort by score desc, then recency desc
    results.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        return b.session.updatedAt - a.session.updatedAt;
    });
    return results.slice(0, limit);
}
function scoreSession(session, terms, phrases, originalQuery) {
    // Locate the session's JSONL file (search in sessions dir)
    const sessionFile = findSessionFile(session.id);
    if (!sessionFile)
        return null;
    let rawContent;
    try {
        rawContent = fs.readFileSync(sessionFile, 'utf-8');
    }
    catch {
        return null;
    }
    // Parse messages
    const messages = [];
    for (const line of rawContent.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const msg = JSON.parse(line);
            if (msg && typeof msg === 'object' && 'role' in msg) {
                messages.push(msg);
            }
        }
        catch { /* skip malformed */ }
    }
    if (messages.length === 0)
        return null;
    // Score each message
    let totalScore = 0;
    let hitCount = 0;
    let bestSnippet = '';
    let bestMatchedRole = 'user';
    let bestMessageScore = 0;
    for (const msg of messages) {
        const text = extractMessageText(msg);
        if (!text)
            continue;
        const lowerText = text.toLowerCase();
        // Score: sum of term frequencies + phrase bonuses
        let msgScore = 0;
        for (const term of terms) {
            const count = countOccurrences(lowerText, term);
            if (count > 0) {
                msgScore += count;
                hitCount += count;
            }
        }
        for (const phrase of phrases) {
            const count = countOccurrences(lowerText, phrase);
            if (count > 0) {
                // Phrase matches are worth 3x term matches
                msgScore += count * 3;
                hitCount += count;
            }
        }
        // Assistant matches slightly preferred (usually more substantive)
        if (msg.role === 'assistant')
            msgScore *= 1.1;
        if (msgScore > bestMessageScore) {
            bestMessageScore = msgScore;
            bestSnippet = extractSnippet(text, originalQuery);
            bestMatchedRole = msg.role === 'assistant' ? 'assistant' : 'user';
        }
        totalScore += msgScore;
    }
    if (totalScore === 0)
        return null;
    // Recency bonus: newer sessions get a small boost
    const ageDays = (Date.now() - session.updatedAt) / (1000 * 60 * 60 * 24);
    const recencyBonus = Math.max(0, 5 - ageDays * 0.1);
    const finalScore = totalScore + recencyBonus;
    return {
        session,
        score: finalScore,
        hitCount,
        snippet: bestSnippet,
        matchedRole: bestMatchedRole,
    };
}
function countOccurrences(text, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}
function findSessionFile(sessionId) {
    const p = getSessionFilePath(sessionId);
    return fs.existsSync(p) ? p : null;
}
// ─── Display ──────────────────────────────────────────────────────────────
export function formatSearchResults(matches, query) {
    if (matches.length === 0) {
        return `\nNo sessions found matching "${query}".\n`;
    }
    const lines = [];
    lines.push(`\n  Found ${matches.length} session${matches.length === 1 ? '' : 's'} matching "${query}":\n`);
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const date = new Date(m.session.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        const hitLabel = m.hitCount === 1 ? 'hit' : 'hits';
        lines.push(`  ${i + 1}. ${m.session.id}`);
        lines.push(`     ${date} | ${m.session.model} | ${m.hitCount} ${hitLabel} | score ${m.score.toFixed(1)}`);
        lines.push(`     [${m.matchedRole}] ${m.snippet}`);
        lines.push('');
    }
    lines.push(`  Resume: runcode  (then /resume <session-id>)\n`);
    return lines.join('\n');
}
