/**
 * Model selector for the learned router.
 * Picks the best model for a category using Elo scores and cost-quality tradeoff.
 */

import type { Category } from './categories.js';
import type { RoutingProfile } from './index.js';
import { MODEL_PRICING } from '../pricing.js';

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
export function selectModel(
  category: Category,
  profile: RoutingProfile,
  weights: LearnedWeights,
): SelectionResult | null {
  const candidates = weights.model_scores[category];
  if (!candidates || candidates.length === 0) return null;

  // Enrich with pricing data
  const enriched = candidates.map(c => {
    const pricing = MODEL_PRICING[c.model];
    const costPer1K = pricing
      ? (pricing.input + pricing.output) / 2 / 1000
      : c.avg_cost_per_1k ?? 0.005;
    return { ...c, costPer1K };
  });

  // Filter out models not in our pricing DB (we can't route to unknown models)
  const available = enriched.filter(c => MODEL_PRICING[c.model]);
  if (available.length === 0) return null;

  let selected: typeof available[0];

  switch (profile) {
    case 'free': {
      // Pick best elo among free models
      const free = available.filter(c => c.costPer1K === 0);
      if (free.length === 0) return null;
      selected = free.reduce((best, c) => c.elo > best.elo ? c : best);
      break;
    }
    case 'eco': {
      // Sort by cost, take cheapest 30%, pick best elo among those
      const sorted = [...available].sort((a, b) => a.costPer1K - b.costPer1K);
      const cheapPool = sorted.slice(0, Math.max(2, Math.ceil(sorted.length * 0.3)));
      selected = cheapPool.reduce((best, c) => c.elo > best.elo ? c : best);
      break;
    }
    case 'premium': {
      // Highest elo regardless of cost
      selected = available.reduce((best, c) => c.elo > best.elo ? c : best);
      break;
    }
    default: { // 'auto'
      // Pareto: α * normalized_elo + (1-α) * (1 - normalized_cost)
      const alpha = 0.7;
      const maxElo = Math.max(...available.map(c => c.elo));
      const minElo = Math.min(...available.map(c => c.elo));
      const maxCost = Math.max(...available.map(c => c.costPer1K));
      const eloRange = maxElo - minElo || 1;
      const costRange = maxCost || 1;

      let bestScore = -Infinity;
      selected = available[0];
      for (const c of available) {
        const normElo = (c.elo - minElo) / eloRange;
        const normCost = c.costPer1K / costRange;
        const score = alpha * normElo + (1 - alpha) * (1 - normCost);
        if (score > bestScore) {
          bestScore = score;
          selected = c;
        }
      }
      break;
    }
  }

  return {
    model: selected.model,
    elo: selected.elo,
    expectedCost: selected.costPer1K,
    category,
  };
}
