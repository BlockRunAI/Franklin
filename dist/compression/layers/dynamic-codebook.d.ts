/**
 * L7: Dynamic Codebook Builder
 *
 * Inspired by claw-compactor's frequency-based codebook.
 * Builds codebook from actual content being compressed,
 * rather than relying on static patterns.
 *
 * Finds phrases that appear 3+ times and replaces with short codes.
 */
import { NormalizedMessage } from "../types.js";
interface DynamicCodebookResult {
    messages: NormalizedMessage[];
    charsSaved: number;
    dynamicCodes: Record<string, string>;
    substitutions: number;
}
/**
 * Apply dynamic codebook to messages.
 */
export declare function applyDynamicCodebook(messages: NormalizedMessage[]): DynamicCodebookResult;
/**
 * Generate header for dynamic codes (to include in system message).
 */
export declare function generateDynamicCodebookHeader(codebook: Record<string, string>): string;
export {};
