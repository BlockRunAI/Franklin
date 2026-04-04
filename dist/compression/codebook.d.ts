/**
 * Dictionary Codebook
 *
 * Static dictionary of frequently repeated phrases observed in LLM prompts.
 * Built from analysis of BlockRun production logs.
 *
 * Format: Short code ($XX) -> Long phrase
 * The LLM receives a codebook header and decodes in-context.
 */
export declare const STATIC_CODEBOOK: Record<string, string>;
/**
 * Get the inverse codebook for decompression.
 */
export declare function getInverseCodebook(): Record<string, string>;
/**
 * Generate the codebook header for inclusion in system message.
 * LLMs can decode in-context using this header.
 */
export declare function generateCodebookHeader(usedCodes: Set<string>, pathMap?: Record<string, string>): string;
/**
 * Decompress a string using the codebook (for logging).
 */
export declare function decompressContent(content: string, codebook?: Record<string, string>): string;
