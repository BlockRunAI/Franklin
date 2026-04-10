/**
 * Session insights engine.
 *
 * Rich usage analytics from the stats tracker history.
 * Inspired by hermes-agent's `agent/insights.py` and Claude Code's /insights.
 *
 * Provides:
 *   - Per-model cost and request breakdown
 *   - Daily activity trend (sparkline)
 *   - Top sessions by cost
 *   - Tool usage patterns
 *   - Cost projections and efficiency metrics
 */
export interface InsightsReport {
    /** Window size in days */
    days: number;
    /** Records within the window */
    windowRecords: number;
    /** Total cost in window */
    totalCostUsd: number;
    /** Total input tokens in window */
    totalInputTokens: number;
    /** Total output tokens in window */
    totalOutputTokens: number;
    /** Savings vs always using Claude Opus */
    savedVsOpusUsd: number;
    /** Per-model breakdown, sorted by cost desc */
    byModel: Array<{
        model: string;
        requests: number;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        avgLatencyMs: number;
        percentOfTotal: number;
    }>;
    /** Daily activity (last N days), oldest first */
    daily: Array<{
        date: string;
        requests: number;
        costUsd: number;
    }>;
    /** Projections */
    projections: {
        avgCostPerDay: number;
        projectedMonthlyUsd: number;
        projectedYearlyUsd: number;
    };
    /** Average request cost */
    avgRequestCostUsd: number;
    /** Efficiency: cost per 1K tokens */
    costPer1KTokens: number;
}
export declare function generateInsights(days?: number): InsightsReport;
export declare function formatInsights(report: InsightsReport, days: number): string;
