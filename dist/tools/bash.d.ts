/**
 * Bash capability — execute shell commands with timeout and output capture.
 */
import type { CapabilityHandler, CapabilityResult } from '../agent/types.js';
interface BackgroundTask {
    id: string;
    command: string;
    description: string;
    startedAt: number;
    status: 'running' | 'completed' | 'failed';
    result?: CapabilityResult;
}
/** Get a background task's result (called by the agent to check status). */
export declare function getBackgroundTask(id: string): BackgroundTask | undefined;
/** List all background tasks. */
export declare function listBackgroundTasks(): BackgroundTask[];
export declare const bashCapability: CapabilityHandler;
export {};
