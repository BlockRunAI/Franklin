/**
 * Bash Risk Classifier — lightweight Guardian for Franklin.
 *
 * Classifies bash commands into three risk levels:
 *   safe      — read-only or standard dev commands → auto-approve
 *   normal    — typical mutations (file writes, installs) → default ask behavior
 *   dangerous — destructive/irreversible operations → always ask, with warning
 *
 * Inspired by OpenAI Codex's Guardian system, but deterministic pattern matching
 * instead of an LLM call. Fast, predictable, zero-cost.
 */
export type BashRiskLevel = 'safe' | 'normal' | 'dangerous';
export interface BashRiskResult {
    level: BashRiskLevel;
    reason?: string;
}
export declare function classifyBashRisk(command: string): BashRiskResult;
