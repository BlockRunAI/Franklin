/**
 * LLM-Safe Context Compression Types
 *
 * Types for the 5-layer compression system that reduces token usage
 * while preserving semantic meaning for LLM queries.
 */
export type ContentPart = {
    type: string;
    text?: string;
    image_url?: {
        url: string;
        detail?: string;
    };
};
export interface NormalizedMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[] | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    name?: string;
}
export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface CompressionConfig {
    enabled: boolean;
    preserveRaw: boolean;
    layers: {
        deduplication: boolean;
        whitespace: boolean;
        dictionary: boolean;
        paths: boolean;
        jsonCompact: boolean;
        observation: boolean;
        dynamicCodebook: boolean;
    };
    dictionary: {
        maxEntries: number;
        minPhraseLength: number;
        includeCodebookHeader: boolean;
    };
}
export interface CompressionStats {
    duplicatesRemoved: number;
    whitespaceSavedChars: number;
    dictionarySubstitutions: number;
    pathsShortened: number;
    jsonCompactedChars: number;
    observationsCompressed: number;
    observationCharsSaved: number;
    dynamicSubstitutions: number;
    dynamicCharsSaved: number;
}
export interface CompressionResult {
    messages: NormalizedMessage[];
    originalMessages: NormalizedMessage[];
    originalChars: number;
    compressedChars: number;
    compressionRatio: number;
    stats: CompressionStats;
    codebook: Record<string, string>;
    pathMap: Record<string, string>;
    dynamicCodes: Record<string, string>;
}
export interface CompressionLogData {
    enabled: boolean;
    ratio: number;
    original_chars: number;
    compressed_chars: number;
    stats: {
        duplicates_removed: number;
        whitespace_saved: number;
        dictionary_subs: number;
        paths_shortened: number;
        json_compacted: number;
    };
}
export declare const DEFAULT_COMPRESSION_CONFIG: CompressionConfig;
