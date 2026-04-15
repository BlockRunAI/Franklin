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
export interface AuditEntry {
    ts: number;
    sessionId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs?: number;
    fallback?: boolean;
    source: 'agent' | 'proxy' | 'subagent' | 'moa' | 'plugin';
    workDir?: string;
    prompt?: string;
    toolCalls?: string[];
    routingTier?: string;
}
export declare function appendAudit(entry: AuditEntry): void;
export declare function getAuditFilePath(): string;
export declare function readAudit(): AuditEntry[];
/** Pull the last user message from a Dialogue history, flatten, and strip newlines. */
export declare function extractLastUserPrompt(history: Array<{
    role: string;
    content: unknown;
}>): string | undefined;
