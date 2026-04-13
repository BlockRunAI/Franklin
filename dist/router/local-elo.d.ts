/**
 * Local Elo learning — adapts routing to the user's own usage patterns.
 * Tracks model outcomes per category and adjusts Elo ratings locally.
 *
 * Storage: ~/.blockrun/router-history.jsonl (append-only, capped 2000 records)
 * Never uploaded — purely local personalization.
 */
export type Outcome = 'continued' | 'switched' | 'retried' | 'error' | 'max_turns';
/**
 * Record a model outcome for local learning.
 */
export declare function recordOutcome(category: string, model: string, outcome: Outcome, toolCalls?: number): void;
/**
 * Compute local Elo adjustments from history.
 * Returns a map of (category → model → elo_delta).
 *
 * Outcomes map to win/loss:
 *   continued → win  (+K * 0.6)
 *   switched  → loss (-K * 1.0)
 *   retried   → loss (-K * 0.8)
 *   error     → loss (-K * 0.5)
 *   max_turns → loss (-K * 0.3)
 */
export declare function computeLocalElo(): Map<string, Map<string, number>>;
/**
 * Get the effective Elo for a model in a category,
 * blending global (server-trained) and local (user-specific) scores.
 *
 * effective = 0.7 * global + 0.3 * (1200 + local_delta)
 */
export declare function blendElo(globalElo: number, localDelta: number): number;
