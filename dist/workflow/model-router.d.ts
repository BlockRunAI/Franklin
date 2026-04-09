/**
 * Multi-model tier router.
 * Maps ModelTier (free/cheap/premium) to actual model names.
 * Uses RunCode's existing ModelClient for API calls.
 */
import { ModelClient } from '../agent/llm.js';
import type { ModelTier, ModelTierConfig } from './types.js';
export declare class ModelRouter {
    private client;
    private tiers;
    constructor(client: ModelClient, tiers?: ModelTierConfig);
    /** Resolve a tier to an actual model name */
    resolveModel(tier: ModelTier): string | null;
    /** Call a model at the specified tier. Returns the response text + cost. */
    call(tier: ModelTier, prompt: string, system?: string): Promise<{
        text: string;
        cost: number;
        model: string;
    }>;
    /** Get the tier config for display */
    getTiers(): ModelTierConfig;
    /** Estimate cost for a tier (rough, for display before execution) */
    estimateTierCost(tier: ModelTier): string;
}
