/**
 * SubAgent capability — spawn a child agent for independent tasks.
 */
import type { CapabilityHandler } from '../agent/types.js';
export declare function createSubAgentCapability(apiUrl: string, chain: 'base' | 'solana', capabilities: CapabilityHandler[]): CapabilityHandler;
