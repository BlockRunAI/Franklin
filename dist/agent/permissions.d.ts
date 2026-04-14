/**
 * Permission system for Franklin.
 * Controls which tools can execute automatically vs. require user approval.
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export interface PermissionRules {
    allow: string[];
    deny: string[];
    ask: string[];
}
export type PermissionMode = 'default' | 'trust' | 'deny-all' | 'plan';
export interface PermissionDecision {
    behavior: PermissionBehavior;
    reason?: string;
}
export declare class PermissionManager {
    private rules;
    private mode;
    private sessionAllowed;
    private promptFn?;
    constructor(mode?: PermissionMode, promptFn?: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>);
    /**
     * Check if a tool can be used. Returns the decision.
     */
    check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision>;
    /**
     * Prompt the user interactively for permission.
     * Uses injected promptFn (Ink UI) when available, falls back to readline.
     * pendingCount: how many more operations of this type are waiting (including this one).
     * Returns true if allowed, false if denied.
     */
    promptUser(toolName: string, input: Record<string, unknown>, pendingCount?: number): Promise<boolean>;
    private loadRules;
    private matchesRule;
    private getPrimaryInputValue;
    private globMatch;
    private sessionKey;
    private describeAction;
}
