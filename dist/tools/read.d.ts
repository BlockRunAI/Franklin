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
/**
 * Tracks files that have been read in this session — enables read-before-edit enforcement.
 * Stores the file's mtime at read time so we can detect stale writes.
 * Exported so edit.ts and write.ts can check.
 */
export declare const fileReadTracker: Map<string, {
    mtimeMs: number;
    readAt: number;
}>;
export declare const readCapability: CapabilityHandler;
