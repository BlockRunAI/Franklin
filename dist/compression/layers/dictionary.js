/**
 * Layer 3: Dictionary Encoding
 *
 * Replaces frequently repeated long phrases with short codes.
 * Uses a static codebook of common patterns from production logs.
 *
 * Safe for LLM: Reversible substitution with codebook header.
 * Expected savings: 4-8%
 */
import { getInverseCodebook } from "../codebook.js";
/**
 * Apply dictionary encoding to a string.
 * Returns the encoded string and stats.
 */
function encodeContent(content, inverseCodebook) {
    let encoded = content;
    let substitutions = 0;
    let charsSaved = 0;
    const codes = new Set();
    // Sort phrases by length (longest first) to avoid partial matches
    const phrases = Object.keys(inverseCodebook).sort((a, b) => b.length - a.length);
    for (const phrase of phrases) {
        const code = inverseCodebook[phrase];
        const regex = new RegExp(escapeRegex(phrase), "g");
        const matches = encoded.match(regex);
        if (matches && matches.length > 0) {
            encoded = encoded.replace(regex, code);
            substitutions += matches.length;
            charsSaved += matches.length * (phrase.length - code.length);
            codes.add(code);
        }
    }
    return { encoded, substitutions, codes, charsSaved };
}
/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Apply dictionary encoding to all messages.
 */
export function encodeMessages(messages) {
    const inverseCodebook = getInverseCodebook();
    let totalSubstitutions = 0;
    let totalCharsSaved = 0;
    const allUsedCodes = new Set();
    const result = messages.map((message) => {
        if (!message.content || typeof message.content !== "string")
            return message;
        const { encoded, substitutions, codes, charsSaved } = encodeContent(message.content, inverseCodebook);
        totalSubstitutions += substitutions;
        totalCharsSaved += charsSaved;
        codes.forEach((code) => allUsedCodes.add(code));
        return {
            ...message,
            content: encoded,
        };
    });
    return {
        messages: result,
        substitutionCount: totalSubstitutions,
        usedCodes: allUsedCodes,
        charsSaved: totalCharsSaved,
    };
}
