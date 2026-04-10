/**
 * Workflow Runner — orchestrates execution of any Workflow.
 *
 * Plugin-agnostic: takes a Workflow + config, runs steps, handles
 * model dispatch, dedup, tracking, dry-run.
 */
import { ModelClient } from '../agent/llm.js';
import type { Workflow, WorkflowConfig, WorkflowResult } from '../plugin-sdk/workflow.js';
import type { WorkflowStats, TrackedAction } from '../plugin-sdk/tracker.js';
export declare function loadWorkflowConfig(workflowId: string): WorkflowConfig | null;
export declare function saveWorkflowConfig(workflowId: string, config: WorkflowConfig): void;
interface TrackerEntry extends TrackedAction {
}
export declare function getStats(workflow: string): WorkflowStats;
export declare function getByAction(workflow: string, action: string): TrackerEntry[];
export declare function runWorkflow(workflow: Workflow, config: WorkflowConfig, client: ModelClient, options?: {
    dryRun?: boolean;
}): Promise<WorkflowResult>;
export declare function formatWorkflowResult(workflow: Workflow, result: WorkflowResult): string;
export declare function formatWorkflowStats(workflow: Workflow, stats: WorkflowStats): string;
export {};
