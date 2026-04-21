# Example 02 — Paper-trading daily review

## What this shows

Franklin running a full trading review on a watchlist: pull market data,
run technical indicators, check the persistent portfolio, and decide
whether each signal is worth acting on. Exercises:

- `ActivateTool` — the agent pulls trading tools into its active set
- `TradingMarket` — trending / overview / price lookup (free CoinGecko)
- `TradingSignal` — RSI + MACD + Bollinger + volatility per ticker (free)
- `TradingPortfolio` — current cash, positions, unrealized/realized P&L
- `TradingOpenPosition` / `TradingClosePosition` — paper-trade execution
- `TradingHistory` — cross-session trade log

## Expected wallet cost

**$0.** Trading data runs through the free CoinGecko tier; paper
trades never hit a real exchange. The point of this example is to
demonstrate the flow you'd run daily without burning wallet balance —
when you're ready to graduate to live trading through the Gateway, the
same prompt works with a paid execution provider.

## The prompt

```
Run my daily crypto review. Watchlist: BTC, ETH, SOL.

1. Activate the trading tools: TradingMarket, TradingSignal,
   TradingPortfolio, TradingOpenPosition, TradingClosePosition,
   TradingHistory.
2. Use TradingPortfolio to read my current state.
3. For each ticker in the watchlist, call TradingSignal with a 30-day
   lookback.
4. For each signal report:
   - If the signal is bullish and I don't already hold the position,
     open a $50 notional paper position at the current price.
   - If I already hold the position and the signal has flipped to
     bearish, close the full position.
   - Otherwise, hold.
5. After all trades are placed, call TradingPortfolio again and
   summarize: net change in cash, positions opened, positions closed,
   total unrealized P&L.
6. Call TradingHistory with window="7d" and show the one-week
   realized P&L line.

Do not ask me for confirmation — execute the plan. Stop after the
summary.
```

## What Franklin should do

1. Activate trading tools via `ActivateTool`.
2. Call `TradingPortfolio` once.
3. Call `TradingSignal` three times (BTC, ETH, SOL) — these can run
   concurrently; Franklin's streaming executor fires them in parallel.
4. For each signal, branch:
   - bullish + no existing position → `TradingOpenPosition`
   - bearish + existing position → `TradingClosePosition`
   - otherwise → no tool call
5. Call `TradingPortfolio` a second time.
6. Call `TradingHistory` once.

## Why this works without paid data

The same Fetcher interface that powers the CoinGecko provider today is
the extension point for future paid providers (Binance, CoinMarketCap,
on-chain). Swap the `price` and `ohlcv` fetchers in
`src/trading/providers/registry.ts` and this exact prompt runs against a
higher-grade data source without changing a word of the user-facing
flow.
