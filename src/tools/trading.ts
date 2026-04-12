import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import type { SignalDetectedEvent } from '../events/types.js';
import { getPrice, getOHLCV, getTrending, getMarketOverview } from '../trading/data.js';
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
  action: 'price' | 'trending' | 'overview';
  ticker?: string;
}

async function executeMarket(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, ticker } = input as unknown as MarketInput;

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
      return { output: `Error: unknown action "${action}". Use: price, trending, overview`, isError: true };
  }
}

export const tradingMarketCapability: CapabilityHandler = {
  spec: {
    name: 'TradingMarket',
    description:
      'Get cryptocurrency market data: price lookup, trending coins, or market overview (top 20 by market cap).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['price', 'trending', 'overview'],
          description: 'What to fetch: price lookup, trending coins, or market overview',
        },
        ticker: {
          type: 'string',
          description: 'Cryptocurrency ticker (required for price action), e.g. "BTC"',
        },
      },
      required: ['action'],
    },
  },
  execute: executeMarket,
  concurrent: true,
};
