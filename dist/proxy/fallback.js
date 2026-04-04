/**
 * Fallback chain for runcode
 * Automatically switches to backup models when primary fails (429, 5xx, etc.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const LOG_FILE = path.join(os.homedir(), '.blockrun', 'runcode-debug.log');
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][A-B]|\r/g;
function appendLog(msg) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg.replace(ANSI_RE, '')}\n`);
    }
    catch { /* ignore */ }
}
export const DEFAULT_FALLBACK_CONFIG = {
    chain: [
        'deepseek/deepseek-chat', // Direct fallback — cheap & reliable
        'google/gemini-2.5-flash', // Fast & capable
        'nvidia/nemotron-ultra-253b', // Free model as ultimate fallback
    ],
    retryOn: [429, 500, 502, 503, 504, 529],
    maxRetries: 5,
    retryDelayMs: 1000,
};
/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Replace model in request body
 */
function replaceModelInBody(body, newModel) {
    try {
        const parsed = JSON.parse(body);
        parsed.model = newModel;
        return JSON.stringify(parsed);
    }
    catch {
        return body;
    }
}
/**
 * Fetch with automatic fallback to backup models
 */
export async function fetchWithFallback(url, init, originalBody, config = DEFAULT_FALLBACK_CONFIG, onFallback) {
    const failedModels = [];
    let attempts = 0;
    const FALLBACK_TIMEOUT_MS = 60_000; // 60s per attempt
    for (let i = 0; i < config.chain.length && attempts < config.maxRetries; i++) {
        const model = config.chain[i];
        const body = replaceModelInBody(originalBody, model);
        try {
            attempts++;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
            const response = await fetch(url, {
                ...init,
                body,
                signal: controller.signal,
            });
            clearTimeout(timeout);
            // Success or non-retryable error
            if (!config.retryOn.includes(response.status)) {
                return {
                    response,
                    modelUsed: model,
                    bodyUsed: body,
                    fallbackUsed: i > 0,
                    attemptsCount: attempts,
                    failedModels,
                };
            }
            // Retryable error - log and try next
            failedModels.push(model);
            const nextModel = config.chain[i + 1];
            if (nextModel && onFallback) {
                onFallback(model, response.status, nextModel);
            }
            // Wait before trying next model (with exponential backoff for same model retries)
            if (i < config.chain.length - 1) {
                await sleep(config.retryDelayMs);
            }
        }
        catch (err) {
            // Network error - try next model
            failedModels.push(model);
            const nextModel = config.chain[i + 1];
            if (nextModel && onFallback) {
                const errMsg = err instanceof Error ? err.message : 'Network error';
                onFallback(model, 0, nextModel);
                appendLog(`[runcode] [fallback] ${model} network error: ${errMsg}`);
            }
            if (i < config.chain.length - 1) {
                await sleep(config.retryDelayMs);
            }
        }
    }
    // All models failed - throw error
    throw new Error(`All models in fallback chain failed: ${failedModels.join(', ')}`);
}
/**
 * Get the current model from fallback chain based on parsed request
 */
export function getCurrentModelFromChain(requestedModel, config = DEFAULT_FALLBACK_CONFIG) {
    // If model is explicitly set and in chain, start from there
    if (requestedModel) {
        const index = config.chain.indexOf(requestedModel);
        if (index >= 0) {
            return requestedModel;
        }
        // Model not in chain, use as-is (user specified custom model)
        return requestedModel;
    }
    // Default to first model in chain
    return config.chain[0];
}
/** Routing profiles that must never be sent to the backend directly */
const ROUTING_PROFILES = new Set([
    'blockrun/auto', 'blockrun/eco', 'blockrun/premium', 'blockrun/free',
]);
/**
 * Build fallback chain starting from a specific model.
 * Filters out routing profiles (blockrun/auto etc.) since the backend
 * doesn't recognize them — they must be resolved by the smart router first.
 */
export function buildFallbackChain(startModel, config = DEFAULT_FALLBACK_CONFIG) {
    // Never include routing profiles in the chain — they'd cause 400s
    const safeChain = config.chain.filter(m => !ROUTING_PROFILES.has(m));
    const index = safeChain.indexOf(startModel);
    if (index >= 0) {
        return safeChain.slice(index);
    }
    // If startModel is a routing profile, skip it and just use the safe chain
    if (ROUTING_PROFILES.has(startModel)) {
        return safeChain;
    }
    // Model not in default chain - prepend it
    return [startModel, ...safeChain];
}
