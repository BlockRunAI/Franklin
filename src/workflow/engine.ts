/**
 * Workflow Engine — shared orchestrator for all workflows.
 *
 * Subclasses (SocialWorkflow, TradingWorkflow, etc.) define steps.
 * Engine handles: model routing, dedup, tracking, display, dry-run, scheduling.
 */

import { ModelClient } from '../agent/llm.js';
import type {
  WorkflowConfig,
  WorkflowStep,
  WorkflowResult,
  StepContext,
  StepResult,
  SearchResult,
  WorkflowStats,
  OnboardingQuestion,
} from './types.js';
import { ModelRouter } from './model-router.js';
import { trackAction, isDuplicate, getStats, getByAction } from './tracker.js';
import { loadWorkflowConfig, saveWorkflowConfig, getModelTiers } from './config.js';

export abstract class WorkflowEngine {
  protected config: WorkflowConfig;
  protected router: ModelRouter;
  protected client: ModelClient;
  protected logs: string[] = [];

  constructor(client: ModelClient, config?: WorkflowConfig) {
    this.client = client;
    this.config = config ?? this.defaultConfig();
    this.router = new ModelRouter(client, getModelTiers(this.config));
  }

  // ─── Abstract: subclasses must implement ────────────────────────────────

  /** Workflow name */
  abstract get name(): string;

  /** Steps in execution order */
  abstract get steps(): WorkflowStep[];

  /** Default config for this workflow */
  abstract defaultConfig(): WorkflowConfig;

  /** Onboarding questions for first-time setup */
  abstract get onboardingQuestions(): OnboardingQuestion[];

  /** Build config from onboarding answers */
  abstract buildConfigFromAnswers(answers: Record<string, string>): Promise<WorkflowConfig>;

  // ─── Core: run a workflow ───────────────────────────────────────────────

  /** Execute all steps in order */
  async run(dryRun = false): Promise<WorkflowResult> {
    const start = Date.now();
    const stepResults: Array<{ name: string; summary: string; cost: number }> = [];
    let totalCost = 0;
    let itemsProcessed = 0;
    const data: Record<string, unknown> = {};

    // Track run start
    trackAction(this.name, 'run_start', `run-${Date.now()}`, { dryRun });

    const ctx: StepContext = {
      data,
      callModel: async (tier, prompt, system) => {
        if (tier === 'none') throw new Error('Cannot call model with tier "none"');
        const result = await this.router.call(tier, prompt, system);
        totalCost += result.cost;
        return result.text;
      },
      search: async (query, options) => this.searchWeb(query, options),
      log: (msg) => this.log(msg),
      track: async (action, metadata) => {
        trackAction(this.name, action, `${action}-${Date.now()}`, metadata, 0);
      },
      isDuplicate: async (key) => isDuplicate(this.name, key),
      dryRun,
      config: this.config,
    };

    for (const step of this.steps) {
      // Skip side-effect steps in dry-run mode
      if (dryRun && step.skipInDryRun) {
        stepResults.push({ name: step.name, summary: `[dry-run] skipped`, cost: 0 });
        continue;
      }

      this.log(`→ ${step.name}...`);

      try {
        const result = await step.execute(ctx);

        // Merge step data into shared context
        if (result.data) {
          Object.assign(data, result.data);
        }

        const stepCost = result.cost ?? 0;
        totalCost += stepCost;
        if (result.data?.itemCount) {
          itemsProcessed += result.data.itemCount as number;
        }

        stepResults.push({
          name: step.name,
          summary: result.summary ?? 'done',
          cost: stepCost,
        });

        // Abort if step says so (e.g. no results found)
        if (result.abort) {
          this.log(`⚠ ${step.name}: ${result.summary ?? 'aborted'}`);
          break;
        }
      } catch (err) {
        const errMsg = (err as Error).message;
        this.log(`✗ ${step.name} failed: ${errMsg}`);
        stepResults.push({ name: step.name, summary: `error: ${errMsg}`, cost: 0 });
        break;
      }
    }

    const result: WorkflowResult = {
      steps: stepResults,
      totalCost,
      itemsProcessed,
      durationMs: Date.now() - start,
      dryRun,
    };

    // Track run completion
    trackAction(this.name, 'run_complete', `run-${Date.now()}`, {
      dryRun,
      totalCost,
      itemsProcessed,
      durationMs: result.durationMs,
    }, totalCost);

    return result;
  }

