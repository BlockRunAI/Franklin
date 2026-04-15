<div align="center">

<br>

<img src="assets/terminal-banner.png" alt="Franklin terminal" width="680">

<br><br>

<h3>The AI agent with a wallet.</h3>

<p>
  Other agents write code. Franklin writes code <em>and spends money</em> to get things done.<br>
  One wallet. Every model. Every paid API. Pay only for outcomes — not subscriptions.
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
  <a href="#yopo">YOPO</a> ·
  <a href="#a-new-category">Category</a> ·
  <a href="#what-franklin-can-execute">What&nbsp;it&nbsp;does</a> ·
  <a href="#smart-router">Smart&nbsp;Router</a> ·
  <a href="#the-comparison">vs.&nbsp;Claude&nbsp;Code</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

Claude Code writes code. Cursor writes code. Franklin writes code **and spends money to get the job done**. It holds a USDC wallet, picks the best model per task from 55+ providers, purchases trading data, generates images, pays for web search — all autonomously. You state an outcome and set a budget. Franklin decides what to call, what to pay for, and when to stop. Every paid action routes through the [x402](https://x402.org) micropayment protocol and settles against your own wallet. No subscriptions. No API keys. No account. The wallet is the identity.

Built by the [BlockRun](https://blockrun.ai) team. Apache-2.0. TypeScript. Ships as one npm package.

> **YOPO — You Only Pay Outcome**
>
> Not a subscription (pay for access). Not a generic pay-per-call (pay for trying).
> You pay only for the work Franklin delivers. Provider cost + 5%, settled per action
> in USDC. No monthly fees. No rate limits. No overdraft.

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

## YOPO

**You Only Pay Outcome.** This is Franklin's pricing model, and it is the opposite of almost every other AI product you use.

|                         | You pay for...                               | Result                               |
| ----------------------- | -------------------------------------------- | ------------------------------------ |
| Subscription (ChatGPT Plus, Claude Max, Cursor Pro) | Access. Paid whether you use it or not. | $20–200/month, rate-limited.         |
| Pay-per-call (OpenAI API, etc.) | Every attempt — even failed ones.    | Hidden cost from retries, dead ends. |
| **Franklin (YOPO)**     | **The outcome.** Each signed micropayment.  | **Provider cost + 5%. No more.**     |

Three consequences fall out of this:

1. **No subscriptions.** Use Franklin for $0.50 one week and $50 the next — you pay for compute actually consumed, nothing more.
2. **No rate limits.** Subscriptions throttle you when you need AI most. YOPO has no artificial caps — if you have USDC, you have access.
3. **No overdraft.** The wallet balance IS the hard limit. When it's empty, Franklin stops. No surprise bills, no 3 a.m. rate-limit walls.

Concretely — $1 in USDC gets you roughly:
- ~400K GPT-4o input tokens
- ~7M DeepSeek tokens
- ~13M Gemini Flash tokens
- ~20 DALL-E 3 images
- ~40 Exa neural web searches
- Unlimited NVIDIA GPT-OSS (free tier, no wallet needed)

---

## A new category

> **Economic Agent**
>
> Software that can hold a wallet, price its own actions, spend toward an outcome, and stop at a hard budget cap.

Most AI products fit into one of three buckets: they answer questions, write code, or automate a fixed workflow. None of them can spend money.

Franklin can. It combines **purchasing power** (it pays for models, tools, and APIs), **budget awareness** (cost is part of the loop, not an afterthought), **cross-vertical execution** (code, trading, research, marketing, ops), and **hard stopping conditions** (wallet balance is a real constraint, not a suggestion).

That is why Franklin is an economic agent, not just a task agent.

---

## What Franklin can execute

Franklin is **chat-first**. You do not wire a DAG, configure six API keys, or commit to one model vendor. You state an outcome. Franklin decides what to read, search, fetch, call, and pay for.

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

Live data from CoinGecko. RSI, MACD, Bollinger, and volatility computed locally. No API key needed.

### 🎨 Image generation

```text
> generate a logo for my AI startup — minimalist, dark background

  ✓ ImageGen  "minimalist AI startup logo, dark background..."
  Saved: generated-logo-1713052800.png (1024x1024)
```

Generates images via DALL-E / GPT Image directly from the CLI. Paid from your wallet — no OpenAI API key needed.

### 🎯 Social growth (with setup)

After running `franklin social setup && franklin social login x`, Franklin can search X, draft replies, and post with your confirmation — no X API key or developer account needed.

### 🔎 Research, code, anything with a budget

```text
> compare the top 5 AI agent pricing models, summarize the patterns, and save a note for me

  ✓ WebSearch  ai agent pricing models
  ✓ WebFetch   5 articles
  ✓ Write      notes/agent-pricing.md

  Summary:
  - Most agents hide pricing behind monthly seats
  - Usage-based products win with power users and teams
  - Wallet-based billing is still basically empty whitespace
```

```text
> refactor src/auth.ts to use the new jwt helper, then run the tests

  ✓ Read   src/auth.ts                    $0.002
  ✓ Read   src/lib/jwt.ts                 $0.001
  ✓ Edit   src/auth.ts (-24 +31 lines)    $0.008
  ✓ Bash   npm test                       $0.000
    › 142 passing · 0 failing · 2.4s

  Done in 18s · $0.011
```

Code is still first-class. It is just **one workload**, not the category.

Every tool call is itemized. Every token is priced. When the wallet hits zero, Franklin stops. No overdraft, no surprise bill, no rate-limit wall at 3 a.m. — this is YOPO in practice.

---

## Smart Router

**55+ models. One decision. Zero guesswork.**

You don't pick models. Franklin picks for you.

The Smart Router classifies every request — coding, trading, reasoning, research — and selects the model with the best quality-to-cost ratio. Trained on **2M+ real requests** from the BlockRun gateway, continuously updated.

```text
> refactor this auth module to use JWT

  CODING kimi-k2.5  ·  12.4K in / 2.1K out  ·  $0.0023  saved 84%

> what's the BTC outlook for the week?

  TRADING grok-4-1-fast-reasoning  ·  8.2K in / 1.8K out  ·  $0.0008  saved 95%

> prove that this algorithm is O(n log n)

  REASONING claude-sonnet-4.6  ·  15.1K in / 3.4K out  ·  $0.0312
```

Every response shows which model was chosen, why, and how much you saved vs. always using the most expensive option.

**Four profiles:**

| Profile | Strategy | Use case |
|---------|----------|----------|
| `auto` | Best quality-to-cost ratio | Default — smart spend |
| `eco` | Cheapest model with decent quality | Budget-conscious |
| `premium` | Highest quality regardless of cost | Mission-critical |
| `free` | Free NVIDIA models only | Zero wallet balance |

**Per-session breakdown** — run `/cost` to see exactly where your USDC went:

```text
Session Cost: $0.0847 (23 requests)
  gemini-2.5-flash       $0.0012   14 req   CODING
  kimi-k2.5              $0.0423    6 req   CODING
  claude-sonnet-4.6      $0.0412    3 req   REASONING
```

The router also learns from **your** usage. If you keep retrying a model for coding tasks, Franklin adapts and picks a better one next time. Your router gets smarter the more you use it.

---

## Why Franklin

<table>
<tr>
<td width="33%" valign="top">

### 💳 &nbsp;AI is utility, not SaaS

You don't subscribe to electricity, you pay for what you use. Franklin brings the same model to AI. YOPO settlement means Franklin never bills you for access, only for outcomes. No monthly fees, no rate limits, no overdraft.

</td>
<td width="33%" valign="top">

### 🧠 &nbsp;Multi-model is the future

No single model is best at everything. Claude writes better code, Gemini handles longer context, DeepSeek costs 20x less for simple tasks. The Smart Router routes every request to the optimal model in <1ms — up to 89% savings vs. always using Opus.

</td>
<td width="33%" valign="top">

### 🔐 &nbsp;Wallet is identity

No email. No phone. No KYC. Your Base or Solana address is your account — portable, permissionless, global. API keys require US banking and account approval. A wallet requires only USDC.

</td>
</tr>
</table>

---

## The comparison

|                                        | Claude Code     | Cursor           | Chatbots         | **Franklin**                    |
| -------------------------------------- | --------------- | ---------------- | ---------------- | ------------------------------- |
| Writes code                            | ✅              | ✅               | ⚠️                | ✅                              |
| **Spends money for you**               | ❌              | ❌               | ❌               | ✅ **USDC wallet, x402**        |
| **Buys data + APIs + images + search** | ❌              | ❌               | ❌               | ✅ **55+ APIs, one wallet**     |
| Picks best model per task              | ❌ Anthropic only | ❌ plan-tied    | ❌               | ✅ **Smart Router, 55+ models** |
| Pricing model                          | Subscription    | Subscription     | Subscription     | **YOPO** — per outcome, USDC    |
| Monthly fee                            | $20–$200        | $20–$40          | $20+             | **$0**                          |
| Rate-limited                           | Yes             | Yes              | Yes              | No — limited only by wallet     |
| Works when provider goes down          | ❌              | ❌               | ❌               | ✅ **routes to another**        |
| Identity                               | Anthropic account | Cursor account | Account / email | ✅ **wallet, no signup**        |
| Start free, no KYC                     | ❌              | ❌               | ❌               | ✅                              |
| Source                                 | Closed          | Closed           | Closed           | **Apache 2.0, local-first**     |

**Franklin is the economic agent category in one sentence:** software with a wallet that can spend toward a result.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

**💼 Wallet-native economic execution**
Franklin can decide what is worth paying for, route the call, sign the micropayment, and keep going until the goal is done or the budget is exhausted.

**📈 Trading signals**
Ask "what's BTC looking like?" — Franklin fetches live price data, computes RSI/MACD/Bollinger/volatility, and synthesizes a signal.

**🎨 AI image generation**
Ask "generate a logo" — Franklin calls DALL-E / GPT Image, saves the result locally, paid from your wallet.

**🧠 55+ models via one wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One wallet, one interface, automatic fallback.

**💳 x402 micropayments (YOPO)**
HTTP 402 native. Every paid action is a signed USDC micropayment via EIP-712 — non-custodial, your keys never leave your machine. YOPO: you pay only for outcomes.

**🧠 Learned model router**
Trained on 2M+ real requests. Classifies your task and picks the best model from 55+ LLMs. Four profiles (auto/eco/premium/free). Adapts to your usage over time.

</td>
<td width="50%" valign="top">

**🛠 16 built-in tools**
Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, ImageGen, AskUser, SubAgent, TradingSignal, TradingMarket, SearchX, PostToX.

**💾 Persistent sessions**
Every turn is streamed to disk with metadata. Resume any session by ID. Survives crashes, reboots, and compaction.

**🔍 Full-text session search**
`franklin search "payment loop"` from the CLI, or `/session-search "payment loop"` in chat.

**📊 Cost insights**
`franklin insights` shows spend breakdowns, trends, and projections. Never wonder where the USDC went.

**⚡ Anthropic prompt caching**
Multi-turn Sonnet/Opus sessions use ephemeral cache breakpoints to reduce input spend on long conversations.

**🔌 Plugin SDK + MCP**
Core is workflow-agnostic. Add new verticals without touching the loop. Discover external tools automatically through MCP.

</td>
</tr>
</table>

---

## Slash commands

| Command                          | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `/model [name]`                  | Interactive model picker, or switch directly         |
| `/plan` / `/execute`             | Read-only planning mode / execution mode             |
| `/ultrathink <q>`                | Deep reasoning mode for hard problems                |
| `/compact`                       | Structured context compression                       |
| `/search <q>`                    | Search the codebase                                  |
| `/session-search <q>`            | Search past sessions                                 |
| `/history` / `/resume [id]`      | Inspect or restore conversation state                |
| `/commit` / `/push` / `/pr`      | Git workflow helpers                                 |
| `/review` / `/fix` / `/test`     | One-shot code review, bugfix, or test runs           |
| `/cost` / `/wallet`              | Session cost, wallet address, and balance            |
| `/insights [--days N]`           | Rich usage analytics                                 |
| `/help`                          | Full command list                                    |

---

## How it works

```text
┌──────────────────────────────────────────────────────────────┐
│  Franklin Runtime                                            │
│  Intent → Smart Router → Tool Use → Spend Control → Result   │
├──────────────────────────────────────────────────────────────┤
│  Learned Router                                              │
│  2M+ requests · 55+ models · category detection · Elo scores │
├──────────────────────────────────────────────────────────────┤
│  Agent Loop                                                  │
│  16 tools · Sessions · Compaction · Pricing · Plugin SDK     │
├──────────────────────────────────────────────────────────────┤
│  BlockRun Gateway                                            │
│  55+ LLMs · CoinGecko · Search · Image APIs · paid services  │
├──────────────────────────────────────────────────────────────┤
│  x402 Micropayment Protocol                                  │
│  HTTP 402 · USDC on Base & Solana · signed payment payloads  │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │ Your wallet │
                     │  (you own)  │
                     └─────────────┘
```

The loop is simple:
1. You state an outcome.
2. Franklin chooses what to read, call, and pay for.
3. The payment settles against your wallet.
4. Franklin reports the result and the spend.

That economic loop is the product.

---

## Project layout

```text
src/
├── index.ts           CLI entry (franklin + runcode alias)
├── banner.ts          Ben Franklin portrait + FRANKLIN gradient text
├── agent/             Agent loop, LLM client, compaction, commands
├── tools/             16 built-in tools (Read/Write/Edit/Bash/Glob/Grep/
│                      WebFetch/WebSearch/Task/ImageGen/AskUser/SubAgent/
│                      TradingSignal/TradingMarket/SearchX/PostToX)
├── trading/           Market data (CoinGecko) + technical indicators
├── social/            X browser automation (Playwright) + reply engine
├── events/            Internal event bus (signals, posting, workflow events)
├── plugin-sdk/        Public plugin contract (Workflow/Plugin/Channel)
├── plugins/           Plugin registry + runner (plugin-agnostic)
├── session/           Persistent sessions + search
├── stats/             Usage tracking + insights engine
├── ui/                Ink-based terminal UI
├── proxy/             Payment proxy for external tools
├── router/            Learned model router (2M+ requests, Elo scoring)
├── wallet/            Wallet management (Base + Solana)
├── mcp/               MCP server auto-discovery
└── commands/          CLI subcommands
```

---

## Free tier, for real

Start with **zero dollars**. Franklin defaults to free NVIDIA models that need no wallet funding.

```bash
franklin --model nvidia/nemotron-ultra-253b
```

When you fund the wallet, Franklin gets more purchasing power: Claude, GPT, Gemini, Grok, and paid tools like Exa, DALL-E, and CoinGecko Pro.

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

- [Plugin SDK guide](docs/plugin-sdk.md) — build your own workflow vertical
- [Changelog](CHANGELOG.md) — every release explained
- [Roadmap](docs/ROADMAP.md) — what's coming next
- [Proxy mode](docs/) — use Franklin as a payment proxy for Anthropic-compatible CLI agents

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

**The AI agent with a wallet.**<br>
<sub>YOPO — You Only Pay Outcome. Your wallet. Your budget. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>
