/**
 * Workflow config management.
 * Each workflow stores its config at ~/.blockrun/<name>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import type { WorkflowConfig, ModelTierConfig } from './types.js';
import { DEFAULT_MODEL_TIERS } from './types.js';

/** Get config file path for a workflow */
export function getConfigPath(workflowName: string): string {
  return path.join(BLOCKRUN_DIR, `${workflowName}.json`);
}

/** Load workflow config. Returns null if not configured yet. */
export function loadWorkflowConfig<T extends WorkflowConfig>(workflowName: string): T | null {
  const configPath = getConfigPath(workflowName);
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Ensure model tiers have defaults
      raw.models = { ...DEFAULT_MODEL_TIERS, ...raw.models };
      raw.name = workflowName;
      return raw as T;
    }
  } catch {
    // Corrupt config — treat as not configured
  }
  return null;
}

/** Save workflow config */
export function saveWorkflowConfig(workflowName: string, config: WorkflowConfig): void {
  const configPath = getConfigPath(workflowName);
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/** Update specific fields in workflow config */
export function updateWorkflowConfig(workflowName: string, updates: Partial<WorkflowConfig>): void {
  const existing = loadWorkflowConfig(workflowName) || { name: workflowName, models: DEFAULT_MODEL_TIERS };
  const merged = { ...existing, ...updates };
  saveWorkflowConfig(workflowName, merged);
}

/** Get model tiers with fallback to defaults */
export function getModelTiers(config: WorkflowConfig | null): ModelTierConfig {
  return config?.models ?? DEFAULT_MODEL_TIERS;
}
