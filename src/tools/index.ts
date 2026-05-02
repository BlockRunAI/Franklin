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
import { detachCapability } from './detach.js';
import { createImageGenCapability } from './imagegen.js';
import { createVideoGenCapability } from './videogen.js';
import { createMusicGenCapability } from './musicgen.js';
import { memoryRecallCapability } from './memory.js';
import { exaSearchCapability, exaAnswerCapability, exaReadUrlsCapability } from './exa.js';
import { askUserCapability } from './askuser.js';
import { tradingSignalCapability, tradingMarketCapability } from './trading.js';
import { searchXCapability } from './searchx.js';
import { postToXCapability } from './posttox.js';
import { moaCapability } from './moa.js';
import { webhookPostCapability } from './webhook.js';
import { walletCapability } from './wallet.js';
import { jupiterQuoteCapability, jupiterSwapCapability } from './jupiter.js';
import { base0xQuoteCapability, base0xSwapCapability } from './zerox-base.js';
import { base0xGaslessSwapCapability } from './zerox-gasless.js';
import {
  defiLlamaProtocolsCapability,
  defiLlamaProtocolCapability,
  defiLlamaChainsCapability,
  defiLlamaYieldsCapability,
  defiLlamaPriceCapability,
} from './defillama.js';
import { createTradingCapabilities } from './trading-execute.js';
import { Portfolio } from '../trading/portfolio.js';
import { RiskEngine } from '../trading/risk.js';
import { LiveExchange } from '../trading/live-exchange.js';
import { TradingEngine } from '../trading/engine.js';
import { loadPortfolio, savePortfolio } from '../trading/store.js';
import { TradeLog } from '../trading/trade-log.js';
import { getPrice as cgGetPrice } from '../trading/data.js';
import { createContentCapabilities } from './content-execute.js';
import { ContentLibrary } from '../content/library.js';
import { loadLibrary as loadContentLibrary, saveLibrary as saveContentLibrary } from '../content/store.js';

// ─── Default Trading Engine ────────────────────────────────────────────────
// Paper trading defaults: $1000 starting bankroll, $400 per-position cap
// (2.5 positions fully loaded), $900 total exposure cap (keep 10% cash buffer).
// Live prices from CoinGecko; simulated fills at 10 bps. Portfolio persists
// to ~/.blockrun/portfolio.json across sessions — that persistence is the
// whole point of this vertical (stateless coding agents can't carry trading
// state between runs).
const DEFAULT_PORTFOLIO_PATH = path.join(os.homedir(), '.blockrun', 'portfolio.json');
const DEFAULT_TRADE_LOG_PATH = path.join(os.homedir(), '.blockrun', 'trades.jsonl');
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
  const tradeLog = new TradeLog(DEFAULT_TRADE_LOG_PATH);
  return createTradingCapabilities({
    engine,
    riskConfig: DEFAULT_RISK_CONFIG,
    tradeLog,
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

// ─── Default Content Library ──────────────────────────────────────────────
// Durable content projects at ~/.blockrun/content.json. Like the portfolio,
// this is persistent cross-session state — something stateless coding agents
// structurally can't offer.
const DEFAULT_CONTENT_PATH = path.join(os.homedir(), '.blockrun', 'content.json');

// Build a single ContentLibrary instance so both the Content capabilities and
// the content-aware ImageGen capability share state and persistence.
const defaultContentLibrary =
  loadContentLibrary(DEFAULT_CONTENT_PATH) ?? new ContentLibrary();

const persistContentLibrary = () => {
  try {
    saveContentLibrary(defaultContentLibrary, DEFAULT_CONTENT_PATH);
  } catch {
    // Best-effort — in-memory library remains authoritative.
  }
};

const defaultContentCapabilities = createContentCapabilities({
  library: defaultContentLibrary,
  onStateChange: persistContentLibrary,
});

const defaultImageGenCapability = createImageGenCapability({
  library: defaultContentLibrary,
  onContentChange: persistContentLibrary,
});

const defaultVideoGenCapability = createVideoGenCapability({
  library: defaultContentLibrary,
  onContentChange: persistContentLibrary,
});

const defaultMusicGenCapability = createMusicGenCapability({
  library: defaultContentLibrary,
  onContentChange: persistContentLibrary,
});

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
  detachCapability,
  defaultImageGenCapability,
  defaultVideoGenCapability,
  defaultMusicGenCapability,
  memoryRecallCapability,
  exaSearchCapability,
  exaAnswerCapability,
  exaReadUrlsCapability,
  askUserCapability,
  tradingSignalCapability,
  tradingMarketCapability,
  ...defaultTradingCapabilities, // TradingPortfolio, TradingOpenPosition, TradingClosePosition, TradingHistory
  ...defaultContentCapabilities, // ContentCreate, ContentAddAsset, ContentShow, ContentList
  searchXCapability,
  postToXCapability,
  moaCapability,
  webhookPostCapability,
  walletCapability,
  jupiterQuoteCapability,
  jupiterSwapCapability,
  base0xQuoteCapability,
  base0xSwapCapability,
  base0xGaslessSwapCapability,
  defiLlamaProtocolsCapability,
  defiLlamaProtocolCapability,
  defiLlamaChainsCapability,
  defiLlamaYieldsCapability,
  defiLlamaPriceCapability,
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
  detachCapability,
};

export { createSubAgentCapability } from './subagent.js';
