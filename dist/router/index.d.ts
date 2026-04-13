/**
 * Smart Router for Franklin
 *
 * Two routing modes:
 *   1. Learned — uses Elo scores from 2M+ gateway requests (router-weights.json)
 *   2. Classic — 15-dimension keyword scoring (fallback when no weights)
 *
 * The learned router detects request category (coding, trading, reasoning, etc.)
 * and picks the model with the best quality-to-cost ratio for that category.
 * Local Elo adjustments personalize routing per user over time.
 */
export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
export type RoutingProfile = 'auto' | 'eco' | 'premium' | 'free';
export interface RoutingResult {
    model: string;
    tier: Tier;
    confidence: number;
    signals: string[];
    savings: number;
}
export declare function routeRequest(prompt: string, profile?: RoutingProfile): RoutingResult;
/**
 * Get fallback models for a tier
 */
export declare function getFallbackChain(tier: Tier, profile?: RoutingProfile): string[];
/**
 * Parse routing profile from model string
 */
export declare function parseRoutingProfile(model: string): RoutingProfile | null;
