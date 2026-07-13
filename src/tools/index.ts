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
import { browserXCapability } from './browsex.js';
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
import { multiChainRpcCapability } from './rpc.js';
import { predictionMarketCapability } from './prediction.js';
import { polymarketBetCapability } from './polymarket-bet.js';
import { modalCapabilities } from './modal.js';
import { blockrunCapability } from './blockrun.js';
import { agentTalentCapability } from './agent-talent.js';
import { surfCapabilities } from './surf.js';
import { realFaceCapability } from './realface.js';
import {
  listPhoneNumbersCapability,
  buyPhoneNumberCapability,
  renewPhoneNumberCapability,
  releasePhoneNumberCapability,
  phoneLookupCapability,
  phoneFraudCheckCapability,
} from './phone.js';
import { voiceCallCapability, voiceStatusCapability } from './voice.js';
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
  browserXCapability,
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
  multiChainRpcCapability, // read-only JSON-RPC across 40+ chains ($0.002/call)
  predictionMarketCapability, // Polymarket / Kalshi / matching / smart money via Predexon (read-only research)
  polymarketBetCapability, // PolymarketBet — real-money betting execution: setup/fund/buy/sell/redeem/withdraw (CLOB V2)
  blockrunCapability, // Generic x402-paid gateway primitive — future partners + long-tail Surf paths
  agentTalentCapability, // Hire paid skills from the BlockRun agent marketplace (business.blockrun.ai)
  ...surfCapabilities, // SurfMarket / SurfChain / SurfSocial — endpoint-enum function tools (no path guessing, auto x402)
  // Phone & Voice — typed surface so the agent pattern-matches on the user
  // intent ("buy a number", "make a call") without needing to consult the
  // BlockRun primitive or the .well-known/x402 manifest. All wrap the same
  // /v1/phone/* and /v1/voice/* endpoints under the hood.
  listPhoneNumbersCapability,    // ListPhoneNumbers — $0.001
  buyPhoneNumberCapability,      // BuyPhoneNumber   — $5 / 30 days
  renewPhoneNumberCapability,    // RenewPhoneNumber — $5 / 30 days
  releasePhoneNumberCapability,  // ReleasePhoneNumber — free
  phoneLookupCapability,         // PhoneLookup      — $0.01
  phoneFraudCheckCapability,     // PhoneFraudCheck  — $0.05
  voiceCallCapability,           // VoiceCall        — $0.54 / call (Bland.ai)
  voiceStatusCapability,         // VoiceStatus      — free (poll)
  realFaceCapability,            // RealFace — init/status/enroll/list; $0.01 enroll → ta_xxx avatar for VideoGen
  // Modal GPU sandbox tools — registered but hidden by default (not in
  // CORE_TOOL_NAMES). Agent must `ActivateTool({names:["ModalCreate",...]})`
  // before they appear in its tool inventory. High-cost ($0.40/H100 create)
  // operations should not be in the default surface.
  ...modalCapabilities, // ModalCreate, ModalExec, ModalStatus, ModalTerminate
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

/**
 * "Franklin prediction mode" toolset.
 *
 * A deliberately tight, research-only capability set for forecasting a single
 * real-world event the way a careful bettor would: gather current facts, read
 * sources, check live prediction-market odds and a little market data — then
 * decide. Everything else (filesystem, shell, media generation, swaps/trade
 * execution, phone/voice, GPU sandbox, posting) is intentionally excluded:
 * a forecaster looks things up, it does not act on the world or spend beyond
 * the cheap read calls these tools make.
 *
 * Used by the `franklin predict` command and reusable by any headless caller
 * (e.g. franklin.bet) that wants a grounded prediction.
 */
export const predictionCapabilities: CapabilityHandler[] = [
  webSearchCapability,        // web_search — current news & facts
  webFetchCapability,         // webfetch — read a specific source URL
  exaSearchCapability,        // exa search — higher-quality web research
  exaAnswerCapability,        // exa answer — direct sourced answers
  exaReadUrlsCapability,      // exa read — pull full text of found URLs
  searchXCapability,          // search X — live sentiment / breaking signal
  predictionMarketCapability, // search_prediction_markets — live implied odds
  tradingSignalCapability,    // market signal/indicators (for market-type events)
  tradingMarketCapability,    // market snapshot data
  defiLlamaPriceCapability,   // token price lookup (crypto-type events)
];

export { createSubAgentCapability } from './subagent.js';
