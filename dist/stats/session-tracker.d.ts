/**
 * Session-scoped per-model usage tracking.
 * In-memory only — resets on new session. Used by /cost and UI footer.
 */
export interface SessionModelUsage {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastTier?: string;
}
export declare function recordSessionUsage(model: string, inputTokens: number, outputTokens: number, costUsd: number, tier?: string): void;
export declare function getSessionModelBreakdown(): Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastTier?: string;
}>;
export declare function resetSession(): void;
