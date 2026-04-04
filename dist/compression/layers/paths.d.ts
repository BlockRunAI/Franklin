/**
 * Layer 4: Path Shortening
 *
 * Detects common filesystem path prefixes and replaces them with short codes.
 * Common in coding assistant contexts with repeated file paths.
 *
 * Safe for LLM: Lossless abbreviation with path map header.
 * Expected savings: 1-3%
 */
import { NormalizedMessage } from "../types.js";
export interface PathShorteningResult {
    messages: NormalizedMessage[];
    pathMap: Record<string, string>;
    charsSaved: number;
}
/**
 * Apply path shortening to all messages.
 */
export declare function shortenPaths(messages: NormalizedMessage[]): PathShorteningResult;
/**
 * Generate the path map header for the codebook.
 */
export declare function generatePathMapHeader(pathMap: Record<string, string>): string;
