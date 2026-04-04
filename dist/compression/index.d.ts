/**
 * LLM-Safe Context Compression
 *
 * Reduces token usage by 15-40% while preserving semantic meaning.
 * Implements 7 compression layers inspired by claw-compactor.
 *
 * Usage:
 *   const result = await compressContext(messages);
 *   // result.messages -> compressed version to send to provider
 *   // result.originalMessages -> original for logging
 */
import { NormalizedMessage, CompressionConfig, CompressionResult } from "./types.js";
export * from "./types.js";
export { STATIC_CODEBOOK } from "./codebook.js";
/**
 * Main compression function.
 *
 * Applies 5 layers in sequence:
 * 1. Deduplication - Remove exact duplicate messages
 * 2. Whitespace - Normalize excessive whitespace
 * 3. Dictionary - Replace common phrases with codes
 * 4. Paths - Shorten repeated file paths
 * 5. JSON - Compact JSON in tool calls
 *
 * Then prepends a codebook header for the LLM to decode in-context.
 */
export declare function compressContext(messages: NormalizedMessage[], config?: Partial<CompressionConfig>): Promise<CompressionResult>;
/**
 * Quick check if compression would benefit these messages.
 * Returns true if messages are large enough to warrant compression.
 */
export declare function shouldCompress(messages: NormalizedMessage[]): boolean;
