/**
 * Read capability — reads files with line numbers.
 */
import type { CapabilityHandler } from '../agent/types.js';
/**
 * Tracks files that were only partially read (offset or limit applied).
 * Stores the read range so Edit tool can give smarter warnings —
 * only warns if the edit target is near/beyond the boundary of what was read.
 * Exported so edit.ts can check and clear entries.
 */
export declare const partiallyReadFiles: Map<string, {
    startLine: number;
    endLine: number;
    totalLines: number;
}>;
/**
 * Tracks files that have been read in this session — enables read-before-edit enforcement.
 * Stores the file's mtime at read time so we can detect stale writes.
 * Exported so edit.ts and write.ts can check.
 */
export declare const fileReadTracker: Map<string, {
    mtimeMs: number;
    readAt: number;
}>;
/** Invalidate the content cache for a file (call after Edit/Write modifies it). */
export declare function invalidateFileCache(resolvedPath: string): void;
export declare const readCapability: CapabilityHandler;
