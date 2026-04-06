/**
 * Read capability — reads files with line numbers.
 */
import type { CapabilityHandler } from '../agent/types.js';
/**
 * Tracks files that were only partially read (offset or limit applied).
 * Edit tool uses this to warn when editing without full context.
 * Exported so edit.ts can check and clear entries.
 */
export declare const partiallyReadFiles: Set<string>;
export declare const readCapability: CapabilityHandler;
