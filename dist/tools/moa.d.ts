/**
 * Mixture-of-Agents (MoA) — query multiple models in parallel, aggregate with a strong model.
 *
 * How it works:
 * 1. Send the same prompt to N reference models (cheap/free) in parallel
 * 2. Collect all responses
 * 3. Send all responses + the original prompt to a strong aggregator model
 * 4. Aggregator synthesizes the best answer from all references
 *
 * This produces higher-quality answers than any single model for complex questions.
 * Inspired by the Mixture-of-Agents architecture from Together.ai research.
 */
import type { CapabilityHandler } from '../agent/types.js';
export declare const moaCapability: CapabilityHandler;
/** Register the API URL for MoA tool (called during agent setup). */
export declare function registerMoAConfig(apiUrl: string, chain: 'base' | 'solana', parentModel?: string): void;
