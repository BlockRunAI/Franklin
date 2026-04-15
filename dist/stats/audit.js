/**
 * Audit log — append-only forensic record of every LLM call.
 *
 * Lives at ~/.blockrun/franklin-audit.jsonl. One line per call, JSONL.
 * Unlike franklin-stats.json (aggregates), this file lets you answer
 * "what was I actually doing when $1.50 disappeared on Apr 12?".
 *
 * Fields kept intentionally small (truncated prompt, no tool args) so the
 * file stays readable and doesn't leak large tool outputs to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
const AUDIT_FILE = path.join(BLOCKRUN_DIR, 'franklin-audit.jsonl');
const PROMPT_PREVIEW_CHARS = 240;
export function appendAudit(entry) {
    try {
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        const safe = {
            ...entry,
            prompt: entry.prompt ? truncate(entry.prompt, PROMPT_PREVIEW_CHARS) : undefined,
        };
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(safe) + '\n');
    }
    catch {
        /* best-effort — never break the agent loop on audit-write failure */
    }
}
export function getAuditFilePath() {
    return AUDIT_FILE;
}
export function readAudit() {
    try {
        if (!fs.existsSync(AUDIT_FILE))
            return [];
        const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n');
        const out = [];
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch { /* skip malformed line */ }
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Pull the last user message from a Dialogue history, flatten, and strip newlines. */
export function extractLastUserPrompt(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role !== 'user')
            continue;
        const text = flattenContent(msg.content);
        if (!text)
            continue;
        return text.replace(/\s+/g, ' ').trim();
    }
    return undefined;
}
function flattenContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') {
            parts.push(block);
        }
        else if (block && typeof block === 'object') {
            const b = block;
            // Skip tool_result blocks — they're tool output, not user intent
            if (b.type === 'text' && typeof b.text === 'string')
                parts.push(b.text);
        }
    }
    return parts.join(' ');
}
function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
