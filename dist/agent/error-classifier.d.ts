/**
 * Classify model/runtime errors so recovery and UX can be more consistent.
 *
 * Inspired by Claude Code's multi-layer error classification:
 * - Separate 'overloaded' category (529) from general server errors — shorter retry budget
 * - Auth errors (401) get special handling (token refresh, not retry)
 * - EPIPE/connection reset handled as network errors (retryable)
 */
export type AgentErrorCategory = 'rate_limit' | 'payment' | 'network' | 'timeout' | 'context_limit' | 'overloaded' | 'server' | 'auth' | 'schema' | 'unknown';
export interface AgentErrorInfo {
    category: AgentErrorCategory;
    label: 'RateLimit' | 'Payment' | 'Network' | 'Timeout' | 'Context' | 'Overloaded' | 'Server' | 'Auth' | 'Schema' | 'Unknown';
    isTransient: boolean;
    /** Max retries for this error type (overrides default). undefined = use default. */
    maxRetries?: number;
    /** User-facing suggestion for how to recover. Appended to error message in UI. */
    suggestion?: string;
}
export declare function classifyAgentError(message: string): AgentErrorInfo;
