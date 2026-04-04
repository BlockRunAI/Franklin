/**
 * Layer 2: Whitespace Normalization
 *
 * Reduces excessive whitespace without changing semantic meaning.
 *
 * Safe for LLM: Tokenizers normalize whitespace anyway.
 * Expected savings: 3-8%
 */
import { NormalizedMessage } from "../types.js";
export interface WhitespaceResult {
    messages: NormalizedMessage[];
    charsSaved: number;
}
/**
 * Normalize whitespace in a string.
 *
 * - Max 2 consecutive newlines
 * - Remove trailing whitespace from lines
 * - Normalize tabs to spaces
 * - Trim start/end
 */
export declare function normalizeWhitespace(content: string): string;
/**
 * Apply whitespace normalization to all messages.
 */
export declare function normalizeMessagesWhitespace(messages: NormalizedMessage[]): WhitespaceResult;
