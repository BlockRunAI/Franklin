import { gatewayFetch as fetch } from '../payments/account.js';
/**
 * Fallback chain for Franklin
 * Automatically switches to backup models when primary fails (429, 5xx, etc.)
 */

import { logger } from '../logger.js';
import { FREE_DEFAULT_MODEL, isFreeModelId } from '../free-models.js';
import { isVisionModel } from '../router/vision.js';

export interface FallbackConfig {
  /** Models to try in order of priority */
  chain: string[];
  /** HTTP status codes that trigger fallback */
  retryOn: number[];
  /** Maximum retries across all models */
  maxRetries: number;
  /** Delay between retries in ms */
  retryDelayMs: number;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  chain: [
    'deepseek/deepseek-chat', // Direct fallback — cheap & reliable
    'google/gemini-2.5-flash', // Fast & capable
    FREE_DEFAULT_MODEL, // Free model as ultimate fallback — see src/free-models.ts
  ],
  retryOn: [429, 500, 502, 503, 504, 529],
  maxRetries: 5,
  retryDelayMs: 1000,
};

export interface FallbackResult {
  response: Response;
  modelUsed: string;
  /** The request body with the successful model substituted in */
  bodyUsed: string;
  fallbackUsed: boolean;
  attemptsCount: number;
  failedModels: string[];
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replace model in request body
 */
function replaceModelInBody(body: string, newModel: string): string {
  try {
    const parsed = JSON.parse(body);
    parsed.model = newModel;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Fetch with automatic fallback to backup models
 */
export async function fetchWithFallback(
  url: string,
  init: RequestInit,
  originalBody: string,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG,
  onFallback?: (model: string, statusCode: number, nextModel: string) => void
): Promise<FallbackResult> {
  const failedModels: string[] = [];
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
    } catch (err) {
      // Network error - try next model
      failedModels.push(model);
      const nextModel = config.chain[i + 1];

      if (nextModel && onFallback) {
        const errMsg = err instanceof Error ? err.message : 'Network error';
        onFallback(model, 0, nextModel);
        logger.warn(`[franklin] [fallback] ${model} network error: ${errMsg}`);
      }

      if (i < config.chain.length - 1) {
        await sleep(config.retryDelayMs);
      }
    }
  }

  // All models failed - throw error
  throw new Error(
    `All models in fallback chain failed: ${failedModels.join(', ')}`
  );
}

/**
 * Get the current model from fallback chain based on parsed request
 */
export function getCurrentModelFromChain(
  requestedModel: string | undefined,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG
): string {
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

/** Routing profiles that must never be sent to the backend directly. */
export const ROUTING_PROFILES = new Set([
  'blockrun/auto', 'blockrun/free',
]);

/**
 * Build fallback chain starting from a specific model.
 * Filters out routing profiles (blockrun/auto etc.) since the backend
 * doesn't recognize them — they must be resolved by the smart router first.
 *
 * A FREE start model never falls back to a paid one. The default chain leads
 * with paid rungs (deepseek, gemini), so a proxy client that explicitly asked
 * for a free model and hit a 429 or a 5xx used to have its next attempt signed
 * as an x402 payment — a wallet charge the caller never asked for, triggered by
 * nothing more than provider overload. `blockrun/free` was already handled;
 * a concrete free id was not.
 */
export function buildFallbackChain(
  startModel: string,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG,
  needsVision = false,
): string[] {
  // Never include routing profiles in the chain — they'd cause 400s
  let safeChain = config.chain.filter(m => !ROUTING_PROFILES.has(m));

  // A request carrying images must not fall back onto a text-only model.
  //
  // The pre-request guard in proxy/server.ts swaps a text-only pick for a
  // vision sibling, but it runs ONCE, before the call. This chain is walked
  // AFTER a failure, so the guard was bypassed on every retry: an image sent
  // to claude-sonnet-4.6 that hit a 429 fell straight to
  // deepseek/deepseek-chat, which cannot read images at all.
  //
  // That costs real money. The gateway does not always refuse these before
  // payment — probed 2026-08-31, Base returns 402 (a payment quote) for an
  // image request to deepseek/deepseek-chat and the whole zai/glm-5.x line,
  // while Solana correctly 400s them pre-payment. So on Base the retry is
  // quoted, signed, settled, and THEN rejected upstream — or worse, answered
  // without the image. Same shape as the free-tier guard above: the chain has
  // to know what the request needs, not just what it costs.
  if (needsVision) {
    safeChain = safeChain.filter(m => isVisionModel(m));
  }

  // Free start model → free-only chain. Ends the walk rather than reaching for
  // a paid rung; the caller gets the failure instead of a surprise charge.
  if (isFreeModelId(startModel)) {
    return [startModel, ...safeChain.filter(m => m !== startModel && isFreeModelId(m))];
  }

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
