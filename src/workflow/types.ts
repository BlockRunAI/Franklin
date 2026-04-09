/**
 * Workflow Engine types.
 * Shared by all workflows (social, trading, content, etc.)
 */

// ─── Model Tiers ──────────────────────────────────────────────────────────

/** Model selection tier — workflows pick tier per step, engine resolves to actual model */
export type ModelTier = 'free' | 'cheap' | 'premium' | 'none';

/** User-configurable model mapping per tier */
export interface ModelTierConfig {
  free: string;      // e.g. "nvidia/nemotron-ultra-253b"
  cheap: string;     // e.g. "zai/glm-5.1"
  premium: string;   // e.g. "anthropic/claude-sonnet-4.6"
}

export const DEFAULT_MODEL_TIERS: ModelTierConfig = {
  free: 'nvidia/nemotron-ultra-253b',
  cheap: 'zai/glm-5.1',
  premium: 'anthropic/claude-sonnet-4.6',
};

// ─── Workflow Steps ───────────────────────────────────────────────────────

/** Context passed to each step */
export interface StepContext {
  /** Accumulated data from previous steps */
  data: Record<string, unknown>;
  /** Call an LLM at a specific tier */
  callModel: (tier: ModelTier, prompt: string, system?: string) => Promise<string>;
  /** Generate an image */
  generateImage?: (prompt: string) => Promise<string>;
  /** Search the web (Exa or WebSearch) */
  search: (query: string, options?: { sources?: string[]; maxResults?: number }) => Promise<SearchResult[]>;
  /** Log progress visible to user */
  log: (message: string) => void;
  /** Track an action in the database */
  track: (action: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Check if item was already processed (dedup) */
  isDuplicate: (key: string) => Promise<boolean>;
  /** Dry-run mode — skip side effects */
  dryRun: boolean;
  /** Workflow config */
  config: WorkflowConfig;
}

/** Result of a single step */
export interface StepResult {
  /** Data to merge into context for next steps */
  data?: Record<string, unknown>;
  /** Human-readable summary of what this step did */
  summary?: string;
  /** If true, abort the workflow (e.g. nothing found) */
  abort?: boolean;
  /** Cost of this step in USD */
  cost?: number;
}

/** Definition of a workflow step */
export interface WorkflowStep {
  /** Step name (for display and tracking) */
  name: string;
  /** Which model tier to use (engine resolves to actual model) */
  modelTier: ModelTier | 'dynamic';
  /** Execute this step */
  execute: (ctx: StepContext) => Promise<StepResult>;
  /** Skip this step in dry-run mode */
  skipInDryRun?: boolean;
}

// ─── Search ───────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;        // "reddit", "x", "web", "hackernews"
  author?: string;
  timestamp?: string;
  score?: number;         // upvotes, likes, etc.
  commentCount?: number;
}

// ─── Workflow Config ──────────────────────────────────────────────────────

export interface WorkflowConfig {
  /** Workflow name: "social", "trading", "content" */
  name: string;
  /** Model tier mapping */
  models: ModelTierConfig;
  /** Schedule config (optional) */
  schedule?: {
    cron?: string;
    dailyTime?: string;     // "10:00"
    budgetCapUsd?: number;  // max spend per run
  };
  /** Workflow-specific config (passed through to steps) */
  [key: string]: unknown;
}

// ─── Workflow Result ──────────────────────────────────────────────────────

export interface WorkflowResult {
  /** Step-by-step summaries */
  steps: Array<{ name: string; summary: string; cost: number }>;
  /** Total cost in USD */
  totalCost: number;
  /** Total items processed */
  itemsProcessed: number;
  /** Duration in ms */
  durationMs: number;
  /** Whether this was a dry run */
  dryRun: boolean;
}

// ─── Tracker ──────────────────────────────────────────────────────────────

export interface TrackedAction {
  id?: number;
  workflow: string;
  action: string;
  key: string;           // dedup key (e.g. post URL)
  metadata: string;      // JSON
  createdAt: string;     // ISO timestamp
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

// ─── Onboarding ───────────────────────────────────────────────────────────

export interface OnboardingQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'select' | 'multi-select';
  options?: string[];
  default?: string;
  /** Auto-generate this field from previous answers using LLM */
  autoGenerate?: (answers: Record<string, string>) => Promise<string[]>;
}
