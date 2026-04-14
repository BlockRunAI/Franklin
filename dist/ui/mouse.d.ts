/**
 * Mouse event support for Ink terminal UI.
 * Enables SGR extended mouse tracking (DECSET 1000+1006) and parses events from stdin.
 * Lightweight — only handles clicks, not drag/hover/selection.
 */
import { EventEmitter } from 'node:events';
export interface MouseEvent {
    button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
    action: 'press' | 'release';
    col: number;
    row: number;
}
declare class MouseManager extends EventEmitter {
    private enabled;
    private stdinListener;
    /**
     * Enable mouse tracking. Call once on app startup.
     * Returns cleanup function to call on unmount.
     */
    enable(): () => void;
    /**
     * Disable mouse tracking and clean up.
     */
    disable(): void;
    isEnabled(): boolean;
}
/** Singleton mouse manager. */
export declare const mouse: MouseManager;
export {};
