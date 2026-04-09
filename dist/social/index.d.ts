/**
 * Social Workflow — AI-powered social media engagement.
 *
 * Search Reddit/X for relevant posts → filter with cheap LLM → score leads →
 * generate replies with multi-model routing → preview → post → track.
 */
import { WorkflowEngine } from '../workflow/engine.js';
import type { WorkflowConfig, WorkflowStep, OnboardingQuestion } from '../workflow/types.js';
import type { SocialConfig } from './types.js';
export declare class SocialWorkflow extends WorkflowEngine {
    get name(): string;
    get steps(): WorkflowStep[];
    defaultConfig(): WorkflowConfig;
    get socialConfig(): SocialConfig;
    get onboardingQuestions(): OnboardingQuestion[];
    buildConfigFromAnswers(answers: Record<string, string>): Promise<SocialConfig>;
    /** Step 1: Search for relevant posts */
    private searchStep;
    /** Step 2: Filter for relevance using cheap model */
    private filterStep;
    /** Step 3: Score leads */
    private scoreStep;
    /** Step 4: Draft replies (multi-model by lead score) */
    private draftStep;
    /** Step 5: Preview drafts for user review */
    private previewStep;
    /** Step 6: Post replies (skipped in dry-run) */
    private postStep;
    /** Step 7: Track results */
    private trackStep;
}
