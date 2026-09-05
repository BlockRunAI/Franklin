---
name: surf-market
description: Crypto market data via Surf — prices, futures, ETFs, options, fear/greed, technical and on-chain indicators, token DEX flows, news, project profiles, VC fund holdings. Use when the user asks about market conditions, ranking tokens, futures positioning, technical signals, options skew, news context, or VC/fund intelligence.
triggers:
  - "market overview"
  - "fear greed"
  - "futures"
  - "etf flow"
  - "options skew"
  - "tokenomics"
  - "rsi"
  - "macd"
  - "liquidations"
  - "vc fund"
  - "token ranking"
argument-hint: <symbol or question>
cost-receipt: true
---

**Active billing:** {{billing_context}}


You are running inside Franklin on **{{wallet_chain}}**. Crypto market data lives behind the `BlockRun` tool, which uses the configured account API key or x402 wallet for each call. Pick the cheapest endpoint that answers the question.

**Account mode:** do not switch chains or fund a wallet for API errors. Check the key or account credits instead.

**Chain note (wallet mode only):** Surf currently settles x402 payments on **Base** only (treasury is `0x058a59…` on Base). If the user's active chain is `solana` and you hit a payment error, tell them to switch with `/chain base` before retrying — the request itself works, the wallet just needs to be on Base to sign the payment.

## How to use

Call `BlockRun({ path: "/v1/surf/<endpoint>", method: "GET", params: { ... } })`. All endpoints below are GET unless noted. Required params must be supplied or you'll get a 400 (no charge).

## Endpoint catalog

### Exchange (CEX intelligence)
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/exchange/markets` | $0.0075 | — | Trading pairs catalog across major CEXes |
| `/v1/surf/exchange/price` | $0.0075 | `pair` | Ticker price for a pair |
| `/v1/surf/exchange/perp` | $0.0075 | `pair` | Perpetual contract snapshot |
| `/v1/surf/exchange/depth` | $0.0075 | `pair` | Order book depth |
| `/v1/surf/exchange/klines` | $0.0075 | `pair` | OHLCV candlesticks |
| `/v1/surf/exchange/funding-history` | $0.0075 | `pair` | Perp funding rate history |
| `/v1/surf/exchange/long-short-ratio` | $0.0075 | `pair` | Long/short positioning |

### Market (broad-market intelligence)
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/market/ranking` | $0.0075 | — | Token ranking (market cap, volume, change) |
| `/v1/surf/market/fear-greed` | $0.0075 | — | Fear & Greed index history |
| `/v1/surf/market/futures` | $0.0075 | — | Futures market overview |
| `/v1/surf/market/price` | $0.0075 | `symbol` | Token price history |
| `/v1/surf/market/etf` | $0.0075 | `symbol` | Spot ETF flow history (BTC, ETH) |
| `/v1/surf/market/options` | $0.0075 | `symbol` | Options skew / IV / volume |
| `/v1/surf/market/liquidation/exchange-list` | $0.0075 | — | Liquidations by exchange |
| `/v1/surf/market/liquidation/order` | $0.0075 | — | Large liquidation orders |
| `/v1/surf/market/liquidation/chart` | $0.0075 | `symbol` | Liquidation chart over time |
| `/v1/surf/market/onchain-indicator` | $0.0075 | `symbol`, `metric` | NUPL, SOPR, MVRV, Puell, NVT |
| `/v1/surf/market/price-indicator` | $0.0075 | `indicator`, `symbol` | RSI, MACD, Bollinger, EMA |

### News
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/news/feed` | $0.0075 | — | AI-curated crypto news feed |
| `/v1/surf/news/detail` | $0.0075 | `id` | Full article by ID |

### Project (DeFi protocols + project profiles)
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/project/detail` | $0.0075 | — | Aggregated project profile (token + DeFi + social) |
| `/v1/surf/project/defi/metrics` | $0.0075 | `metric` | Per-protocol DeFi metrics (TVL, fees, revenue) |
| `/v1/surf/project/defi/ranking` | $0.0075 | `metric` | DeFi protocol ranking |

### Token (on-chain analytics)
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/token/tokenomics` | $0.0075 | — | Unlock schedule + vesting |
| `/v1/surf/token/dex-trades` | $0.0075 | `address` | DEX trade history |

### Fund (VC + treasury intelligence)
| Path | Price/call | Required params | What it returns |
|---|---|---|---|
| `/v1/surf/fund/detail` | $0.0075 | — | VC fund profile |
| `/v1/surf/fund/portfolio` | $0.0075 | — | VC fund portfolio holdings |
| `/v1/surf/fund/ranking` | $0.0075 | `metric` | Top VC funds ranking |

## How to choose

- **"How's the market?"** → `market/fear-greed` + `market/ranking` (both $0.0075). Cheap snapshot.
- **"What's BTC doing?"** → `market/price` for history, `exchange/price` for spot tick, `market/etf` for institutional flow.
- **"Show me liquidations."** → `market/liquidation/chart` for time series, `market/liquidation/order` for whale events.
- **"Technical signal on ETH"** → `market/price-indicator` with `indicator: "RSI"` (or MACD, BBANDS, EMA).
- **"On-chain health"** → `market/onchain-indicator` with `metric: "NUPL"` etc.
- **"Who holds this token / where is it traded?"** → `token/tokenomics` for supply schedule, `token/dex-trades` for flow.
- **"What VCs back this project?"** → `fund/portfolio` (filter by project).

## Cost discipline

- All tiers currently cost $0.0075/call. Estimate the total before a batch.
- Tier 2 ($0.0075) endpoints carry depth, history, or fraud-signal data — use when that data is needed.
- Avoid speculative multi-endpoint scans. Pick the right endpoint for the question; if unsure, ask the user one clarifying question first.
- Report the cost on every call in your summary: "Pulled fear/greed history ($0.0075). Index sits at 62 (greed)."

## The user asked

$ARGUMENTS

Pricing reference: the account gateway currently lists Surf and Predexon service calls at $0.0075 per request. Confirm the current service quote before a batch; account Activity is the receipt, and wallet x402 quotes can also include payment-rail fees.
