/**
 * Tracker contract — workflows record actions for dedup, stats, and history.
 * Core provides a default implementation; plugins use it via WorkflowStepContext.
 */

export interface TrackedAction {
  workflow: string;
  action: string;
  key: string;
  metadata: Record<string, unknown>;
  costUsd: number;
  createdAt: string;
}

export interface WorkflowStats {
  totalRuns: number;
  totalActions: number;
  totalCostUsd: number;
  todayActions: number;
  todayCostUsd: number;
  lastRun?: string;
  byAction: Record<string, number>;
}

export interface WorkflowTracker {
  trackAction(action: string, key: string, metadata: Record<string, unknown>, costUsd?: number): void;
  isDuplicate(key: string): boolean;
  getStats(): WorkflowStats;
  getByAction(action: string): TrackedAction[];
}
