/**
 * Terminal UI for 0xcode
 * Raw terminal input/output with markdown rendering and diff display.
 * No heavy dependencies — just chalk and readline.
 */
import type { StreamEvent } from '../agent/types.js';
export declare class TerminalUI {
    private spinner;
    private activeCapabilities;
    private totalInputTokens;
    private totalOutputTokens;
    private mdRenderer;
    /**
     * Prompt the user for input. Returns null on EOF/exit.
     */
    promptUser(promptText?: string): Promise<string | null>;
    /**
     * Handle a stream event from the agent loop.
     */
    handleEvent(event: StreamEvent): void;
    printWelcome(model: string, workDir: string): void;
    printUsageSummary(): void;
    printGoodbye(): void;
}
