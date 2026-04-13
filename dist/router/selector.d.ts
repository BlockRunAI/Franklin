/**
 * Model selector for the learned router.
 *
 * Scoring formula:
 *   score = w_quality * norm_quality
 *         + w_cost    * (1 - norm_cost)
 *         + w_latency * (1 - norm_latency)
 *
 * Quality is the weakest signal (popularity-based Elo, until we have benchmarks).
 * Cost and latency are hard data from the gateway. They carry more weight.
 *
 * Profile weights:
 *   auto    — balanced: quality 0.3, cost 0.4, latency 0.3
 *   eco     — cost-first: quality 0.1, cost 0.7, latency 0.2
 *   premium — quality-first: quality 0.6, cost 0.1, latency 0.3
 *   free    — best latency among free models
 */
import type { Category } from './categories.js';
import type { RoutingProfile } from './index.js';
export interface ModelScore {
    model: string;
    elo: number;
    avg_cost_per_1k?: number;
    avg_latency_ms?: number;
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
