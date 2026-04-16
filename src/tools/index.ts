/**
 * Tool registry — exports all available capabilities for the agent.
 */

import type { CapabilityHandler } from '../agent/types.js';

import os from 'node:os';
import path from 'node:path';

import { readCapability, clearSessionState as clearReadSessionState } from './read.js';
import { writeCapability } from './write.js';
import { editCapability } from './edit.js';
import { bashCapability, clearSessionState as clearBashSessionState } from './bash.js';
import { globCapability } from './glob.js';
import { grepCapability } from './grep.js';
import { webFetchCapability, clearSessionState as clearWebFetchSessionState } from './webfetch.js';
import { webSearchCapability } from './websearch.js';
import { taskCapability } from './task.js';
import { imageGenCapability } from './imagegen.js';
import { askUserCapability } from './askuser.js';
import { tradingSignalCapability, tradingMarketCapability } from './trading.js';
import { searchXCapability } from './searchx.js';
import { postToXCapability } from './posttox.js';
import { moaCapability } from './moa.js';
import { createTradingCapabilities } from './trading-execute.js';
import { Portfolio } from '../trading/portfolio.js';
import { RiskEngine } from '../trading/risk.js';
import { LiveExchange } from '../trading/live-exchange.js';
import { TradingEngine } from '../trading/engine.js';
import { loadPortfolio, savePortfolio } from '../trading/store.js';
import { getPrice as cgGetPrice } from '../trading/data.js';

// ─── Default Trading Engine ────────────────────────────────────────────────
// Paper trading defaults: $1000 starting bankroll, $400 per-position cap
// (2.5 positions fully loaded), $900 total exposure cap (keep 10% cash buffer).
// Live prices from CoinGecko; simulated fills at 10 bps. Portfolio persists
// to ~/.blockrun/portfolio.json across sessions — that persistence is the
// whole point of this vertical (Claude Code / Cursor cannot carry trading
// state between runs).
const DEFAULT_PORTFOLIO_PATH = path.join(os.homedir(), '.blockrun', 'portfolio.json');
const DEFAULT_STARTING_CASH_USD = 1_000;
const DEFAULT_RISK_CONFIG = { maxPositionUsd: 400, maxTotalExposureUsd: 900 };
const DEFAULT_FEE_BPS = 10;

function buildDefaultTradingCapabilities() {
  const portfolio =
    loadPortfolio(DEFAULT_PORTFOLIO_PATH) ??
    new Portfolio({ startingCashUsd: DEFAULT_STARTING_CASH_USD });
  const risk = new RiskEngine(DEFAULT_RISK_CONFIG);
  const exchange = new LiveExchange({
    pricing: { getPrice: cgGetPrice },
    feeBps: DEFAULT_FEE_BPS,
  });
  const engine = new TradingEngine({ portfolio, risk, exchange });
  return createTradingCapabilities({
    engine,
    riskConfig: DEFAULT_RISK_CONFIG,
    onStateChange: () => {
      try {
        savePortfolio(portfolio, DEFAULT_PORTFOLIO_PATH);
      } catch {
        // Persistence best-effort — never block a trade on disk failure.
      }
    },
  });
}

const defaultTradingCapabilities = buildDefaultTradingCapabilities();

/**
 * Reset module-level tool state that would otherwise leak between sessions
 * when the same process runs `interactiveSession()` more than once (library
 * callers, tests, planned daemon mode). Safe to call before every session.
 */
export function resetToolSessionState(): void {
  clearReadSessionState();
  clearWebFetchSessionState();
  clearBashSessionState();
}

/** All capabilities available to the Franklin agent (excluding sub-agent, which needs config). */
export const allCapabilities: CapabilityHandler[] = [
  readCapability,
  writeCapability,
  editCapability,
  bashCapability,
  globCapability,
  grepCapability,
  webFetchCapability,
  webSearchCapability,
  taskCapability,
  imageGenCapability,
  askUserCapability,
  tradingSignalCapability,
  tradingMarketCapability,
  ...defaultTradingCapabilities, // TradingPortfolio, TradingOpenPosition, TradingClosePosition
  searchXCapability,
  postToXCapability,
  moaCapability,
];

export {
  readCapability,
  writeCapability,
  editCapability,
  bashCapability,
  globCapability,
  grepCapability,
  webFetchCapability,
  webSearchCapability,
  taskCapability,
};

export { createSubAgentCapability } from './subagent.js';
