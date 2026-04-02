/**
 * Usage tracking for 0xcode
 * Records all requests with cost, tokens, and latency for stats display
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const STATS_FILE = path.join(os.homedir(), '.blockrun', '0xcode-stats.json');
const EMPTY_STATS = {
    version: 1,
    totalRequests: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalFallbacks: 0,
    byModel: {},
    history: [],
};
export function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
            // Migration: add missing fields
            return {
                ...EMPTY_STATS,
                ...data,
                version: 1,
            };
        }
    }
    catch {
        /* ignore parse errors, return empty */
    }
    return { ...EMPTY_STATS };
}
export function saveStats(stats) {
    try {
        fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
        // Keep only last 1000 history records
        stats.history = stats.history.slice(-1000);
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    }
    catch {
        /* ignore write errors */
    }
}
export function clearStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            fs.unlinkSync(STATS_FILE);
        }
    }
    catch {
        /* ignore */
    }
}
/**
 * Record a completed request for stats tracking
 */
export function recordUsage(model, inputTokens, outputTokens, costUsd, latencyMs, fallback = false) {
    const stats = loadStats();
    const now = Date.now();
    // Update totals
    stats.totalRequests++;
    stats.totalCostUsd += costUsd;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    if (fallback)
        stats.totalFallbacks++;
    // Update timestamps
    if (!stats.firstRequest)
        stats.firstRequest = now;
    stats.lastRequest = now;
    // Update per-model stats
    if (!stats.byModel[model]) {
        stats.byModel[model] = {
            requests: 0,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            fallbackCount: 0,
            avgLatencyMs: 0,
            totalLatencyMs: 0,
        };
    }
    const modelStats = stats.byModel[model];
    modelStats.requests++;
    modelStats.costUsd += costUsd;
    modelStats.inputTokens += inputTokens;
    modelStats.outputTokens += outputTokens;
    modelStats.totalLatencyMs += latencyMs;
    modelStats.avgLatencyMs = modelStats.totalLatencyMs / modelStats.requests;
    if (fallback)
        modelStats.fallbackCount++;
    // Add to history
    stats.history.push({
        timestamp: now,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs,
        fallback,
    });
    saveStats(stats);
}
/**
 * Get stats summary for display
 */
export function getStatsSummary() {
    const stats = loadStats();
    // Calculate what it would cost with Claude Opus
    const opusCost = (stats.totalInputTokens / 1_000_000) * 5 +
        (stats.totalOutputTokens / 1_000_000) * 25;
    const saved = opusCost - stats.totalCostUsd;
    const savedPct = opusCost > 0 ? (saved / opusCost) * 100 : 0;
    const avgCostPerRequest = stats.totalRequests > 0 ? stats.totalCostUsd / stats.totalRequests : 0;
    // Calculate period
    let period = 'No data';
    if (stats.firstRequest && stats.lastRequest) {
        const days = Math.ceil((stats.lastRequest - stats.firstRequest) / (1000 * 60 * 60 * 24));
        if (days === 0)
            period = 'Today';
        else if (days === 1)
            period = '1 day';
        else
            period = `${days} days`;
    }
    return { stats, opusCost, saved, savedPct, avgCostPerRequest, period };
}
