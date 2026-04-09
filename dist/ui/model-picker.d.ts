/**
 * Interactive model picker for runcode.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */
export declare const MODEL_SHORTCUTS: Record<string, string>;
/**
 * Resolve a model name — supports shortcuts.
 */
export declare function resolveModel(input: string): string;
interface ModelEntry {
    id: string;
    shortcut: string;
    label: string;
    price: string;
}
/** Flat curated list in picker order (for numbering / `/model 3`, etc.). */
export declare function listPickerModelsFlat(): ModelEntry[];
/**
 * Plain-text model list (same layout as interactive pickModel), for non-TTY hosts
 * (e.g. VS Code webview) that only receive StreamEvents — not console.error.
 */
export declare function formatModelPickerListText(currentModel?: string): string;
/**
 * Show interactive model picker. Returns the selected model ID.
 * Falls back to text input if terminal doesn't support raw mode.
 */
export declare function pickModel(currentModel?: string): Promise<string | null>;
export {};
