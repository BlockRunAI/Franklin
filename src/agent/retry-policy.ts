import { estimateCost } from '../pricing.js';
import { estimateHistoryTokens } from './tokens.js';
import type { Dialogue } from './types.js';

export const TIMEOUT_RETRY_INPUT_TOKEN_LIMIT = 20_000;
export const TIMEOUT_RETRY_MIN_REPLAY_COST_LIMIT_USD = 0.05;

export type TimeoutRetrySkipReason = 'estimated_cost' | 'input_tokens';

export interface TimeoutRetryDecision {
  retry: boolean;
  estimatedInputTokens: number;
  estimatedReplayCostUsd: number;
  reason?: TimeoutRetrySkipReason;
}

/**
 * A timeout retry re-sends the entire conversation. For long paid contexts,
 * that can cost more than the original useful work and hit the turn budget
 * before the model gets another chance to finish.
 */
export function evaluateTimeoutRetry(
  history: Dialogue[],
  model: string,
  opts?: {
    inputTokenLimit?: number;
    minReplayCostLimitUsd?: number;
  }
): TimeoutRetryDecision {
  const inputTokenLimit = opts?.inputTokenLimit ?? TIMEOUT_RETRY_INPUT_TOKEN_LIMIT;
  const minReplayCostLimitUsd =
    opts?.minReplayCostLimitUsd ?? TIMEOUT_RETRY_MIN_REPLAY_COST_LIMIT_USD;

  const estimatedInputTokens = estimateHistoryTokens(history);
  const estimatedReplayCostUsd = estimateCost(model, estimatedInputTokens, 0, 1);

  if (estimatedReplayCostUsd > minReplayCostLimitUsd) {
    return {
      retry: false,
      estimatedInputTokens,
      estimatedReplayCostUsd,
      reason: 'estimated_cost',
    };
  }

  if (estimatedInputTokens > inputTokenLimit) {
    return {
      retry: false,
      estimatedInputTokens,
      estimatedReplayCostUsd,
      reason: 'input_tokens',
    };
  }

  return {
    retry: true,
    estimatedInputTokens,
    estimatedReplayCostUsd,
  };
}
