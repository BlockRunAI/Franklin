/**
 * Workflow tracker — SQLite-based dedup, stats, and history.
 * Shared by all workflows. Each workflow gets its own table namespace.
 */
import type { WorkflowStats } from './types.js';
interface TrackerEntry {
    workflow: string;
    action: string;
    key: string;
    metadata: Record<string, unknown>;
    costUsd: number;
    createdAt: string;
}
/** Append a tracked action */
export declare function trackAction(workflow: string, action: string, key: string, metadata?: Record<string, unknown>, costUsd?: number): void;
/** Check if a key was already processed (dedup) */
export declare function isDuplicate(workflow: string, key: string): boolean;
/** Get workflow stats */
export declare function getStats(workflow: string): WorkflowStats;
/** Get recent entries for a workflow */
export declare function getRecent(workflow: string, limit?: number): TrackerEntry[];
/** Get entries by action type (e.g. "lead" for lead tracking) */
export declare function getByAction(workflow: string, action: string): TrackerEntry[];
export {};
