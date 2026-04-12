<div align="center">

<br>

<h1>
  <code>◆</code> &nbsp; Franklin &nbsp; <code>◆</code>
</h1>

<h3>The AI agent with a wallet.</h3>

<p>
  While others chat, Franklin spends.<br>
  One wallet. Every model. Every paid API. Pay per action in USDC.
</p>

<p>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/v/@blockrun/franklin.svg?style=flat-square&color=FFD700&label=npm" alt="npm"></a>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/dm/@blockrun/franklin.svg?style=flat-square&color=10B981&label=downloads" alt="downloads"></a>
  <a href="https://github.com/BlockRunAI/franklin/stargazers"><img src="https://img.shields.io/github/stars/BlockRunAI/franklin?style=flat-square&color=FFD700&label=stars" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square" alt="license"></a>
  <a href="https://github.com/BlockRunAI/franklin/actions"><img src="https://img.shields.io/github/actions/workflow/status/BlockRunAI/franklin/ci.yml?style=flat-square&label=ci" alt="ci"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/x402-native-10B981?style=flat-square" alt="x402"></a>
  <a href="https://t.me/blockrunAI"><img src="https://img.shields.io/badge/chat-telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="telegram"></a>
</p>

<p>
  <a href="#quick-start">Quick&nbsp;start</a> ·
  <a href="#what-franklin-can-do">What it does</a> ·
  <a href="#why-franklin">Why</a> ·
  <a href="#the-comparison">Compare</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

