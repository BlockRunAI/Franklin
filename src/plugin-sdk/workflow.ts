/**
 * Workflow contract — public surface for plugins implementing workflows.
 *
 * A workflow is a multi-step AI process: search → filter → generate → execute → track.
 * Plugins implement Workflow; core orchestrates execution and provides infrastructure.
 */

import type { SearchResult } from './search.js';
import type { ChannelMessage } from './channel.js';

// ─── Model Tiers ──────────────────────────────────────────────────────────

/** Model selection tier — workflows pick tier per step, core resolves to actual model */
export type ModelTier = 'free' | 'cheap' | 'premium' | 'none';

/** Maps tier names to actual model identifiers */
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

/** Context provided to each workflow step by core */
export interface WorkflowStepContext {
  /** Accumulated data from previous steps (mutable across steps) */
  data: Record<string, unknown>;
  /** Call an LLM at the specified tier */
  callModel: (tier: ModelTier, prompt: string, system?: string) => Promise<string>;
  /** Generate an image (DALL-E / Flux) */
  generateImage?: (prompt: string) => Promise<string>;
  /** Search the web (Exa neural / WebSearch fallback) */
  search: (query: string, options?: { sources?: string[]; maxResults?: number }) => Promise<SearchResult[]>;
  /** Send a message via a channel (e.g. reddit, x, telegram) */
  sendMessage?: (channelId: string, message: ChannelMessage) => Promise<void>;
  /** Log progress (visible to user) */
  log: (message: string) => void;
  /** Track an action in the workflow's database */
  track: (action: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Check if a key was already processed (dedup) */
  isDuplicate: (key: string) => Promise<boolean>;
  /** Dry-run mode — skip side effects */
  dryRun: boolean;
  /** Workflow config (typed by the workflow) */
  config: WorkflowConfig;
}

/** Result of executing one step */
export interface WorkflowStepResult {
  /** Data to merge into shared context for subsequent steps */
  data?: Record<string, unknown>;
  /** Human-readable summary of what this step did */
  summary?: string;
  /** If true, abort the workflow */
  abort?: boolean;
  /** Cost of this step in USD */
  cost?: number;
}

/** A single step in a workflow */
export interface WorkflowStep {
  /** Step name (used for tracking and display) */
  name: string;
  /** Which model tier this step uses (or 'none', or 'dynamic' for runtime decision) */
  modelTier: ModelTier | 'dynamic';
  /** Execute this step */
  execute: (ctx: WorkflowStepContext) => Promise<WorkflowStepResult>;
  /** Skip this step in dry-run mode (e.g. posting) */
  skipInDryRun?: boolean;
}

// ─── Workflow Config ──────────────────────────────────────────────────────

/** Base workflow config — workflows extend this with their own fields */
export interface WorkflowConfig {
  /** Workflow id (matches plugin id) */
  name: string;
  /** Model tier mapping */
  models: ModelTierConfig;
  /** Optional schedule */
  schedule?: {
    cron?: string;
    dailyTime?: string;
    budgetCapUsd?: number;
  };
  /** Allow workflow-specific fields */
  [key: string]: unknown;
}

// ─── Workflow Result ──────────────────────────────────────────────────────

export interface WorkflowResult {
  steps: Array<{ name: string; summary: string; cost: number }>;
  totalCost: number;
  itemsProcessed: number;
  durationMs: number;
  dryRun: boolean;
}

// ─── Workflow Interface ───────────────────────────────────────────────────

/**
 * The Workflow interface plugins implement.
 * Core's WorkflowRunner orchestrates execution of any Workflow.
 */
export interface Workflow {
  /** Workflow id (e.g. "social", "trading") */
  readonly id: string;

  /** Display name */
  readonly name: string;

  /** Short description */
  readonly description: string;

  /** Steps in execution order */
  readonly steps: WorkflowStep[];

  /** Default config (used when not yet configured) */
  defaultConfig(): WorkflowConfig;

  /** Onboarding questions for first-time setup */
  readonly onboardingQuestions: OnboardingQuestion[];

  /** Build config from onboarding answers (may call cheap LLM to auto-generate) */
  buildConfigFromAnswers(answers: Record<string, string>, llm: (prompt: string) => Promise<string>): Promise<WorkflowConfig>;

  /** Optional: lifecycle hook before workflow runs (e.g. to load state) */
  beforeRun?(config: WorkflowConfig): Promise<void>;

  /** Optional: lifecycle hook after workflow runs */
  afterRun?(result: WorkflowResult): Promise<void>;
}

/** Question for interactive onboarding */
export interface OnboardingQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'select' | 'multi-select';
  options?: string[];
  default?: string;
}
