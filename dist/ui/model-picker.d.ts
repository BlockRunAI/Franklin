/**
 * Interactive model picker for Franklin.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */
export declare const MODEL_SHORTCUTS: Record<string, string>;
/**
 * Resolve a model name — supports shortcuts.
 */
export declare function resolveModel(input: string): string;
export interface ModelEntry {
    id: string;
    shortcut: string;
    label: string;
    price: string;
    highlight?: boolean;
}
export interface ModelCategory {
    category: string;
    models: ModelEntry[];
}
/**
 * Single source of truth for the /model picker.
 * ~30 models across 6 categories. Every ID here is present in src/pricing.ts
 * and every shortcut is in MODEL_SHORTCUTS above.
 *
 * Both the Ink UI picker (src/ui/app.tsx) and the readline picker
 * (pickModel() below) import from this array. To add or remove models,
 * edit this one place.
 */
export declare const PICKER_CATEGORIES: ModelCategory[];
/** Flat list of all picker models (for index-based navigation). */
export declare const PICKER_MODELS_FLAT: ModelEntry[];
/**
 * Show interactive model picker. Returns the selected model ID.
 * Falls back to text input if terminal doesn't support raw mode.
 */
export declare function pickModel(currentModel?: string): Promise<string | null>;
