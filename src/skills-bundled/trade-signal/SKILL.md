---
name: trade-signal
description: Open a paper-trade position with a structured rationale — direction, price target, stop, time horizon, conviction, evidence, tags, thesis. The journal scores the trade on discipline (verifiability, evidence, specificity, novelty, review), not P&L, and surfaces the trend in TradingPortfolio. Use any time the user wants to open a position with intent, not vibes.
triggers:
  - "open a trade"
  - "buy"
  - "long"
  - "short"
  - "take a position"
  - "trade signal"
  - "trade idea"
argument-hint: <symbol or thesis>
cost-receipt: false
---

You are running inside Franklin on **{{wallet_chain}}**. This is paper trading — fills are simulated against a live mark — so the value is the discipline, not the dollars. Every trade entered through this skill carries a rationale that the journal scorer evaluates on five dimensions:

| Dimension | Weight | Earned by |
|---|---|---|
| verifiability | 30% | direction + priceTarget both set |
| evidence | 25% | thesis ≥ 200 chars + 3 evidence items + indicator keywords (RSI/MACD/funding/etc.) |
| specificity | 20% | symbol + ≥ 2 tags |
| novelty | 15% | not the 4th identical revenge-trade this week |
| review | 10% | post-trade note left at close |

Total is a 0–5 score, persisted with the trade and averaged across the last 10 entries in the portfolio footer.

## Workflow

1. **Read the request.** The user's argument is below under "The user said". If it's a complete thesis (symbol + direction + reasoning + numbers), proceed to step 3. If anything's vague, ask **one** clarifying question — the cheapest call you have on the wallet is "tell me more before I burn $0.001 on a market quote."

2. **Optional context** — if you don't already have a recent quote, call `TradingMarket({ ticker, assetClass })` (free for crypto, $0.001 for stocks). For thesis support beyond price, the `/surf-market`, `/surf-chain`, or `/surf-social` skills can be invoked, each documenting their own endpoint costs.

3. **Construct the rationale.** Fill as many fields as the request justifies:

   - `direction`: `"long"` for buys (paper trading is long-only today).
   - `priceTarget`: where you expect to take profit (USD).
   - `stopLoss`: where you'll exit if wrong (USD).
   - `timeHorizon`: `"1h"`, `"1d"`, `"1w"`, `"1m"`, `"3m"` — match the trade type.
   - `conviction`: 1 (low, "small probe") → 5 (high, "size up").
   - `evidence`: 2–4 items. Indicator readings, news links, on-chain stats, comparable trades.
   - `tags`: 2+ categories — `"momentum"`, `"mean-reversion"`, `"macro"`, `"event"`, `"sentiment"`, etc.
   - `thesis`: a paragraph (target 200+ chars) connecting the evidence to the trade. Mention at least one named indicator if you cite one.

4. **Size with discipline.** Default per-position cap is $400, total exposure $900 (see TradingPortfolio for current utilization). Don't size beyond what conviction justifies — a conviction-2 trade at the cap is a discipline red flag.

5. **Fire the trade** by calling `TradingOpenPosition`:

```
TradingOpenPosition({
  symbol: "<TICKER>",
  qty: <quantity>,
  priceUsd: <fill price>,
  rationale: {
    direction: "long",
    priceTarget: <number>,
    stopLoss: <number>,
    timeHorizon: "<period>",
    conviction: <1-5>,
    evidence: ["<source 1>", "<source 2>", ...],
    tags: ["<tag 1>", "<tag 2>"],
    thesis: "<200+ char paragraph>"
  }
})
```

6. **Surface the score.** The tool result shows the fill. Then call `TradingPortfolio` once and quote the new discipline score back to the user — "Trade booked. Journal score on this entry: 4.2/5. Discipline trend over the last 10 trades: 3.6/5 (evidence flagged below 3 — keep citing indicators)."

7. **Stop.** Don't fan out to multiple trades unless the user explicitly asks for portfolio construction. One disciplined trade beats five vibes-trades.

## Anti-patterns

- Firing `TradingOpenPosition` without a rationale block. The journal still records the trade but it scores ~1/5 on discipline. Don't do this.
- Inventing evidence. If the user says "feels like a top" and you can't find supporting data, write that into the thesis verbatim and let the score reflect it. The journal is a mirror, not a press release.
- Trading the same symbol + direction four times in a week. The novelty penalty fires for a reason — that's revenge trading.

## The user said

$ARGUMENTS
