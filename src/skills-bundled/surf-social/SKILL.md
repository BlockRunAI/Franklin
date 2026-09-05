---
name: surf-social
description: Crypto-Twitter / KOL intelligence via Surf — project mindshare time series, smart-follower history (high-signal accounts), social ranking, tweet + replies fetch, user profile / followers / posts / replies. Use when the user asks about KOL sentiment, project attention, smart money commentary, narrative momentum, or specific Twitter handles.
triggers:
  - "kol sentiment"
  - "mindshare"
  - "smart followers"
  - "crypto twitter"
  - "ct sentiment"
  - "twitter analysis"
  - "social ranking"
  - "tweet"
  - "twitter handle"
argument-hint: <project, handle, or question>
cost-receipt: true
---

**Active billing:** {{billing_context}}


You are running inside Franklin on **{{wallet_chain}}**. Use the `BlockRun` tool to call Surf's social endpoints. This is the canonical source for crypto-Twitter signal — mindshare scoring, KOL identification, and reply-graph analysis.

**Account mode:** do not switch chains or fund a wallet for API errors. Check the key or account credits instead.

**Chain note (wallet mode only):** Surf currently settles x402 payments on **Base** only. If the user's active chain is `solana` and you hit a payment error, ask them to `/chain base` before retrying. The social data itself is chain-agnostic.

## How to use

`BlockRun({ path: "/v1/surf/<endpoint>", method: "GET", params: { ... } })`. All endpoints below are GET.

## Endpoint catalog

### Project-level signal (Tier 2, $0.0075)
| Path | Required params | What it returns |
|---|---|---|
| `/v1/surf/social/detail` | — | Aggregated social analytics for a project |
| `/v1/surf/social/ranking` | — | Mindshare ranking across projects |
| `/v1/surf/social/smart-followers/history` | — | Smart-follower count history (high-signal accounts only) |
| `/v1/surf/social/mindshare` | `q`, `interval` | Mindshare time series for a project (`q` = ticker or name, `interval` = `1d` / `7d` / `30d`) |

### Tweet-level (Tier 1, $0.0075)
| Path | Required params | What it returns |
|---|---|---|
| `/v1/surf/social/tweets` | `ids` (comma-sep) | Fetch tweets by ID |
| `/v1/surf/social/tweet/replies` | `tweet_id` | Replies to a specific tweet |

### User-level (Tier 1, $0.0075)
| Path | Required params | What it returns |
|---|---|---|
| `/v1/surf/social/user` | `handle` | Twitter user profile |
| `/v1/surf/social/user/followers` | `handle` | Followers list |
| `/v1/surf/social/user/following` | `handle` | Following list |
| `/v1/surf/social/user/posts` | `handle` | User posts |
| `/v1/surf/social/user/replies` | `handle` | User replies |

## How to choose

- **"What's the market saying about $X?"** → `social/mindshare` with `q: "X", interval: "7d"` ($0.0075). Read the trend, not the absolute number.
- **"Who's the smart money following $X?"** → `social/smart-followers/history` ($0.0075). Compare growth rate to baseline.
- **"Top projects by attention right now"** → `social/ranking` ($0.0075).
- **"Is @handle a real player?"** → `social/user` then `social/user/followers` (look at follower-to-following ratio + which smart accounts follow them).
- **"What did @handle say recently?"** → `social/user/posts` ($0.0075 each).
- **"Show me the reply storm under tweet X"** → `social/tweet/replies` ($0.0075).

## When NOT to use this skill

- Generic Twitter scraping or non-crypto sentiment → use `BrowserX` or a web search tool. Surf is curated for crypto-relevant accounts.
- Real-time tweet streaming → not supported; this is historical / batch reads.

## Cost discipline

- User-level reads are cheap ($0.0075). Five to ten handles cost $0.0375–$0.075 before any payment-rail fees; keep the batch within the user's budget.
- Project-level signal is $0.0075/call. One mindshare + one smart-followers call is usually enough to answer "is this thing real?".
- Always include the cost in your summary.

## The user asked

$ARGUMENTS

Pricing reference: the account gateway currently lists Surf and Predexon service calls at $0.0075 per request. Confirm the current service quote before a batch; account Activity is the receipt, and wallet x402 quotes can also include payment-rail fees.
