import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import type { SignalDetectedEvent } from '../events/types.js';
import {
  getPrice,
  getOHLCV,
  getTrending,
  getMarketOverview,
  getFxPrice,
  getCommodityPrice,
  getStockPrice,
} from '../trading/data.js';
import type { MarketCode } from '../trading/providers/standard-models.js';

const SUPPORTED_STOCK_MARKETS: MarketCode[] = [
  'us', 'hk', 'jp', 'kr', 'gb', 'de', 'fr', 'nl', 'ie', 'lu', 'cn', 'ca',
];
import { rsi, macd, bollingerBands, volatility } from '../trading/metrics.js';
import { bus } from '../events/bus.js';
import { makeEvent } from '../events/types.js';

function formatUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

// ── TradingSignal ─────────────────────────────────────────────────────────

interface SignalInput {
  ticker: string;
  days?: number;
}

async function executeSignal(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { ticker, days = 30 } = input as unknown as SignalInput;

  if (!ticker) {
    return { output: 'Error: ticker is required', isError: true };
  }

  const upper = ticker.toUpperCase();
  const [priceResult, ohlcvResult] = await Promise.all([
    getPrice(upper),
    getOHLCV(upper, days),
  ]);

  if (typeof priceResult === 'string') {
    return { output: `Error fetching price: ${priceResult}`, isError: true };
  }
  if (typeof ohlcvResult === 'string') {
    return { output: `Error fetching OHLCV: ${ohlcvResult}`, isError: true };
  }

  const { closes } = ohlcvResult;
  const rsiResult = rsi(closes);
  const macdResult = macd(closes);
  const bbResult = bollingerBands(closes);
  const volResult = volatility(closes);

  // Determine overall direction from indicators
  let bullish = 0;
  let bearish = 0;
  if (rsiResult.interpretation === 'oversold') bullish++;
  if (rsiResult.interpretation === 'overbought') bearish++;
  if (macdResult.trend === 'bullish') bullish++;
  if (macdResult.trend === 'bearish') bearish++;
  if (bbResult.position === 'below') bullish++;
  if (bbResult.position === 'above') bearish++;

  const direction: 'bullish' | 'bearish' | 'neutral' =
    bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';
  const confidence = Math.max(bullish, bearish) / 3;

  bus.emit(makeEvent<SignalDetectedEvent>({
    type: 'signal.detected',
    source: 'trading',
    data: {
      asset: upper,
      direction,
      confidence,
      indicators: {
        rsi: rsiResult.value,
        macd: macdResult.macd,
        volatility: volResult.annualized,
      },
      summary: `${upper} ${direction} (confidence ${(confidence * 100).toFixed(0)}%)`,
    },
  }));

  const { price, change24h, marketCap, volume24h } = priceResult;
  const last5 = closes.slice(-5).map(c => c.toFixed(2)).join(', ');

  const output = [
    `## ${upper} Signal Report`,
    '',
    `**Price:** $${price.toLocaleString()} USD (${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}% 24h)`,
    `**Market Cap:** ${formatUsd(marketCap)}`,
    `**24h Volume:** ${formatUsd(volume24h)}`,
    '',
    `### Technical Indicators (${days}d lookback)`,
    `- **RSI(14):** ${rsiResult.value.toFixed(1)} — ${rsiResult.interpretation}`,
    `- **MACD:** ${macdResult.macd.toFixed(4)} / Signal: ${macdResult.signal.toFixed(4)} / Histogram: ${macdResult.histogram.toFixed(4)} — ${macdResult.trend}`,
    `- **Bollinger:** Upper ${bbResult.upper.toFixed(2)} / Middle ${bbResult.middle.toFixed(2)} / Lower ${bbResult.lower.toFixed(2)} — Price ${bbResult.position}`,
    `- **Volatility:** ${(volResult.annualized * 100).toFixed(1)}% annualized — ${volResult.interpretation}`,
    '',
    `### Raw Data`,
    `Closes (last 5): ${last5}`,
  ].join('\n');

  return { output };
}

export const tradingSignalCapability: CapabilityHandler = {
  spec: {
    name: 'TradingSignal',
    description:
      'Get current price, technical indicators (RSI, MACD, Bollinger Bands, volatility), and a signal summary for a cryptocurrency. Returns raw data for the agent to analyze and interpret.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'Cryptocurrency ticker, e.g. "BTC", "ETH"' },
        days: { type: 'number', description: 'Lookback period for indicators. Default: 30' },
      },
      required: ['ticker'],
    },
  },
  execute: executeSignal,
  concurrent: true,
};

// ── TradingMarket ─────────────────────────────────────────────────────────

interface MarketInput {
  action: 'price' | 'trending' | 'overview' | 'fxPrice' | 'commodityPrice' | 'stockPrice';
  ticker?: string;
  market?: MarketCode;
}

