/**
 * Typed config for Franklin's trading subsystem.
 * Stored at ~/.blockrun/trading-config.json. Default written on first run.
 */
export interface TradingConfig {
    version: 1;
    watchlist: string[];
    signals: {
        rsi_oversold: number;
        rsi_overbought: number;
    };
    model_tier: 'free' | 'cheap' | 'premium';
}
export declare const CONFIG_PATH: string;
/**
 * Load config from disk. If missing, write defaults and return them.
 * Returns the parsed config or throws on malformed JSON.
 */
export declare function loadTradingConfig(): TradingConfig;
/**
 * Persist config back to disk.
 */
export declare function saveTradingConfig(cfg: TradingConfig): void;
