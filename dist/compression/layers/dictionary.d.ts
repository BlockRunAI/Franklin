/**
 * Layer 3: Dictionary Encoding
 *
 * Replaces frequently repeated long phrases with short codes.
 * Uses a static codebook of common patterns from production logs.
 *
 * Safe for LLM: Reversible substitution with codebook header.
 * Expected savings: 4-8%
 */
import { NormalizedMessage } from "../types.js";
export interface DictionaryResult {
    messages: NormalizedMessage[];
    substitutionCount: number;
    usedCodes: Set<string>;
    charsSaved: number;
}
/**
 * Apply dictionary encoding to all messages.
 */
export declare function encodeMessages(messages: NormalizedMessage[]): DictionaryResult;
