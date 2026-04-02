/**
 * Interactive model picker for 0xcode.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */
export declare const MODEL_SHORTCUTS: Record<string, string>;
/**
 * Resolve a model name — supports shortcuts.
 */
export declare function resolveModel(input: string): string;
/**
 * Show interactive model picker. Returns the selected model ID.
 * Falls back to text input if terminal doesn't support raw mode.
 */
export declare function pickModel(currentModel?: string): Promise<string | null>;
