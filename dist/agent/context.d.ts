/**
 * Context Manager for runcode
 * Assembles system instructions, reads project config, injects environment info.
 */
/**
 * Build the full system instructions array for a session.
 */
export declare function assembleInstructions(workingDir: string): string[];
