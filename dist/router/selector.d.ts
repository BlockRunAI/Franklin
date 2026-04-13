/**
 * Model selector for the learned router.
 * Picks the best model for a category using Elo scores and cost-quality tradeoff.
 */
import type { Category } from './categories.js';
import type { RoutingProfile } from './index.js';
export interface ModelScore {
    model: string;
    elo: number;
    avg_cost_per_1k?: number;
    avg_latency_ms?: number;
}
export interface LearnedWeights {
    version: number;
    trained_on: number;
    trained_at: string;
    categories: string[];
    category_keywords?: Record<string, string[]>;
    model_scores: Record<string, ModelScore[]>;
}
export interface SelectionResult {
    model: string;
    elo: number;
    expectedCost: number;
    category: Category;
}
/**
 * Select the best model for a category and routing profile.
 *
 * Profiles:
 *   auto    — best α*quality + (1-α)*(1-cost), α=0.7
 *   eco     — best elo among cheapest 30%
 *   premium — highest elo regardless of cost
 *   free    — best elo among free models (cost=0)
 */
export declare function selectModel(category: Category, profile: RoutingProfile, weights: LearnedWeights): SelectionResult | null;
