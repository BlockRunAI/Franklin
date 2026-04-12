<div align="center">

<br>

<h1>
  <code>◆</code> &nbsp; Franklin &nbsp; <code>◆</code>
</h1>

<h3>The wallet-native economic agent.</h3>

<p>
  While others generate text, Franklin deploys capital.<br>
  One wallet. Every model. Every paid API. Budgeted execution in USDC.
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
  <a href="#a-new-category">New&nbsp;category</a> ·
  <a href="#what-franklin-can-execute">What&nbsp;it&nbsp;does</a> ·
  <a href="#the-comparison">Compare</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

`franklin` is not a coding copilot and not just another task runner. Franklin is a **wallet-native economic agent**: software with purchasing power. You give it a goal and a budget. Franklin decides what model to call, what tool to use, what API is worth paying for, and when to stop. Every paid action routes through the [x402](https://x402.org) micropayment protocol and settles against your own wallet. No subscriptions. No API keys. No account. The wallet is the identity.

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

## A new category

> **Economic Agent**
> 
> Software that can hold a wallet, price its own actions, spend toward an outcome, and stop at a hard budget cap.

That definition matters.

Most AI products fit into one of three buckets:
- They answer questions.
- They write code.
- They automate a fixed workflow.

Franklin does something different. It combines:
- **Purchasing power** — it can pay for models, tools, and APIs.
- **Budget awareness** — it knows spend is part of the problem, not an afterthought.
- **Cross-vertical execution** — marketing, trading, research, code, ops.
- **Hard stopping conditions** — when the wallet or budget says stop, it stops.

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

### 🎯 Social growth

```text
> find X posts complaining about AI rate limits

  ✓ SearchX  "AI rate limits"

  Found 8 candidates:
  1. "Claude keeps throttling me in the middle of shipping..." — @buildermax (2h)
  2. "I need an agent that can switch models automatically." — @indiedev (5h)
  ...

> write a reply to #2 — mention Franklin uses a wallet instead of subscriptions

  Draft:
  "That was my pain too. Franklin routes across 55+ models,
   pays per action from a USDC wallet, and doesn't trap you
   inside a monthly seat. Better economics, better uptime."

> looks good, post it

  ✓ PostToX  Reply posted to x.com/indiedev/status/...
```

Search X, generate contextual replies, and post with confirmation. Uses Playwright for browser automation, so there is no X API key, no OAuth maze, and no $100/month developer account.

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

Every tool call is itemized. Every token is priced. When the wallet hits zero, Franklin stops. No overdraft, no surprise bill, no rate-limit wall at 3am.

---

## Why Franklin

<table>
<tr>
<td width="33%" valign="top">

### 💳 &nbsp;Budget is native

Franklin does not bolt spend tracking on afterward. Cost is part of the loop. The agent can choose free, cheap, or premium paths per step, and every paid action settles against your wallet.

</td>
<td width="33%" valign="top">

### 🔐 &nbsp;Wallet is identity

No email. No phone. No KYC. Your Base or Solana address is your account. Portable across machines. Your sessions, your config, your money.

</td>
<td width="33%" valign="top">

### 🧠 &nbsp;One runtime, many verticals

Marketing, trading, research, code, and anything else you can express as tools plus budgeted execution. Franklin is a runtime for economic workflows, not a single-purpose copilot.

</td>
</tr>
</table>

---

## The comparison

|                                      | Chatbots        | Coding agents    | Workflow tools   | **Franklin**                    |
| ------------------------------------ | --------------- | ---------------- | ---------------- | ------------------------------- |
| Main unit of value                   | Answers         | Code changes     | Fixed automations| **Budgeted outcomes**           |
| Has purchasing power                 | ❌              | ❌               | ❌               | ✅ **wallet-native**            |
| Can choose tools/models per step     | ⚠️ limited      | ✅ mostly coding | ❌ usually fixed | ✅ **yes**                      |
| Works across marketing/trading/code  | ⚠️              | ❌ code-first    | ⚠️ integration-bound | ✅ **cross-vertical**       |
| Hard spend cap                       | ❌              | ❌               | ⚠️ external billing | ✅ **wallet balance**        |
| Identity                             | Account         | Account / API key| Account          | ✅ **wallet**                   |
| Start free, no signup                | ⚠️              | ❌ / BYOK        | ❌               | ✅                              |
| Paid APIs through one interface      | ❌              | ⚠️               | ❌               | ✅ **55+ models + paid tools**  |

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

**🎯 Social growth**
Ask "find X posts about my category" — Franklin searches X, drafts replies, and posts with your confirmation.

**🧠 55+ models via one wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One wallet, one interface, automatic fallback.

**💳 x402 micropayments**
HTTP 402 native. Every paid action is a signed micropayment against your USDC balance. No subscriptions. No refund loop. No account lock-in.

**🚦 Smart spend routing**
Free / cheap / premium per step. Franklin picks the cheapest model that can do the job, then escalates when quality matters.

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
│  Intent → Routing → Tool Use → Spend Decisions → Result      │
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
├── router/            Smart model routing (free/cheap/premium)
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

**Franklin is the economic agent.**<br>
<sub>Your wallet. Your budget. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>
