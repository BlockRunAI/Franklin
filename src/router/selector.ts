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
import { MODEL_PRICING } from '../pricing.js';

export interface ModelScore {
  model: string;
  elo: number;
  avg_cost_per_1k?: number;
  avg_latency_ms?: number;
  avg_tool_calls_per_turn?: number; // lower = more efficient
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

interface ProfileWeights {
  quality: number;
  cost: number;
  latency: number;
  efficiency: number;
}

const PROFILE_WEIGHTS: Record<string, ProfileWeights> = {
  auto:    { quality: 0.20, cost: 0.30, latency: 0.25, efficiency: 0.25 },
  eco:     { quality: 0.10, cost: 0.60, latency: 0.15, efficiency: 0.15 },
  premium: { quality: 0.40, cost: 0.10, latency: 0.25, efficiency: 0.25 },
};

export function selectModel(
  category: Category,
  profile: RoutingProfile,
  weights: LearnedWeights,
): SelectionResult | null {
  const candidates = weights.model_scores[category];
  if (!candidates || candidates.length === 0) return null;

  // Enrich with pricing data and defaults
  const enriched = candidates.map(c => {
    const pricing = MODEL_PRICING[c.model];
    const costPer1K = pricing
      ? (pricing.input + pricing.output) / 2 / 1000
      : c.avg_cost_per_1k ?? 0.005;
    const latencyMs = c.avg_latency_ms ?? 2000;
    // Efficiency: 1/avg_tool_calls (higher = better). Default 10 calls/turn if unknown.
    const toolCallsPerTurn = c.avg_tool_calls_per_turn ?? 10;
    const efficiency = 1 / Math.max(1, toolCallsPerTurn);
    return { ...c, costPer1K, latencyMs, efficiency };
  });

  // Filter to models we can actually route to
  const available = enriched.filter(c => MODEL_PRICING[c.model]);
  if (available.length === 0) return null;

  // ── Free profile: best efficiency + latency among free models ──
  if (profile === 'free') {
    const free = available.filter(c => c.costPer1K === 0);
    if (free.length === 0) return null;
    // Score free models by efficiency (60%) + latency (40%)
    const maxLat = Math.max(...free.map(c => c.latencyMs)) || 1;
    const maxEff = Math.max(...free.map(c => c.efficiency)) || 1;
    const selected = free.reduce((best, c) => {
      const s = 0.6 * (c.efficiency / maxEff) + 0.4 * (1 - c.latencyMs / maxLat);
      const bestS = 0.6 * (best.efficiency / maxEff) + 0.4 * (1 - best.latencyMs / maxLat);
      return s > bestS ? c : best;
    });
    return {
      model: selected.model,
      score: selected.efficiency,
      expectedCost: 0,
      expectedLatency: selected.latencyMs,
      category,
    };
  }

  // ── Scored profiles: auto / eco / premium ──
  const w = PROFILE_WEIGHTS[profile] ?? PROFILE_WEIGHTS.auto;

  // Compute normalization bounds
  const elos = available.map(c => c.elo);
  const costs = available.map(c => c.costPer1K);
  const latencies = available.map(c => c.latencyMs);
  const efficiencies = available.map(c => c.efficiency);

  const minElo = Math.min(...elos);
  const maxElo = Math.max(...elos);
  const maxCost = Math.max(...costs);
  const maxLatency = Math.max(...latencies);
  const maxEfficiency = Math.max(...efficiencies);

  const eloRange = maxElo - minElo || 1;
  const costRange = maxCost || 1;
  const latencyRange = maxLatency || 1;
  const efficiencyRange = maxEfficiency || 1;

  let bestScore = -Infinity;
  let selected = available[0];

  for (const c of available) {
    const normQuality = (c.elo - minElo) / eloRange;
    const normCost = c.costPer1K / costRange;
    const normLatency = c.latencyMs / latencyRange;
    const normEfficiency = c.efficiency / efficiencyRange;

    const score =
      w.quality    * normQuality +
      w.cost       * (1 - normCost) +
      w.latency    * (1 - normLatency) +
      w.efficiency * normEfficiency;

    if (score > bestScore) {
      bestScore = score;
      selected = c;
    }
  }

  return {
    model: selected.model,
    score: bestScore,
    expectedCost: selected.costPer1K,
    expectedLatency: selected.latencyMs,
    category,
  };
}