function formatPriceLine(label: string, priceUsd: number, change24hPct: number, opts: { fractionDigits?: number; showChange?: boolean } = {}): string {
  const digits = opts.fractionDigits ?? 2;
  const priceStr = `$${priceUsd.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  if (opts.showChange === false || !Number.isFinite(change24hPct)) {
    return `${label}: ${priceStr}`;
  }
  const sign = change24hPct > 0 ? '+' : '';
  return `${label}: ${priceStr} (${sign}${change24hPct.toFixed(2)}% 24h)`;
}

async function executeMarket(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, ticker, market } = input as unknown as MarketInput;

  if (!action) {
    return { output: 'Error: action is required', isError: true };
  }

  switch (action) {
    case 'price': {
      if (!ticker) {
        return { output: 'Error: ticker is required for price action', isError: true };
      }
      const result = await getPrice(ticker.toUpperCase());
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      const { price, change24h, marketCap, volume24h } = result;
      return {
        output: `${ticker.toUpperCase()}: $${price.toLocaleString()} (${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}% 24h), Market Cap: ${formatUsd(marketCap)}, Volume: ${formatUsd(volume24h)}`,
      };
    }

    case 'fxPrice': {
      if (!ticker) {
        return { output: 'Error: ticker is required (e.g. "EUR-USD")', isError: true };
      }
      const result = await getFxPrice(ticker);
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      return {
        output: formatPriceLine(ticker.toUpperCase(), result.price, result.change24h, { fractionDigits: 4 }) +
          ' · source: BlockRun Gateway / Pyth (free)',
      };
    }

    case 'commodityPrice': {
      if (!ticker) {
        return { output: 'Error: ticker is required (e.g. "XAU-USD" for gold)', isError: true };
      }
      const result = await getCommodityPrice(ticker);
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      return {
        output: formatPriceLine(ticker.toUpperCase(), result.price, result.change24h, { fractionDigits: 2 }) +
          ' · source: BlockRun Gateway / Pyth (free)',
      };
    }

    case 'stockPrice': {
      if (!ticker) {
        return { output: 'Error: ticker is required (e.g. "AAPL" on market "us")', isError: true };
      }
      if (!market) {
        return {
          output: `Error: market code is required for stockPrice. Supported: ${SUPPORTED_STOCK_MARKETS.join(', ')}`,
          isError: true,
        };
      }
      if (!SUPPORTED_STOCK_MARKETS.includes(market)) {
        return {
          output: `Error: unsupported market "${market}". Supported: ${SUPPORTED_STOCK_MARKETS.join(', ')}`,
          isError: true,
        };
      }
      const result = await getStockPrice(ticker, market);
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      const tickerLabel = `${ticker.toUpperCase()} (${market})`;
      return {
        output: formatPriceLine(tickerLabel, result.price, result.change24h, { fractionDigits: 2 }) +
          ' · source: BlockRun Gateway / Pyth · $0.001 paid from wallet',
      };
    }

    case 'trending': {
      const result = await getTrending();
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      const lines = result.map(
        (c, i) => `${i + 1}. ${c.name} (${c.symbol.toUpperCase()})${c.marketCapRank ? ` — #${c.marketCapRank}` : ''}`,
      );
      return { output: `Trending coins:\n${lines.join('\n')}` };
    }

    case 'overview': {
      const result = await getMarketOverview();
      if (typeof result === 'string') {
        return { output: `Error: ${result}`, isError: true };
      }
      const header = 'Rank | Coin | Price | 24h Change | Market Cap';
      const sep = '-----|------|-------|------------|----------';
      const rows = result.map(
        (c, i) =>
          `${i + 1} | ${c.name} (${c.symbol.toUpperCase()}) | $${c.price.toLocaleString()} | ${c.change24h > 0 ? '+' : ''}${c.change24h.toFixed(2)}% | ${formatUsd(c.marketCap)}`,
      );
      return { output: `Top 20 by Market Cap:\n${header}\n${sep}\n${rows.join('\n')}` };
    }

    default:
      return {
        output: `Error: unknown action "${action}". Use: price, trending, overview, fxPrice, commodityPrice, stockPrice`,
        isError: true,
      };
  }
}

export const tradingMarketCapability: CapabilityHandler = {
  spec: {
    name: 'TradingMarket',
    description:
      'Get market data across asset classes. Actions: ' +
      '`price` (crypto spot via CoinGecko, free), ' +
      '`trending` (top trending coins), ' +
      '`overview` (top 20 by market cap), ' +
      '`fxPrice` (FX pair like EUR-USD, BlockRun Gateway/Pyth, free), ' +
      '`commodityPrice` (XAU-USD for gold, XAG-USD for silver, etc., free), ' +
      '`stockPrice` (any of 1,746 tickers across us/hk/jp/kr/gb/de/fr/nl/ie/lu/cn/ca, BlockRun Gateway/Pyth, $0.001 per call paid from the agent wallet). ' +
      'Prefer stockPrice for any equity question — CRCL, AAPL, 7203.JP, 0005.HK, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['price', 'trending', 'overview', 'fxPrice', 'commodityPrice', 'stockPrice'],
          description: 'What to fetch. See tool description for cost + source per action.',
        },
        ticker: {
          type: 'string',
          description:
            'Ticker. Crypto: "BTC". FX: "EUR-USD". Commodity: "XAU-USD" (gold). Stock: "AAPL", "CRCL", "7203" (Toyota on jp), "0005" (HSBC on hk). Required for all price actions.',
        },
        market: {
          type: 'string',
          enum: ['us', 'hk', 'jp', 'kr', 'gb', 'de', 'fr', 'nl', 'ie', 'lu', 'cn', 'ca'],
          description: 'Stock exchange market code. Required when action="stockPrice". Ignored for other actions.',
        },
      },
      required: ['action'],
    },
  },
  execute: executeMarket,
  concurrent: true,
};
