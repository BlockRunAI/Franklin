/**
 * Adapter between brcc's Dialogue type and the compression lib's NormalizedMessage type.
 */
import type { Dialogue } from '../agent/types.js';
/**
 * Compress conversation history to reduce token usage.
 * Returns compressed Dialogue[] with stats.
 */
export declare function compressHistory(history: Dialogue[], debug?: boolean): Promise<{
    history: Dialogue[];
    saved: number;
    ratio: number;
} | null>;
