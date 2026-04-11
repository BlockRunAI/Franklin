/**
 * Typed config for Franklin's social subsystem.
 * Stored at ~/.blockrun/social-config.json. Default written on first run.
 */
export interface ProductConfig {
    name: string;
    description: string;
    trigger_keywords: string[];
}
export interface SocialConfig {
    version: 1;
    handle: string;
    products: ProductConfig[];
    x: {
        search_queries: string[];
        daily_target: number;
        min_delay_seconds: number;
        max_length: number;
        login_detection: string;
    };
    reply_style: {
        rules: string[];
        model_tier: 'free' | 'cheap' | 'premium';
    };
}
export declare const CONFIG_PATH: string;
/**
 * Load config from disk. If missing, write defaults and return them.
 * Returns the parsed config or throws on malformed JSON.
 */
export declare function loadConfig(): SocialConfig;
/**
 * Persist config back to disk.
 */
export declare function saveConfig(cfg: SocialConfig): void;
/**
 * Whether the config is "ready" to run — has a handle and at least one
 * product with keywords.
 */
export declare function isConfigReady(cfg: SocialConfig): {
    ready: boolean;
    reason?: string;
};
