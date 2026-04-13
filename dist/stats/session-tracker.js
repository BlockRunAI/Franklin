/**
 * Session-scoped per-model usage tracking.
 * In-memory only — resets on new session. Used by /cost and UI footer.
 */
const sessionModels = new Map();
export function recordSessionUsage(model, inputTokens, outputTokens, costUsd, tier) {
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
    if (tier)
        existing.lastTier = tier;
    sessionModels.set(model, existing);
}
export function getSessionModelBreakdown() {
    return Array.from(sessionModels.entries())
        .map(([model, usage]) => ({ model, ...usage }))
        .sort((a, b) => b.costUsd - a.costUsd);
}
export function resetSession() {
    sessionModels.clear();
}
