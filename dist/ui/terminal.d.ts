/**
 * Terminal UI for runcode
 * Raw terminal input/output with markdown rendering and diff display.
 * No heavy dependencies — just chalk and readline.
 */
import type { StreamEvent } from '../agent/types.js';
export declare class TerminalUI {
    private spinner;
    private activeCapabilities;
    private totalInputTokens;
    private totalOutputTokens;
    private sessionModel;
    private mdRenderer;
    private lineQueue;
    private lineWaiters;
    private stdinEOF;
    constructor();
    /**
     * Prompt the user for input. Returns null on EOF/exit.
     * Uses a line-queue approach so piped input works across multiple calls.
     */
    promptUser(promptText?: string): Promise<string | null>;
    private nextLine;
    /** No-op kept for API compatibility — readline closes when stdin EOF. */
    closeInput(): void;
    /**
     * Handle a stream event from the agent loop.
     */
    handleEvent(event: StreamEvent): void;
    /** Check if input is a slash command. Returns true if handled locally (don't pass to agent). */
    handleSlashCommand(input: string): boolean;
    printWelcome(model: string, workDir: string): void;
    printUsageSummary(): void;
    printGoodbye(): void;
}
