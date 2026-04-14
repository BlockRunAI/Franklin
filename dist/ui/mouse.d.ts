/**
 * Mouse event support for Ink terminal UI.
 * - SGR extended mouse tracking (DECSET 1000+1002+1006)
 * - Click detection (left click → 'click' event)
 * - Drag detection with text selection (press → motion → release)
 * - Stdout interception for screen text buffer
 * - Clipboard copy on drag-select
 */
import { EventEmitter } from 'node:events';
export interface MouseEvent {
    button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
    action: 'press' | 'release' | 'drag';
    col: number;
    row: number;
}
export interface Selection {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    text: string;
}
declare class MouseManager extends EventEmitter {
    private enabled;
    private stdinListener;
    private screen;
    private dragState;
    private pressPos;
    private dragPos;
    /**
     * Enable mouse tracking + screen buffer. Returns cleanup function.
     */
    enable(): () => void;
    private handleLeftButton;
    /**
     * Disable mouse tracking and clean up.
     */
    disable(): void;
    isEnabled(): boolean;
}
/** Singleton mouse manager. */
export declare const mouse: MouseManager;
/**
 * Force-disable any leftover mouse tracking from a previous session.
 * Safe to call unconditionally — if tracking is off, it's a no-op at the terminal level.
 */
export declare function forceDisableMouseTracking(): void;
export {};
