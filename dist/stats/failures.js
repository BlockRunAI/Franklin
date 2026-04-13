/**
 * Structured failure logging for self-evolution analysis.
 * Append-only JSONL at ~/.blockrun/failures.jsonl (capped 500 records).
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
const FAILURES_FILE = path.join(BLOCKRUN_DIR, 'failures.jsonl');
const MAX_RECORDS = 500;
export function recordFailure(record) {
    try {
        fs.mkdirSync(path.dirname(FAILURES_FILE), { recursive: true });
        fs.appendFileSync(FAILURES_FILE, JSON.stringify(record) + '\n');
        // Trim to MAX_RECORDS (only check periodically to avoid constant reads)
        if (Math.random() < 0.1) {
            trimFailures();
        }
    }
    catch {
        // Fire-and-forget — never block the critical path
    }
}
function trimFailures() {
    try {
        if (!fs.existsSync(FAILURES_FILE))
            return;
        const lines = fs.readFileSync(FAILURES_FILE, 'utf-8').trim().split('\n');
        if (lines.length > MAX_RECORDS) {
            const trimmed = lines.slice(-MAX_RECORDS).join('\n') + '\n';
            fs.writeFileSync(FAILURES_FILE, trimmed);
        }
    }
    catch {
        // ignore
    }
}
export function loadFailures(limit = 100) {
    try {
        if (!fs.existsSync(FAILURES_FILE))
            return [];
        const lines = fs.readFileSync(FAILURES_FILE, 'utf-8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => JSON.parse(l));
    }
    catch {
        return [];
    }
}
export function getFailureStats() {
    const records = loadFailures(500);
    const byTool = new Map();
    const byType = new Map();
    for (const r of records) {
        if (r.toolName)
            byTool.set(r.toolName, (byTool.get(r.toolName) ?? 0) + 1);
        byType.set(r.failureType, (byType.get(r.failureType) ?? 0) + 1);
    }
    return {
        byTool,
        byType,
        total: records.length,
        recentFailures: records.slice(-10),
    };
}
