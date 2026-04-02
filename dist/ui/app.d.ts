/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */
import type { StreamEvent } from '../agent/types.js';
export interface InkUIHandle {
    handleEvent: (event: StreamEvent) => void;
    waitForInput: () => Promise<string | null>;
    cleanup: () => void;
}
export declare function launchInkUI(opts: {
    model: string;
    workDir: string;
    version: string;
    walletAddress?: string;
    walletBalance?: string;
    chain?: string;
    showPicker?: boolean;
    onModelChange?: (model: string) => void;
}): InkUIHandle;
