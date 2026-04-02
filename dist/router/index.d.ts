/**
 * Smart Router for 0xcode
 * Ported from ClawRouter - 15-dimension weighted scoring for tier classification
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
