/**
 * RunCode ink-based terminal UI.
 * Real-time streaming, thinking animation, tool progress, slash commands.
 */
import type { StreamEvent } from '../agent/types.js';
export interface InkUIHandle {
    handleEvent: (event: StreamEvent) => void;
    updateBalance: (balance: string) => void;
    onTurnDone: (cb: () => void) => void;
    waitForInput: () => Promise<string | null>;
    onAbort: (cb: () => void) => void;
    cleanup: () => void;
    requestPermission: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;
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
