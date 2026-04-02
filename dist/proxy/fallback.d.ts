/**
 * Fallback chain for 0xcode
 * Automatically switches to backup models when primary fails (429, 5xx, etc.)
 */
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
export declare const DEFAULT_FALLBACK_CONFIG: FallbackConfig;
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
 * Fetch with automatic fallback to backup models
 */
export declare function fetchWithFallback(url: string, init: RequestInit, originalBody: string, config?: FallbackConfig, onFallback?: (model: string, statusCode: number, nextModel: string) => void): Promise<FallbackResult>;
/**
 * Get the current model from fallback chain based on parsed request
 */
export declare function getCurrentModelFromChain(requestedModel: string | undefined, config?: FallbackConfig): string;
/**
 * Build fallback chain starting from a specific model.
 * Filters out routing profiles (blockrun/auto etc.) since the backend
 * doesn't recognize them — they must be resolved by the smart router first.
 */
export declare function buildFallbackChain(startModel: string, config?: FallbackConfig): string[];
