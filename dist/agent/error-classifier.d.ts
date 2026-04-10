/**
 * Classify model/runtime errors so recovery and UX can be more consistent.
 */
export type AgentErrorCategory = 'rate_limit' | 'payment' | 'network' | 'timeout' | 'context_limit' | 'server' | 'unknown';
export interface AgentErrorInfo {
    category: AgentErrorCategory;
    label: 'RateLimit' | 'Payment' | 'Network' | 'Timeout' | 'Context' | 'Server' | 'Unknown';
    isTransient: boolean;
}
export declare function classifyAgentError(message: string): AgentErrorInfo;
