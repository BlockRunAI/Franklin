/**
 * Structured failure logging for self-evolution analysis.
 * Append-only JSONL at ~/.blockrun/failures.jsonl (capped 500 records).
 */
export interface FailureRecord {
    timestamp: number;
    model: string;
    failureType: 'tool_error' | 'model_error' | 'permission_denied' | 'agent_loop';
    toolName?: string;
    errorMessage: string;
    recoveryAction?: string;
}
export declare function recordFailure(record: FailureRecord): void;
export declare function loadFailures(limit?: number): FailureRecord[];
export declare function getFailureStats(): {
    byTool: Map<string, number>;
    byType: Map<string, number>;
    total: number;
    recentFailures: FailureRecord[];
};