Every AI agent today writes text. `franklin` **spends money** — your USDC, from your wallet, on your behalf, under a hard budget cap — to actually get work done. One agent. 55+ models. Every paid API routed through the [x402](https://x402.org) micropayment protocol. No subscriptions. No API keys. No account. The wallet is your identity.

Built by the [BlockRun](https://blockrun.ai) team. Apache-2.0. TypeScript. Ships as one npm package.

---

## Quick start

```bash
# 1. Install
npm install -g @blockrun/franklin

# 2. Run (free — uses NVIDIA Nemotron & Qwen3 Coder out of the box)
franklin

# 3. (optional) Fund a wallet to unlock Claude, GPT, Gemini, Grok, + paid APIs
franklin setup base        # or: franklin setup solana
franklin balance           # show address + USDC balance
```

That's it. Zero signup, zero credit card, zero phone verification. Send **$5 of USDC** to the wallet and you've unlocked every frontier model and every paid tool in the BlockRun gateway.

---

## What Franklin can do

Franklin is **chat-first**. No CLI subcommands to memorize. Just type what you want.

### 📈 Trading signals

```text
> what's BTC looking like today?

  ✓ TradingSignal  BTC

  ## BTC Signal Report

  Price: $71,056 USD (+2.3% 24h)
  Market Cap: $1.42T
  24h Volume: $29.6B

  ### Technical Indicators (30d)
  - RSI(14): 53.2 — neutral
  - MACD: 339.21 / Signal: 280.45 — bullish crossover
  - Bollinger: within band (upper $73,773 / lower $64,545)
  - Volatility: 35.3% annualized — medium

> if I enter at 65000 with $1000, where should my stop be?

  Based on ATR(14) and support at $63,500:
  Entry: $65,000 · Stop: $63,200 (−2.8%) · Risk: $27.69
  Risk/reward to $70K target: 1:2.8 ✓
```

Live data from CoinGecko. RSI, MACD, Bollinger, volatility computed locally. No API key needed.

### 🎯 Social growth

```text
> find X posts about ai agent

  ✓ SearchX  "ai agent"

  Found 8 candidates:
  1. "Just tried 5 different AI coding agents..."  — @dev_sarah (2h)
     Product match: Franklin (score: 3)
  2. "Rate limits on Claude Code are killing me..." — @indie_max (5h)
     Product match: Franklin (score: 2)
  ...

> write a reply to #2 — mention that Franklin has no rate limits

  Draft:
  "Been there. I switched to an agent that routes across 55+ models
   with no rate limits — pays per action from a USDC wallet instead
   of a monthly sub. Night and day difference for long sessions."

> looks good, post it

  ✓ PostToX  Reply posted to x.com/indie_max/status/...
```

Search X, generate contextual replies, post with one confirmation. Uses Playwright for browser automation — no X API key, no OAuth, no $100/month developer account.

### 🛠 Code, research, anything

```text
> refactor src/auth.ts to use the new jwt helper, then run the tests

  ✓ Read   src/auth.ts                    $0.002
  ✓ Read   src/lib/jwt.ts                 $0.001
  ✓ Edit   src/auth.ts (-24 +31 lines)    $0.008
  ✓ Bash   npm test                       $0.000
    › 142 passing · 0 failing · 2.4s

  Done in 18s · $0.011
```

Every tool call is itemised. Every token is priced. When the wallet hits zero, Franklin stops. No overdraft, no surprise bill, no rate-limit wall at 3am.

---

## Why Franklin

<table>
<tr>
<td width="33%" valign="top">

### 💳 &nbsp;Pay per action

No subscriptions. No "Pro" tier. You fund a wallet once and Franklin spends atomically per API call via HTTP 402. Cheap models cost fractions of a cent. Frontier models cost what they cost. When the wallet is empty, Franklin stops.

</td>
<td width="33%" valign="top">

### 🔐 &nbsp;Wallet is identity

No email. No phone. No KYC. Your Base or Solana address is your account. Portable across machines — `franklin setup` imports an existing wallet in one command. Your sessions, your config, your money.

</td>
<td width="33%" valign="top">

### 🧠 &nbsp;55+ models, one interface

Claude Sonnet/Opus 4.6, GPT-5.4, Gemini 2.5 Pro, Grok 4, DeepSeek V3, GLM-5.1, Kimi, Minimax, plus NVIDIA's free tier. Switch mid-session with `/model`. Automatic fallback if one provider is down.

</td>
</tr>
</table>

---

## The comparison

|                                    | Claude Code    | Hermes        | OpenClaw       | **Franklin**          |
| ---------------------------------- | -------------- | ------------- | -------------- | --------------------- |
| Writes and edits code              | ✅             | ✅            | ✅             | ✅                    |
| Multi-model support                | ❌ Claude only | ✅ BYOK        | ✅ BYOK         | ✅ **55+ via 1 wallet** |
| Pricing model                      | Subscription   | BYOK          | BYOK           | **Pay per action**    |
| Identity                           | Account        | API keys      | API keys       | **Wallet**            |
| Start free, no signup              | ❌             | ⚠️ need keys   | ⚠️ need keys    | ✅                    |
| **Trading signals in chat**        | ❌             | ❌            | ❌             | ✅ live BTC/ETH/...   |
| **Social growth (search + reply)** | ❌             | ❌            | ❌             | ✅ X native           |
| **Image generation (DALL-E)**      | ❌             | ❌ BYOK       | ❌             | ✅ via x402           |
| Budget cap enforced on-chain       | ❌             | ❌            | ❌             | ✅                    |
| Plugin SDK                         | ❌             | ⚠️            | ✅             | ✅                    |

**Franklin is the first Autonomous Economic Agent** — an agent that takes a goal, decides what to spend on, and executes within a hard budget cap enforced by the wallet.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

**📈 Trading signals**
Ask "what's BTC looking like?" — Franklin fetches live price from CoinGecko, computes RSI/MACD/Bollinger/volatility, and synthesizes a signal. No API key needed.

**🎯 Social growth**
Ask "find X posts about my product" — Franklin searches X via browser automation, generates contextual replies, posts with your confirmation. No X API key. No OAuth.

**🧠 55+ models via one wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One URL, one wallet, automatic fallback.

**💳 x402 micropayments**
HTTP 402 native. Every tool call is a tiny signed transaction against your USDC balance. No escrow, no refund API, no subscription.

**🚦 Smart tier routing**
Free / cheap / premium per task. Franklin picks the best model per tier. Configurable defaults in `franklin config`.

**🔌 Plugin SDK**
Core is workflow-agnostic. Ship a new vertical without touching the agent loop. See [docs/plugin-sdk.md](docs/plugin-sdk.md).

</td>
<td width="50%" valign="top">

**🛠 16 built-in tools**
Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, ImageGen, AskUser, SubAgent, TradingSignal, TradingMarket, SearchX, PostToX.

**💾 Persistent sessions**
Every turn is streamed to disk with full metadata. Resume any session by ID. Survives crashes, reboots, context compaction.

**🔍 Full-text session search**
`franklin search "payment loop"` — tokenised search across every past session. No SQLite, no indexing daemon, just fast.

**📊 Cost insights**
`franklin insights` — daily spend sparklines, per-model breakdown, projections. Never wonder where the USDC went.

**⚡ Anthropic prompt caching**
Multi-turn Sonnet/Opus sessions use ephemeral cache breakpoints. Large input savings on long conversations.

**🔗 MCP auto-discovery**
Drop-in Model Context Protocol servers from `~/.blockrun/mcp.json`. Auto-discovers `blockrun-mcp` (markets, X) and `unbrowse` (any site to API).

</td>
</tr>
</table>

---

## Slash commands

| Command                          | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `/model [name]`                  | Interactive model picker (32 models), or switch directly |
| `/plan` / `/execute`             | Read-only planning mode / commit mode                |
| `/ultrathink <q>`                | Deep reasoning mode for hard problems                |
| `/compact`                       | Structured context compression (Goal/Progress/Next)  |
| `/search <q>`                    | Full-text search across past sessions                |
| `/history` / `/resume <id>`      | Session management                                   |
| `/commit` / `/push` / `/pr`      | Git workflow helpers                                 |
| `/review` / `/fix` / `/test`     | One-shot code review, bugfix, or test generation     |
| `/cost` / `/wallet`              | Session cost, wallet address & balance               |
| `/insights [--days N]`           | Rich usage analytics                                 |
| `/help`                          | Full command list                                    |

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  Franklin Agent                                              │
│  16 tools · Router · Session · Compaction · Plugin SDK        │
├──────────────────────────────────────────────────────────────┤
│  BlockRun Gateway                                            │
│  55+ LLMs · CoinGecko · Exa · DALL-E · (soon) Runway · Suno  │
├──────────────────────────────────────────────────────────────┤
│  x402 Micropayment Protocol                                  │
│  HTTP 402 · USDC on Base & Solana · on-chain budget cap      │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │ Your wallet │
                     │  (you own)  │
                     └─────────────┘
```

Every API call resolves to a signed micropayment against your wallet. You fund once; Franklin spends per task, priced by the upstream provider. No middlemen, no refund loop, no subscription renewal date.

---

## Project layout

```
src/
├── index.ts           CLI entry (franklin + runcode alias)
├── banner.ts          Ben Franklin portrait + FRANKLIN gradient text
├── agent/             Agent loop, LLM client, compaction, commands
├── tools/             16 built-in tools (Read/Write/Edit/Bash/Glob/Grep/
│                      WebFetch/WebSearch/Task/ImageGen/AskUser/SubAgent/
│                      TradingSignal/TradingMarket/SearchX/PostToX)
├── trading/           Market data (CoinGecko) + technical indicators
├── social/            X browser automation (Playwright) + reply engine
├── events/            Internal event bus (signal events, post events)
├── plugin-sdk/        Public plugin contract (Workflow/Plugin/Channel)
├── plugins/           Plugin registry + runner (plugin-agnostic)
├── session/           Persistent sessions + FTS search
├── stats/             Usage tracking + insights engine
├── ui/                Ink-based terminal UI
├── proxy/             Payment proxy for Claude Code compatibility
├── router/            Smart model tier routing (free/cheap/premium)
├── wallet/            Wallet management (Base + Solana)
├── mcp/               MCP server auto-discovery
└── commands/          CLI subcommands
```

---

## Free tier, for real

Start with **zero dollars**. Franklin defaults to free NVIDIA models (Nemotron 253B, Qwen3 Coder 480B) that need no wallet funding. Rate-limited to 60 requests/hour on the gateway, but genuinely free.

```bash
franklin --model nvidia/nemotron-ultra-253b
```

Only fund a wallet when you want Claude, GPT, Gemini, Grok, or paid tools like Exa, DALL-E, and CoinGecko Pro.

---

## Social automation (advanced)

Once you've tuned Franklin's reply style in chat, you can graduate to **automated batch mode**:

```bash
franklin social setup              # install Chromium, write default config
franklin social login x            # log in to X once (cookies persist)
franklin social config edit        # set handle, products, search queries
franklin social run                # dry-run — preview drafts
franklin social run --live         # actually post to X
franklin social stats              # posted / drafted / skipped / cost
```

The chat-based social tools (`SearchX`, `PostToX`) and the batch CLI (`franklin social run`) share the same engine. Chat first, automate later.

---

## Documentation

- [Plugin SDK guide](docs/plugin-sdk.md) — build your own workflow
- [Changelog](CHANGELOG.md) — every release explained
- [Roadmap](docs/ROADMAP.md) — what's coming next
- [Claude Code compatibility](docs/) — use Franklin as a payment proxy

---

## Community

- [Telegram](https://t.me/blockrunAI) — realtime help, bug reports, feature requests
- [@BlockRunAI](https://x.com/BlockRunAI) — release notes, demos
- [Issues](https://github.com/BlockRunAI/franklin/issues) — bugs and feature requests
- [Discussions](https://github.com/BlockRunAI/franklin/discussions) — ideas, Q&A, show & tell

---

## Development

```bash
git clone https://github.com/BlockRunAI/franklin.git
cd franklin
npm install
npm run build
npm test              # deterministic local tests — no API calls
npm run test:e2e      # live e2e tests — hits real models, needs wallet
node dist/index.js --help
```

**Contributing:** open an issue first to discuss meaningful changes. PRs welcome on bugs, docs, new models in pricing, and new tools.

---

## Star history

<a href="https://star-history.com/#BlockRunAI/franklin&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=BlockRunAI/franklin&type=Date&theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=BlockRunAI/franklin&type=Date">
    <img alt="Star history" src="https://api.star-history.com/svg?repos=BlockRunAI/franklin&type=Date">
  </picture>
</a>

---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<div align="center">

**Franklin runs your money.**<br>
<sub>Your wallet. Your agent. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>
