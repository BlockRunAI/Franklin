/**
 * Context Manager for Franklin
 * Assembles system instructions, reads project config, injects environment info.
 */
/**
 * Build the full system instructions array for a session.
 * Result is memoized per workingDir for the process lifetime.
 */
export declare function assembleInstructions(workingDir: string, model?: string): string[];
/**
 * Model-family-specific execution guidance.
 * Weak models get strict guardrails. Strong models get quality standards.
 */
export declare function getModelGuidance(model: string): string;
/** Invalidate cache for a workingDir (call after /clear or session reset). */
export declare function invalidateInstructionCache(workingDir?: string): void;
