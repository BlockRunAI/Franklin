/**
 * SearchX capability — search X (Twitter) for posts matching a query.
 * Returns candidate posts with snippets, tweet URLs, and product relevance scores.
 *
 * Works in two modes:
 *   - **Basic** (no config): browser-only search, returns snippets + URLs
 *   - **Enhanced** (with social config): adds product routing, dedup, login detection
 */
import type { CapabilityHandler } from '../agent/types.js';
export declare const searchXCapability: CapabilityHandler;
