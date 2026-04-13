/**
 * Model selector for the learned router.
 *
 * Scoring formula (4 factors):
 *   score = w_quality    * norm_quality
 *         + w_cost       * (1 - norm_cost)
 *         + w_latency    * (1 - norm_latency)
 *         + w_efficiency * norm_efficiency
 *
 * Efficiency = how few tool calls a model needs to complete a task.
 * A model that does it in 5 calls is better than one that loops 85 times.
 * Measured as 1/avg_tool_calls_per_turn (higher = more efficient).
 *
 * Profile weights:
 *   auto    — balanced: quality 0.2, cost 0.3, latency 0.25, efficiency 0.25
 *   eco     — cost-first: quality 0.1, cost 0.6, latency 0.15, efficiency 0.15
 *   premium — quality-first: quality 0.4, cost 0.1, latency 0.25, efficiency 0.25
 *   free    — best efficiency among free models
 */
import type { Category } from './categories.js';
import type { RoutingProfile } from './index.js';
export interface ModelScore {
    model: string;
    elo: number;
    avg_cost_per_1k?: number;
    avg_latency_ms?: number;
    avg_tool_calls_per_turn?: number;
    requests?: number;
    unique_users?: number;
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
    score: number;
    expectedCost: number;
    expectedLatency: number;
    category: Category;
}
export declare function selectModel(category: Category, profile: RoutingProfile, weights: LearnedWeights): SelectionResult | null;
