/**
 * LLM-Safe Context Compression Types
 *
 * Types for the 5-layer compression system that reduces token usage
 * while preserving semantic meaning for LLM queries.
 */
// Default configuration - CONSERVATIVE settings for model compatibility
// Only enable layers that don't require the model to decode anything
export const DEFAULT_COMPRESSION_CONFIG = {
    enabled: true,
    preserveRaw: true,
    layers: {
        deduplication: true, // Safe: removes duplicate messages
        whitespace: true, // Safe: normalizes whitespace
        dictionary: false, // DISABLED: requires model to understand codebook
        paths: false, // DISABLED: requires model to understand path codes
        jsonCompact: true, // Safe: just removes JSON whitespace
        observation: false, // DISABLED: may lose important context
        dynamicCodebook: false, // DISABLED: requires model to understand codes
    },
    dictionary: {
        maxEntries: 50,
        minPhraseLength: 15,
        includeCodebookHeader: false, // No codebook header needed
    },
};
