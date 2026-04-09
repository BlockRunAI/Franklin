/**
 * Workflow config management.
 * Each workflow stores its config at ~/.blockrun/<name>.json
 */
import type { WorkflowConfig, ModelTierConfig } from './types.js';
/** Get config file path for a workflow */
export declare function getConfigPath(workflowName: string): string;
/** Load workflow config. Returns null if not configured yet. */
export declare function loadWorkflowConfig<T extends WorkflowConfig>(workflowName: string): T | null;
/** Save workflow config */
export declare function saveWorkflowConfig(workflowName: string, config: WorkflowConfig): void;
/** Update specific fields in workflow config */
export declare function updateWorkflowConfig(workflowName: string, updates: Partial<WorkflowConfig>): void;
/** Get model tiers with fallback to defaults */
export declare function getModelTiers(config: WorkflowConfig | null): ModelTierConfig;
