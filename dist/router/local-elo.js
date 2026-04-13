/**
 * Local Elo learning — adapts routing to the user's own usage patterns.
 * Tracks model outcomes per category and adjusts Elo ratings locally.
 *
 * Storage: ~/.blockrun/router-history.jsonl (append-only, capped 2000 records)
 * Never uploaded — purely local personalization.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
const HISTORY_FILE = path.join(BLOCKRUN_DIR, 'router-history.jsonl');
const MAX_RECORDS = 2000;
const K_FACTOR = 32; // Elo K-factor — how much each outcome shifts the rating
/**
 * Record a model outcome for local learning.
 */
export function recordOutcome(category, model, outcome, toolCalls) {
    try {
        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        const record = { ts: Date.now(), category, model, outcome, toolCalls };
        fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
        // Trim periodically (10% chance)
        if (Math.random() < 0.1) {
            trimHistory();
        }
    }
    catch {
        // Fire-and-forget
    }
}
function trimHistory() {
    try {
        if (!fs.existsSync(HISTORY_FILE))
            return;
        const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n');
        if (lines.length > MAX_RECORDS) {
            fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_RECORDS).join('\n') + '\n');
        }
    }
    catch { /* ignore */ }
}
/**
 * Compute local Elo adjustments from history.
 * Returns a map of (category → model → elo_delta).
 *
 * Outcomes map to win/loss:
 *   continued → win  (+K * 0.6)
 *   switched  → loss (-K * 1.0)
 *   retried   → loss (-K * 0.8)
 *   error     → loss (-K * 0.5)
 *   max_turns → loss (-K * 0.3)
 */
export function computeLocalElo() {
    const adjustments = new Map();
    try {
        if (!fs.existsSync(HISTORY_FILE))
            return adjustments;
        const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const record = JSON.parse(line);
                if (!adjustments.has(record.category)) {
                    adjustments.set(record.category, new Map());
                }
                const catMap = adjustments.get(record.category);
                const current = catMap.get(record.model) ?? 0;
                let delta;
                switch (record.outcome) {
                    case 'continued':
                        delta = K_FACTOR * 0.6;
                        break;
                    case 'switched':
                        delta = -K_FACTOR * 1.0;
                        break;
                    case 'retried':
                        delta = -K_FACTOR * 0.8;
                        break;
                    case 'error':
                        delta = -K_FACTOR * 0.5;
                        break;
                    case 'max_turns':
                        delta = -K_FACTOR * 0.3;
                        break;
                    default: delta = 0;
                }
                catMap.set(record.model, current + delta);
            }
            catch { /* skip malformed lines */ }
        }
    }
    catch { /* ignore read errors */ }
    return adjustments;
}
/**
 * Get the effective Elo for a model in a category,
 * blending global (server-trained) and local (user-specific) scores.
 *
 * effective = 0.7 * global + 0.3 * (1200 + local_delta)
 */
export function blendElo(globalElo, localDelta) {
    const localElo = 1200 + localDelta;
    return 0.7 * globalElo + 0.3 * localElo;
}