  // ─── Init: onboarding flow ──────────────────────────────────────────────

  /** Check if workflow is configured */
  isConfigured(): boolean {
    return loadWorkflowConfig(this.name) !== null;
  }

  /** Save config after onboarding */
  saveConfig(config: WorkflowConfig): void {
    this.config = config;
    this.router = new ModelRouter(this.client, getModelTiers(config));
    saveWorkflowConfig(this.name, config);
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  getStats(): WorkflowStats {
    return getStats(this.name);
  }

  getLeads(): Array<Record<string, unknown>> {
    return getByAction(this.name, 'lead').map(e => ({
      ...e.metadata,
      createdAt: e.createdAt,
    }));
  }

  // ─── Utilities ──────────────────────────────────────────────────────────

  protected log(msg: string): void {
    this.logs.push(msg);
    // Also print to stderr for real-time visibility
    process.stderr.write(`[${this.name}] ${msg}\n`);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Search the web. Subclasses can override with platform-specific search.
   * Default: use the cheap model to generate search results from context.
   * In practice, social workflow overrides this with Exa/WebSearch MCP tools.
   */
  protected async searchWeb(
    _query: string,
    _options?: { sources?: string[]; maxResults?: number }
  ): Promise<SearchResult[]> {
    // Base implementation returns empty — subclasses override with actual search
    // (e.g. SocialWorkflow uses Exa MCP or WebSearch MCP)
    return [];
  }

  /** Format workflow result for display */
  formatResult(result: WorkflowResult): string {
    const lines: string[] = [];
    lines.push(`\n${'─'.repeat(50)}`);
    lines.push(`${this.name.toUpperCase()} WORKFLOW ${result.dryRun ? '[DRY RUN]' : 'COMPLETE'}`);
    lines.push(`${'─'.repeat(50)}`);

    for (const step of result.steps) {
      const costStr = step.cost > 0 ? ` ($${step.cost.toFixed(4)})` : '';
      lines.push(`  ${step.summary.startsWith('error') ? '✗' : '✓'} ${step.name}: ${step.summary}${costStr}`);
    }

    lines.push(`${'─'.repeat(50)}`);
    lines.push(`  Items: ${result.itemsProcessed}  Cost: $${result.totalCost.toFixed(4)}  Time: ${(result.durationMs / 1000).toFixed(1)}s`);
    lines.push(`${'─'.repeat(50)}\n`);

    return lines.join('\n');
  }

  /** Format stats for display */
  formatStats(stats: WorkflowStats): string {
    const lines: string[] = [];
    lines.push(`\n${'─'.repeat(40)}`);
    lines.push(`${this.name.toUpperCase()} STATS`);
    lines.push(`${'─'.repeat(40)}`);
    lines.push(`  Total runs: ${stats.totalRuns}`);
    lines.push(`  Total actions: ${stats.totalActions}`);
    lines.push(`  Total cost: $${stats.totalCostUsd.toFixed(4)}`);
    lines.push(`  Today: ${stats.todayActions} actions, $${stats.todayCostUsd.toFixed(4)}`);
    if (stats.lastRun) lines.push(`  Last run: ${stats.lastRun}`);

    if (Object.keys(stats.byAction).length > 0) {
      lines.push(`  By action:`);
      for (const [action, count] of Object.entries(stats.byAction)) {
        if (action !== 'run_start' && action !== 'run_complete') {
          lines.push(`    ${action}: ${count}`);
        }
      }
    }

    lines.push(`${'─'.repeat(40)}\n`);
    return lines.join('\n');
  }
}
