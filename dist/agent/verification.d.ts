/**
 * Verification Agent — adversarial testing gate.
 *
 * After the main agent completes substantial work (writes/edits files, runs commands),
 * this agent runs independently to try to BREAK what was built. It can only read and
 * execute — never modify files. Returns PASS/FAIL/PARTIAL verdict.
 *
 * If FAIL: injects feedback into conversation so the main agent can fix issues.
 * If PASS: work is considered verified.
 *
 * Inspired by Claude Code's verification agent architecture.
 */
import type { CapabilityHandler, Dialogue } from './types.js';
import { ModelClient } from './llm.js';
export interface VerificationResult {
    verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIPPED';
    summary: string;
    issues: string[];
}
/**
 * Should we run verification for this turn?
 * Only for substantial work: 3+ tool calls AND at least one write/edit/bash.
 */
export declare function shouldVerify(turnToolCalls: number, turnToolCounts: Map<string, number>, userInput: string): boolean;
/**
 * Filter capability handlers to only allow read-only tools.
 * Bash is allowed (for running tests/builds) but Edit/Write are blocked.
 */
export declare function getVerificationTools(handlers: Map<string, CapabilityHandler>): Map<string, CapabilityHandler>;
/**
 * Run the verification agent on the current conversation state.
 * Uses a cheap model to minimize cost. Returns verdict + issues.
 */
export declare function runVerification(history: Dialogue[], handlers: Map<string, CapabilityHandler>, client: ModelClient, config: {
    model: string;
    workDir: string;
    abortSignal: AbortSignal;
    onEvent?: (event: {
        kind: string;
        text?: string;
    }) => void;
}): Promise<VerificationResult>;
