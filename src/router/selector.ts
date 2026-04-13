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
import { MODEL_PRICING } from '../pricing.js';

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

interface ProfileWeights {
  quality: number;
  cost: number;
  latency: number;
}

const PROFILE_WEIGHTS: Record<string, ProfileWeights> = {
  auto:    { quality: 0.3, cost: 0.4, latency: 0.3 },
  eco:     { quality: 0.1, cost: 0.7, latency: 0.2 },
  premium: { quality: 0.6, cost: 0.1, latency: 0.3 },
};

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
    const latencyMs = c.avg_latency_ms ?? 2000; // default 2s if unknown
    return { ...c, costPer1K, latencyMs };
  });

  // Filter to models we can actually route to
  const available = enriched.filter(c => MODEL_PRICING[c.model]);
  if (available.length === 0) return null;

  // ── Free profile: best latency among free models ──
  if (profile === 'free') {
    const free = available.filter(c => c.costPer1K === 0);
    if (free.length === 0) return null;
    const selected = free.reduce((best, c) => c.latencyMs < best.latencyMs ? c : best);
    return {
      model: selected.model,
      score: selected.elo,
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

  const minElo = Math.min(...elos);
  const maxElo = Math.max(...elos);
  const maxCost = Math.max(...costs);
  const maxLatency = Math.max(...latencies);

  const eloRange = maxElo - minElo || 1;
  const costRange = maxCost || 1;
  const latencyRange = maxLatency || 1;

  let bestScore = -Infinity;
  let selected = available[0];

  for (const c of available) {
    const normQuality = (c.elo - minElo) / eloRange;
    const normCost = c.costPer1K / costRange;
    const normLatency = c.latencyMs / latencyRange;

    const score =
      w.quality * normQuality +
      w.cost    * (1 - normCost) +
      w.latency * (1 - normLatency);

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
