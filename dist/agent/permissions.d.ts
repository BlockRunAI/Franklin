/**
 * Permission system for 0xcode.
 * Controls which tools can execute automatically vs. require user approval.
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export interface PermissionRules {
    allow: string[];
    deny: string[];
    ask: string[];
}
export type PermissionMode = 'default' | 'trust' | 'deny-all';
export interface PermissionDecision {
    behavior: PermissionBehavior;
    reason?: string;
}
export declare class PermissionManager {
    private rules;
    private mode;
    private sessionAllowed;
    constructor(mode?: PermissionMode);
    /**
     * Check if a tool can be used. Returns the decision.
     */
    check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision>;
    /**
     * Prompt the user interactively for permission.
     * Returns true if allowed, false if denied.
     */
    promptUser(toolName: string, input: Record<string, unknown>): Promise<boolean>;
    private loadRules;
    private matchesRule;
    private getPrimaryInputValue;
    private globMatch;
    private sessionKey;
    private describeAction;
}
