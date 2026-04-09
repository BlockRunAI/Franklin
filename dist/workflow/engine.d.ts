/**
 * Workflow Engine — shared orchestrator for all workflows.
 *
 * Subclasses (SocialWorkflow, TradingWorkflow, etc.) define steps.
 * Engine handles: model routing, dedup, tracking, display, dry-run, scheduling.
 */
import { ModelClient } from '../agent/llm.js';
import type { WorkflowConfig, WorkflowStep, WorkflowResult, SearchResult, WorkflowStats, OnboardingQuestion } from './types.js';
import { ModelRouter } from './model-router.js';
export declare abstract class WorkflowEngine {
    protected config: WorkflowConfig;
    protected router: ModelRouter;
    protected client: ModelClient;
    protected logs: string[];
    constructor(client: ModelClient, config?: WorkflowConfig);
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
    /** Execute all steps in order */
    run(dryRun?: boolean): Promise<WorkflowResult>;
    /** Check if workflow is configured */
    isConfigured(): boolean;
    /** Save config after onboarding */
    saveConfig(config: WorkflowConfig): void;
    getStats(): WorkflowStats;
    getLeads(): Array<Record<string, unknown>>;
    protected log(msg: string): void;
    getLogs(): string[];
    /**
     * Search the web. Subclasses can override with platform-specific search.
     * Default: use the cheap model to generate search results from context.
     * In practice, social workflow overrides this with Exa/WebSearch MCP tools.
     */
    protected searchWeb(_query: string, _options?: {
        sources?: string[];
        maxResults?: number;
    }): Promise<SearchResult[]>;
    /** Format workflow result for display */
    formatResult(result: WorkflowResult): string;
    /** Format stats for display */
    formatStats(stats: WorkflowStats): string;
}
