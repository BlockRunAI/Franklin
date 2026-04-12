/**
 * Typed config for Franklin's trading subsystem.
 * Stored at ~/.blockrun/trading-config.json. Default written on first run.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export interface TradingConfig {
  version: 1;
  watchlist: string[];      // e.g. ['BTC', 'ETH', 'SOL']
  signals: {
    rsi_oversold: number;   // default 30
    rsi_overbought: number; // default 70
  };
  model_tier: 'free' | 'cheap' | 'premium';  // default 'cheap'
}

export const CONFIG_PATH = path.join(os.homedir(), '.blockrun', 'trading-config.json');

const DEFAULT_CONFIG: TradingConfig = {
  version: 1,
  watchlist: ['BTC', 'ETH', 'SOL'],
  signals: {
    rsi_oversold: 30,
    rsi_overbought: 70,
  },
  model_tier: 'cheap',
};

/**
 * Load config from disk. If missing, write defaults and return them.
 * Returns the parsed config or throws on malformed JSON.
 */
export function loadTradingConfig(): TradingConfig {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as TradingConfig;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported trading config version ${parsed.version} (expected 1)`);
  }
  return parsed;
}

/**
 * Persist config back to disk.
 */
export function saveTradingConfig(cfg: TradingConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
