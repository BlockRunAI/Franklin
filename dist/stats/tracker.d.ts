/**
 * Usage tracking for brcc
 * Records all requests with cost, tokens, and latency for stats display
 */
export interface UsageRecord {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    fallback?: boolean;
}
export interface ModelStats {
    requests: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    fallbackCount: number;
    avgLatencyMs: number;
    totalLatencyMs: number;
}
export interface Stats {
    version: number;
    totalRequests: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalFallbacks: number;
    byModel: Record<string, ModelStats>;
    history: UsageRecord[];
    firstRequest?: number;
    lastRequest?: number;
}
export declare function loadStats(): Stats;
export declare function saveStats(stats: Stats): void;
export declare function clearStats(): void;
/**
 * Record a completed request for stats tracking
 */
export declare function recordUsage(model: string, inputTokens: number, outputTokens: number, costUsd: number, latencyMs: number, fallback?: boolean): void;
/**
 * Get stats summary for display
 */
export declare function getStatsSummary(): {
    stats: Stats;
    opusCost: number;
    saved: number;
    savedPct: number;
    avgCostPerRequest: number;
    period: string;
};
