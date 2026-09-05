<div align="center">

<br>

<img src="assets/terminal-banner.png" alt="Franklin Agent terminal" width="680">

<br><br>

<h1>Franklin Agent</h1>
<h3>The AI agent with a budget.</h3>

<p>
  Franklin Agent uses account credits or your USDC wallet to get work done —<br>
  trading, research, and autonomous tasks with real budgets, real guardrails, real outcomes.<br>
  One interface for models and paid APIs. Pay for usage as you go.
</p>

<p>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/v/@blockrun/franklin.svg?style=flat-square&color=FFD700&label=npm" alt="npm"></a>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/dm/@blockrun/franklin.svg?style=flat-square&color=10B981&label=downloads" alt="downloads"></a>
  <a href="https://github.com/BlockRunAI/Franklin/stargazers"><img src="https://img.shields.io/github/stars/BlockRunAI/Franklin?style=flat-square&color=FFD700&label=stars" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/x402-native-10B981?style=flat-square" alt="x402"></a>
  <a href="https://t.me/blockrunAI"><img src="https://img.shields.io/badge/chat-telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="telegram"></a>
</p>

<p>
  <a href="#quick-start">Quick&nbsp;start</a> ·
  <a href="#franklin-desktop-beta">Desktop</a> ·
  <a href="#yopo">YOPO</a> ·
  <a href="#a-new-category">Category</a> ·
  <a href="#what-franklin-can-execute">What&nbsp;it&nbsp;does</a> ·
  <a href="#smart-router">Smart&nbsp;Router</a> ·
  <a href="#the-comparison">Comparison</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

