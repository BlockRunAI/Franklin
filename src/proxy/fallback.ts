/**
 * Fallback chain for 0xcode
 * Automatically switches to backup models when primary fails (429, 5xx, etc.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = path.join(os.homedir(), '.blockrun', '0xcode-debug.log');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][A-B]|\r/g;
function appendLog(msg: string) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg.replace(ANSI_RE, '')}\n`);
  } catch { /* ignore */ }
}

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
    'nvidia/nemotron-ultra-253b', // Free model as ultimate fallback
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

  for (let i = 0; i < config.chain.length && attempts < config.maxRetries; i++) {
    const model = config.chain[i];
    const body = replaceModelInBody(originalBody, model);

    try {
      attempts++;
      const response = await fetch(url, {
        ...init,
        body,
      });

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
        appendLog(`[0xcode] [fallback] ${model} network error: ${errMsg}`);
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

/** Routing profiles that must never be sent to the backend directly */
const ROUTING_PROFILES = new Set([
  'blockrun/auto', 'blockrun/eco', 'blockrun/premium', 'blockrun/free',
]);

/**
 * Build fallback chain starting from a specific model.
 * Filters out routing profiles (blockrun/auto etc.) since the backend
 * doesn't recognize them — they must be resolved by the smart router first.
 */
export function buildFallbackChain(
  startModel: string,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG
): string[] {
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
