/**
 * Request category detection for the learned router.
 * Classifies requests into categories (coding, trading, reasoning, etc.)
 * using keyword matching from router weights or built-in defaults.
 */
export type Category = 'coding' | 'trading' | 'reasoning' | 'chat' | 'creative' | 'research';
interface CategoryResult {
    category: Category;
    confidence: number;
    scores: Partial<Record<Category, number>>;
}
/**
 * Detect the primary category of a request.
 * Uses provided keywords (from learned weights) or built-in defaults.
 */
export declare function detectCategory(prompt: string, categoryKeywords?: Record<string, string[]>): CategoryResult;
/**
 * Map a learned category to the legacy tier system (backward compat).
 */
export declare function mapCategoryToTier(category: Category): 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
export {};