Franklin Agent is an **autonomous economic agent** — an AI that uses account credits or a USDC wallet to get real work done, with **trading as its flagship arena**. It buys live market data, proposes trade plans you approve before a cent moves, pursues long-running goals across sessions, keeps a wallet-bound trading journal, and picks the best model per task from 55+ providers. You state an outcome and set a budget. Franklin Agent decides what to call, what to pay for, and when to stop. Access models, media, search and data with a BlockRun account API key, or use [x402](https://x402.org) USDC payments on Solana or Base. Actual on-chain trades still use your transaction wallet.

Built by the [BlockRun](https://blockrun.ai) team. Apache-2.0. TypeScript. Ships as one npm package.

> **YOPO — You Only Pay Outcome**
>
> Model and tool calls are billed by usage through account credits or x402 USDC payments.
> Rates depend on the service and your account. Account credit limits, provider limits,
> and rate limits apply; completing your overall task is not a billing guarantee.

---

## Account API key

Until this integration is released on npm, build the API-enabled source checkout:

```bash
npm ci
npm run build
export BLOCKRUN_API_KEY="brk_live_..."
node dist/index.js start
```

Use the CLI command below after installing a release containing this integration.

Register at [user.blockrun.ai](https://user.blockrun.ai), create an
[API key](https://user.blockrun.ai/dashboard/keys), and add
[credits](https://user.blockrun.ai/dashboard/credits).

```bash
export BLOCKRUN_API_KEY="brk_live_..."
franklin start
# Or: franklin proxy / franklin serve
```

The account endpoint defaults to `https://api.blockrun.ai/v1`; optionally set
`BLOCKRUN_API_BASE_URL`. API mode covers the agent and its subagents, proxy,
media generation/polling, search and gateway data tools, subject to gateway availability. It does not create a
payment wallet. `franklin balance`, the Wallet tool, and desktop/panel account
status point to the account portal. Keys are never returned by status endpoints.
HTTP 402 asks you to top up account credits and never switches to wallet payment.

Local cost totals and `--max-spend` use estimates in API mode; account usage in
the portal is authoritative. Wallet-signed cloud sync and wallet-owned asset
listings require wallet mode; local sessions remain available. Trading and
marketplace wallet signatures still require a separate transaction wallet.
Unset `BLOCKRUN_API_KEY` and restart Franklin to return to wallet billing. New wallet users default
to Solana; existing chain choices and Base-only wallets are preserved.

## Quick start

> **Release status:** As of September 4, 2026, npm `@blockrun/franklin@3.43.1` does not include this account API integration. The API instructions in this README apply to this source checkout; the global npm installation needs a release containing these changes.

> **Requires Node.js 20.19+ (Node 22 LTS recommended).** Check with `node -v`. Older Node crashes at startup with `ERR_REQUIRE_ESM`.

```bash
# 1. Install
npm install -g @blockrun/franklin

# 2. Run (free — uses NVIDIA Nemotron & Qwen3 Coder out of the box)
franklin

# 3. (optional) Fund a wallet to unlock Sonnet, Opus, GPT, Gemini, Grok, + paid APIs
franklin setup solana      # preferred for new wallets; or: franklin setup base
franklin balance           # show address + USDC balance
```

For wallet mode, no BlockRun signup is required: fund the wallet with USDC to use paid models and tools. For account mode, register at [user.blockrun.ai](https://user.blockrun.ai), add credits, and launch Franklin with `BLOCKRUN_API_KEY`. Prices and availability depend on the service.

**No global install? Just run it directly** — no permissions, no `-g`:

```bash
npx @blockrun/franklin
```

### Install troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `npm error EACCES … mkdir '/usr/local/lib/node_modules'` | Your global npm folder is owned by root (common when Node was installed from the macOS `.pkg`). | Don't use `sudo`. Either run `npx @blockrun/franklin` (no global install needed), or switch to a user-owned Node via a version manager — see below. |
| `Error [ERR_REQUIRE_ESM] … rpc-websockets … require() of ES Module … uuid` | Node is older than 20.19. Franklin's Solana deps need the `require(esm)` support added in Node 20.19.0. | Upgrade to Node 20.19+ or 22 LTS (see below). This is the #1 cause of a crash on first run. |
| `npm warn EBADENGINE … required: { node: '>=20.x' }` | Node is older than 20.19. | Upgrade to Node 20.19+ or 22 LTS. The warning alone is harmless, but on old Node the run will also crash — upgrade. |

The clean, permanent fix for both is a **user-owned Node** so global installs never touch root-owned system folders:

```bash
# nvm (https://github.com/nvm-sh/nvm)
nvm install 22 && nvm use 22
npm install -g @blockrun/franklin

# or fnm (https://github.com/Schniz/fnm)
fnm install 22 && fnm use 22
npm install -g @blockrun/franklin
```

### Prefer a GUI? Try Franklin for VS Code

[![Franklin for VS Code — Beta is here](assets/franklin-vscode-banner.png)](https://marketplace.visualstudio.com/items?itemName=blockrun.franklin-vscode)

The same agent ships as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=blockrun.franklin-vscode) — chat panel, model picker, wallet balance, image / video generation, inline diff cards — using account API billing or the wallet configured for the CLI.

```
VS Code → Extensions  (Cmd+Shift+X / Ctrl+Shift+X)
        → search "Franklin" → Install
        → click the Franklin icon in the Activity Bar
```

Free models work immediately. Paid models and media require account credits or a funded wallet, plus availability of the requested service. The CLI and the extension share the same `~/.blockrun/` config and session history, so jumping between terminal and VS Code is seamless.

### Franklin Desktop (Beta)

Franklin Desktop brings the real Franklin agent into a native workspace for macOS
and Windows. It uses the same local wallet, models, tools, and session runtime as
the CLI, with a visual chat, conversation history, gallery, wallet, tools, skills,
and CLI panels.

| Platform | Current beta package |
| -------- | -------------------- |
| macOS (Apple silicon) | Unsigned `.dmg` test build |
| Windows (x64) | Unsigned `.exe` test build |

> **Beta distribution:** signed public downloads and automatic updates are not
> live yet. Maintainers can download the short-lived unsigned installers from
> [Desktop CI](https://github.com/BlockRunAI/Franklin/actions/workflows/desktop-ci.yml).
> Public signed builds will appear on the
> [Franklin releases page](https://github.com/BlockRunAI/Franklin/releases).

Desktop is local-first: it opens in `Documents/Franklin`, keeps session history
local by default, and asks before an agent accesses files outside the active
workspace. External files are not blocked; each access requires explicit approval.
Shell commands also require approval in the current beta.

The stable beta currently runs the Franklin agent. Team Mode and Studio adapters
for additional agent CLIs are being developed separately and are not included in
this release. See the [Desktop guide](apps/desktop/README.md) for development and
packaging instructions.

---

## YOPO

**You Only Pay Outcome.** This is Franklin Agent's pricing model, and it is the opposite of almost every other AI product you use.

|                         | You pay for...                               | Result                               |
| ----------------------- | -------------------------------------------- | ------------------------------------ |
| AI subscription       | Access. Paid whether you use it or not. | $20–200/month, rate-limited.         |
| Pay-per-call (OpenAI API, etc.) | Every attempt — even failed ones.    | Hidden cost from retries, dead ends. |
| **Franklin Agent (YOPO)** | Model and tool usage, charged to account credits or an x402 wallet. | Service-specific pricing and account settings. |

Three consequences fall out of this:

1. **No subscriptions.** Use Franklin for $0.50 one week and $50 the next — you pay for compute actually consumed, nothing more.
2. **Pay as you go.** Account and provider rate limits still apply. On HTTP 429, respect `Retry-After` and reduce concurrency.
3. **Separate balances.** API calls use prepaid account credits; x402 calls use the selected wallet. An exhausted account returns a credit error and does not fall back to charging your wallet.

Concretely — $1 in USDC gets you roughly:
- ~400K GPT-4o input tokens
- ~7M DeepSeek tokens
- ~13M Gemini Flash tokens
- ~20 DALL-E 3 images
- ~40 Exa neural web searches
- Unlimited agent-tested NVIDIA free tier (Qwen3 Coder + Llama 4 Maverick, no wallet needed)

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

### 🛡️ Trades only move on YOUR approval

Real-money trades (Jupiter, 0x, Polymarket) are hard-gated behind a **trade plan**: the agent proposes a structured plan — venue, asset, size, slippage, stop condition, rationale, total spend — and nothing executes until you approve it. Approved budgets draw down per trade and expire in 15 minutes. This holds in every permission mode, `--trust` included. Add your own guardrails as [lifecycle hooks](docs/examples/hooks/) — daily spend caps, token blacklists, spend ledgers — that veto actions before money moves.

### 🎯 Autonomous goals with adversarial verification

```text
> /goal research the top 3 x402-compatible data APIs and produce a comparison
```

Franklin plans the objective, works it across turns on its own, and — when it claims completion — a panel of **adversarial reviewers audits the evidence and refutes anything unsupported**. Bounded by a turn cap, a verification-round cap, and your `--max-spend`. Esc pauses at any time. Pair with `/loop 1h check funding rates` (durable scheduler) and the `Monitor` tool (live feeds delivered at turn boundaries) for always-on market coverage.

### 🧠 A memory that follows your wallet

Every trade journals itself: thesis on open, P&L on close, written to a **wallet-keyed trading journal** (`~/.blockrun/memory/trading-*/`) that any session can recall — "what was my SOL thesis?" just works, from any directory. Session learnings capture with `/flush`, consolidate with `/dream`, and inject automatically at session start.

### 🕹️ Mission control for your fleet

`franklin serve` + `franklin panel` → the **Agents** tab: dispatch one agent per strategy or market, watch them stream live, reply to any of them, and approve their trade plans and permission requests — all from one browser page. Sessions started in a terminal show up too.

### 🎨 Image generation

```text
> generate a logo for my AI startup — minimalist, dark background

  ✓ ImageGen  "minimalist AI startup logo, dark background..."
  Saved: generated-logo-1713052800.png (1024x1024)
```

Generates images via DALL-E / GPT Image directly from the CLI, billed to account credits or your wallet. No separate OpenAI API key is needed.

### 📱 Remote control via Telegram

Run `franklin telegram` on an always-on machine (set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_ID`) and drive Franklin from your phone. Owner-locked, session-resumable across restarts, slash commands (`/new`, `/balance`, `/status`). Trading, content, dev work — all reachable from a Telegram chat.

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

Local cost views help track a session. In account mode, check Activity for authoritative charges; local estimates may differ, especially for media and service calls. Wallet and account balances remain separate.

---

## Smart Router

**<!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models. One decision. Zero guesswork.**

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

**Per-session breakdown** — run `/cost` for local usage estimates; use account Activity for billed API usage:

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

Franklin charges for model and tool usage through account credits or x402 payments. Account and provider limits apply. Check the service price and your account settings before a large run.

</td>
<td width="33%" valign="top">

### 🧠 &nbsp;Multi-model is the future

No single model is best at everything. Sonnet writes better code, Gemini handles longer context, DeepSeek costs 20x less for simple tasks. The Smart Router routes every request to the optimal model in <1ms — <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->% cheaper than pinning Claude Opus 5 for every request.

</td>
<td width="33%" valign="top">

### 🔐 &nbsp;Wallet is identity

Choose an account API key, or wallet authentication on Solana or Base. Register and create account keys at [user.blockrun.ai](https://user.blockrun.ai).

</td>
</tr>
</table>

---

## The comparison

|                                        | Coding agents    | Editor IDEs      | Chatbots         | **Franklin**                    |
| -------------------------------------- | ---------------- | ---------------- | ---------------- | ------------------------------- |
| Writes code                            | ✅               | ✅               | ⚠️                | ✅                              |
| **Spends money for you**               | ❌               | ❌               | ❌               | ✅ **Account credits or USDC wallet**        |
| **Buys data + APIs + images + search** | ❌               | ❌               | ❌               | ✅ **Paid APIs through one interface**     |
| Picks best model per task              | ❌ single-vendor | ❌ plan-tied    | ❌               | ✅ **Smart Router, <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models** |
| Pricing model                          | Subscription     | Subscription     | Subscription     | Usage-based account credits or x402 USDC    |
| Monthly fee                            | $20–$200         | $20–$40          | $20+             | **$0**                          |
| Rate-limited                           | Yes              | Yes              | Yes              | Account and provider limits apply     |
| Works when provider goes down          | ❌               | ❌               | ❌               | ✅ **routes to another**        |
| Identity                               | Vendor account   | Vendor account   | Account / email  | ✅ **Account login or wallet**        |
| Start free, no KYC                     | ❌               | ❌               | ❌               | ✅                              |
| Source                                 | Closed           | Closed           | Closed           | **Apache 2.0, local-first**     |

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
Ask "generate a logo" — Franklin calls DALL-E / GPT Image, saves the result locally, billed to account credits or your wallet.

**🧠 <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models via one account key or wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One account key or wallet, one interface, automatic model fallback.

**💳 x402 micropayments (YOPO)**
Account mode sends a Bearer API key to the account gateway and charges credits. Wallet mode signs x402 USDC payments locally on Solana or Base; private keys remain local. Model fallback keeps the selected billing mode.

**🧠 Learned model router**
Trained on 2M+ real requests. Classifies your task and picks the best model from <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> LLMs. Four profiles (auto/eco/premium/free). Adapts to your usage over time.

</td>
<td width="50%" valign="top">

**🛠 16 built-in tools**
Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, ImageGen, VideoGen, MemoryRecall, AskUser, SubAgent, TradingSignal, TradingMarket, TradingPortfolio, TradingOpenPosition, TradingClosePosition, TradingHistory.

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
│  2M+ requests · <!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> models · category detection · Elo scores │
├──────────────────────────────────────────────────────────────┤
│  Agent Loop                                                  │
│  16 tools · Sessions · Compaction · Pricing · Plugin SDK     │
├──────────────────────────────────────────────────────────────┤
│  BlockRun Gateway                                            │
│  <!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> LLMs · CoinGecko · Search · Image APIs · paid services  │
├──────────────────────────────────────────────────────────────┤
│  Account API credits or x402 wallet payments                 │
│  Bearer API key · or signed USDC on Solana & Base             │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │  Credits or │
                     │ your wallet │
                     └─────────────┘
```

The loop is simple:
1. You state an outcome.
2. Franklin chooses what to read, call, and pay for.
3. The call is billed to account credits or the selected x402 wallet.
4. Franklin reports the result and the spend.

That economic loop is the product.

---

## Project layout

```text
src/
├── index.ts           CLI entry (franklin)
├── banner.ts          Ben Franklin portrait + FRANKLIN gradient text
├── agent/             Agent loop, LLM client, compaction, commands
├── tools/             20+ built-in tools (Read/Write/Edit/Bash/Glob/Grep/
│                      WebFetch/WebSearch/Task/ImageGen/VideoGen/
│                      MemoryRecall/AskUser/SubAgent/Trading*/Content*)
├── trading/           Market data (CoinGecko) + technical indicators
├── content/           Content library with budget-bound media generation
├── brain/             Cross-session entity knowledge graph
├── channel/           Non-CLI ingress drivers (Telegram today)
├── events/            Internal event bus
├── plugin-sdk/        Public plugin contract (Workflow/Plugin/Channel)
├── plugins/           Plugin registry + runner (plugin-agnostic)
├── session/           Persistent sessions + search + channel tags
├── stats/             Usage tracking + insights engine
├── ui/                Ink-based terminal UI
├── proxy/             Payment proxy for external tools
├── router/            Learned model router (<!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> models, Elo scoring)
├── wallet/            Wallet management (Solana + Base)
├── mcp/               MCP server auto-discovery
└── commands/          CLI subcommands
```

---

## Free tier, for real

Start with **zero dollars**. Franklin defaults to free NVIDIA models that need no wallet funding.

```bash
franklin --model free
```

With account credits or a funded wallet, Franklin can access paid services: Sonnet, Opus, GPT, Gemini, Grok, and paid tools like Exa, DALL-E, and CoinGecko Pro.

---

## Remote control via Telegram

Drive Franklin from anywhere with a bot token:

```bash
export TELEGRAM_BOT_TOKEN=<from @BotFather>
export TELEGRAM_OWNER_ID=<your numeric Telegram user id>
franklin telegram                # start the bot (owner-locked)
```

Session state resumes across process restarts (tagged by owner id).
Slash commands `/new`, `/balance`, `/status`, `/help` handled locally
by the bot layer; everything else forwards to the agent. Progressive
streaming flushes partial answers at paragraph boundaries so long
replies don't wait for turn-end.

Same wallet. Same tools. From your phone.

---

## Documentation

Full BlockRun docs: **https://blockrun.ai/docs**

- [Agent developer guide](https://blockrun.ai/docs/getting-started/agent-developers) — building agents on BlockRun
- [Models, SDKs & APIs](https://blockrun.ai/docs) — the full gateway reference
- [Plugin SDK guide](docs/plugin-sdk.md) — build your own workflow vertical
- [Changelog](CHANGELOG.md) — every release explained
- [Roadmap](docs/ROADMAP.md) — what's coming next
- [Proxy mode](docs/) — use Franklin as a payment proxy for Anthropic-compatible CLI agents

---

## Community

- [Telegram](https://t.me/blockrunAI) — realtime help, bug reports, feature requests
- [@BlockRunAI](https://x.com/BlockRunAI) — release notes, demos
- [Issues](https://github.com/BlockRunAI/Franklin/issues) — bugs and feature requests

---

## Contributors

Franklin ships work from outside the core team on a regular basis: typed Phone & Voice tools, the `/market` command, the model picker catalog, Jupiter precision guards, and the bug reports behind the prompt-caching, stream-timeout, and wallet-reservation fixes.

The full list, with what each person shipped, lives in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md). Thank you.

PRs welcome — see the Development section below for the local loop.

---

## Development

```bash
git clone https://github.com/BlockRunAI/Franklin.git
cd franklin
npm install
npm run build
npm test              # deterministic local tests — no API calls
npm run test:e2e      # live e2e tests — free smoke works unfunded; paid tools need network + funded wallet
npm run test:free-models # live matrix across current free NVIDIA models
node dist/index.js --help
```

### Desktop app

The stable Franklin Desktop shell lives in [`apps/desktop`](apps/desktop). It uses
the Franklin runtime built by this monorepo, so CLI and Desktop changes are
versioned and tested together. See the [Desktop guide](apps/desktop/README.md) for
the product status, security model, and complete development workflow.

```bash
npm run desktop:dev       # Desktop UI with the local mock agent
npm run desktop:real --workspace @blockrun/franklin-desktop # real Franklin agent
npm run desktop:build     # type-check and build the renderer
npm run desktop:package:mac
npm run desktop:package:win
```

Packaged builds create a private, per-launch credential for the local Franklin
service, keep cloud session sync off unless the user explicitly enables it, and
use `Documents/Franklin` as the default workspace. Files outside that workspace
remain available after an explicit approval, similar to other coding agents.
Team Mode is being developed separately and is not part of this stable integration.

For the recommended live validation order and failure triage, see [docs/live-e2e-checklist.md](docs/live-e2e-checklist.md).

**Contributing:** open an issue first to discuss meaningful changes. PRs welcome on bugs, docs, new models in pricing, and new tools.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<div align="center">

**The AI agent with a budget.**<br>
<sub>Account credits or your wallet. Your budget. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>


## Account setup, billing, and switching back to wallets

1. [Sign in to BlockRun](https://user.blockrun.ai), open [Billing](https://user.blockrun.ai/dashboard/credits), and add prepaid account credits. The checkout shows both the credit amount and the total card charge, including any processing fee; these amounts can differ.
2. Create a key on [API Keys](https://user.blockrun.ai/dashboard/keys). Keep it in your server or local process environment as `BLOCKRUN_API_KEY`; never put it in browser code, logs, or a repository. Follow this README's client configuration example.
3. Check [Activity](https://user.blockrun.ai/dashboard/activity) after a call. Chat uses reported token usage; media and data services can use per-image, duration, or per-request prices. Account credits and an on-chain USDC wallet are separate balances. Local wallet spend counters are not account receipts.
4. A 401 means check the API key, 402 means check account credits or account status, and 429 means respect `Retry-After`. Poll an accepted media job using the complete returned `poll_url`, including its query parameters, with the same account key. Do not reconstruct the URL from the job ID. If polling times out, check that job and Activity before submitting another paid job.

Accepted account jobs recover from temporary gateway polling errors by querying the same job within the original deadline. They do not resubmit the paid creation request. Authentication, credit, and rate-limit errors remain visible to the caller.

To return to wallet billing, unset `BLOCKRUN_API_KEY` in the environment that launches Franklin, then restart it. The existing wallet and saved chain selection remain in place. Changing the wallet chain while an API key is configured does not switch the billing source.
