/**
 * PostToX capability — post a reply to a tweet on X.
 * The agent MUST confirm the reply text with the user before calling this tool.
 * Requires the pre_key from a SearchX result.
 */
import type { CapabilityHandler } from '../agent/types.js';
export declare const postToXCapability: CapabilityHandler;
