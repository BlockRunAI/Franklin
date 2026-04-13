/**
 * Session-scoped per-model usage tracking.
 * In-memory only — resets on new session. Used by /cost and UI footer.
 */

export interface SessionModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastTier?: string;
}

const sessionModels = new Map<string, SessionModelUsage>();

export function recordSessionUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  tier?: string,
): void {
  const existing = sessionModels.get(model) ?? {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  existing.requests++;
  existing.inputTokens += inputTokens;
  existing.outputTokens += outputTokens;
  existing.costUsd += costUsd;
  if (tier) existing.lastTier = tier;
  sessionModels.set(model, existing);
}

export function getSessionModelBreakdown(): Array<{
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastTier?: string;
}> {
  return Array.from(sessionModels.entries())
    .map(([model, usage]) => ({ model, ...usage }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function resetSession(): void {
  sessionModels.clear();
}
