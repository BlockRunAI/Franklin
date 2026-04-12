<div align="center">

<br>

<img src="assets/terminal-banner.png" alt="Franklin terminal" width="680">

<br><br>

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
  <a href="#what-it-looks-like">Demo</a> ·
  <a href="#why-franklin">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#plugin-sdk">Plugins</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

Every AI coding tool today writes text. `franklin` **spends money** — your USDC, from your wallet, on your behalf, under a hard budget cap — to actually get work done. One agent. 55+ models. Every paid API routed through the [x402](https://x402.org) micropayment protocol. No subscriptions. No API keys. No account. The wallet is your identity.

Built by the [BlockRun](https://blockrun.ai) team. Apache‑2.0. TypeScript. Ships as one npm package.

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

## What it looks like

```text
 ███████╗██████╗  █████╗ ███╗   ██╗██╗  ██╗██╗     ██╗███╗   ██╗
 ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║ ██╔╝██║     ██║████╗  ██║
 █████╗  ██████╔╝███████║██╔██╗ ██║█████╔╝ ██║     ██║██╔██╗ ██║
 ██╔══╝  ██╔══██╗██╔══██║██║╚██╗██║██╔═██╗ ██║     ██║██║╚██╗██║
 ██║     ██║  ██║██║  ██║██║ ╚████║██║  ██╗███████╗██║██║ ╚████║
 ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝
  Franklin  ·  The AI agent with a wallet  ·  v3.1.0

  Model : anthropic/claude-sonnet-4.6
  Wallet: 0x7a9…4e2  ·  12.47 USDC

> refactor src/auth.ts to use the new jwt helper, then run the tests

  ✓ Read  src/auth.ts                                     $0.0024
  ✓ Read  src/lib/jwt.ts                                  $0.0011
  ✓ Edit  src/auth.ts  (-24 +31 lines)                    $0.0082
  ✓ Bash  npm test                                        $0.0000
    › 142 passing · 0 failing · 2.4s

  Done in 18s · 4 tool calls · 12.8k in / 2.1k out · $0.0117
```

Every tool call is itemised. Every token is priced. The wallet is the source of truth — when it hits zero, Franklin stops. No overdraft, no surprise bill, no rate-limit wall at 3am.

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

Claude Sonnet/Opus 4.6, GPT‑5.4, Gemini 2.5 Pro, Grok 4, DeepSeek V3, GLM‑5.1, Kimi, Minimax, plus NVIDIA's free tier (Nemotron, Qwen3 Coder). Switch mid‑session with `/model`. Automatic fallback if one provider is down.

</td>
</tr>
</table>

---

## The comparison

|                                   | Claude Code    | Aider         | Cursor         | **Franklin**          |
| --------------------------------- | -------------- | ------------- | -------------- | --------------------- |
| Writes and edits code             | ✅             | ✅            | ✅             | ✅                    |
| Multi‑model support               | ❌ Claude only | ✅ BYOK        | ⚠️ limited     | ✅ **55+ via 1 wallet** |
| Pricing model                     | Subscription   | BYOK          | Subscription   | **Pay per action**    |
| Identity                          | Account        | API keys      | Account        | **Wallet**            |
| Spend budget cap enforced on‑chain | ❌             | ❌            | ❌             | ✅                    |
| Pay any API (images, search…)      | ❌             | ❌            | ❌             | ✅ via x402           |
| Plugin SDK for custom workflows    | ❌             | ⚠️            | ❌             | ✅                    |
| Persistent sessions + search       | ⚠️             | ⚠️            | ⚠️             | ✅                    |
| Start free, no signup              | ❌             | ⚠️ BYOK        | ❌             | ✅                    |

Franklin is the first agent in the **Autonomous Economic Agent** category — an agent that takes a goal, decides what to spend on, and executes within a hard budget cap enforced by the wallet.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

**🧠 55+ models via one wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One URL, one wallet, automatic fallback.

**💳 x402 micropayments**
HTTP 402 native. Every tool call is a tiny signed transaction against your USDC balance. No escrow, no refund API, no subscription.

**🚦 Smart tier routing**
Mark steps as `free` / `cheap` / `premium` — Franklin picks the best model per tier, per task. Configurable defaults in `franklin config`.

**🔌 Plugin SDK**
Core is workflow‑agnostic. Ship a new vertical (marketing, trading, research) without touching the agent loop. See [docs/plugin-sdk.md](docs/plugin-sdk.md).

**💾 Persistent sessions**
Every turn is streamed to disk with full metadata. Resume any session by ID. Survives crashes, reboots, context compaction.

**🔍 Full‑text session search**
`franklin search "payment loop"` — tokenised search across every past session. No SQLite, no indexing daemon, just fast.

</td>
<td width="50%" valign="top">

**📊 Cost insights**
`franklin insights` — daily spend sparklines, per‑model breakdown, projections. Never wonder where the USDC went.

**⚡ Anthropic prompt caching**
Multi‑turn Sonnet/Opus sessions use ephemeral cache breakpoints (`system_and_3` strategy). Large input savings on long conversations.

**🛠 12 built‑in tools**
Read · Write · Edit · Bash · Glob · Grep · WebFetch · WebSearch · Task · ImageGen · AskUser · SubAgent.

**🔗 MCP auto‑discovery**
Drop‑in Model Context Protocol servers from `~/.blockrun/mcp.json`. Ships with awareness of `blockrun-mcp` (markets, X, prediction markets) and `unbrowse` (any site → API).

**🧭 Plan / Execute modes**
`/plan` to design read‑only, `/execute` to commit. No accidental writes while exploring.

**🪄 Slash ergonomics**
`/commit`, `/push`, `/pr`, `/review`, `/ultrathink`, `/compact`, `/model`, `/cost`, `/wallet`, and 20+ more.

</td>
</tr>
</table>

---

## Plugin SDK

Franklin is plugin‑first. The core agent doesn't know what a "marketing campaign" or "trading signal" is — it just runs workflows. Adding a new vertical is a single TypeScript file.

```typescript
import type { Plugin, Workflow } from '@blockrun/franklin/plugin-sdk';

const researchWorkflow: Workflow = {
  id: 'research',
  name: 'Competitor Research',
  description: 'Find and summarise 10 competitors in a given space',
  steps: [
    {
      name: 'search',
      modelTier: 'none',          // pure API call, no LLM
      execute: async (ctx) => {
        const results = await ctx.exa.search(ctx.input.topic, { limit: 10 });
        return { output: `Found ${results.length}`, data: { results } };
      },
    },
    {
      name: 'summarise',
      modelTier: 'cheap',         // bulk work — use GLM or DeepSeek
      execute: async (ctx) => {
        const summaries = await ctx.llm.map(ctx.data.results, (r) =>
          `Summarise in 3 bullets: ${r.text}`);
        return { output: 'Summaries written', data: { summaries } };
      },
    },
    {
      name: 'synthesise',
      modelTier: 'premium',       // final output — use Claude Opus
      execute: async (ctx) => {
        const report = await ctx.llm.complete({
          system: 'You are a strategy analyst.',
          user: `Synthesise these into a 1‑page report: ${JSON.stringify(ctx.data.summaries)}`,
        });
        return { output: report };
      },
    },
  ],
};

export const myPlugin: Plugin = {
  id: 'research',
  name: 'Research',
  version: '0.1.0',
  workflows: [researchWorkflow],
};
```

Three steps, three tiers, three prices. The agent routes each step to the cheapest model that can do the job. Full guide: **[docs/plugin-sdk.md](docs/plugin-sdk.md)**.

---

## Slash commands

A curated subset of what `franklin` exposes inside an interactive session:

| Command                          | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `/model [name]`                  | Interactive model picker, or switch directly         |
| `/plan` · `/execute`             | Read‑only planning mode → commit mode                |
| `/ultrathink <q>`                | Deep reasoning mode for hard problems                |
| `/compact`                       | Structured context compression (Goal/Progress/Next)  |
| `/search <q>`                    | Full‑text search across past sessions                |
| `/history` · `/resume <id>`      | Session management                                   |
| `/commit` · `/push` · `/pr`      | Git workflow helpers (Franklin writes the message)   |
| `/review` · `/fix` · `/test`     | One‑shot code review, bugfix, or test generation     |
| `/explain <file>` · `/refactor`  | Targeted explanation or refactor                     |
| `/cost` · `/wallet`              | Session cost, wallet address & USDC balance          |
| `/insights [--days N]`           | Rich usage analytics                                 |
| `/mcp` · `/doctor` · `/context`  | Diagnostics                                          |
| `/help`                          | Full command list                                    |

Run `franklin` and type `/help` to see everything.

---

## CLI commands

Top‑level commands (`franklin --help`):

```text
setup [chain]     Create a wallet for payments (base | solana)
start             Start the interactive agent (default command)
models            List available models and pricing
balance           Check wallet USDC balance
config <action>   Manage config: default‑model, sonnet‑model, routing…
stats             Usage statistics and cost savings vs. Claude Opus
insights          Rich usage analytics (also /insights in session)
search <q>        Full‑text session search (also /search in session)
social            AI‑powered social engagement plugin
plugins           List installed plugins
proxy             Run a payment proxy for Claude Code compatibility
init / uninit     Install/remove the background daemon (macOS LaunchAgent)
daemon <action>   start | stop | status
logs              Tail debug logs
```

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  Franklin Agent                                              │
│  Plugin SDK · Tool loop · Router · Session · Compaction      │
├──────────────────────────────────────────────────────────────┤
│  BlockRun Gateway                                            │
│  55+ LLMs · Exa search · DALL·E · (soon) Runway · Suno       │
│  CoinGecko · Dune · Apollo                                   │
├──────────────────────────────────────────────────────────────┤
│  x402 Micropayment Protocol                                  │
│  HTTP 402 · USDC on Base & Solana · on‑chain budget cap      │
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
├── banner.ts          FRANKLIN gold→emerald gradient
├── agent/             Agent loop, LLM client, compaction, commands
├── tools/             12 built‑in tools (Read/Write/Edit/Bash/…)
├── plugin-sdk/        Public plugin contract (Workflow/Plugin/Channel)
├── plugins/           Plugin registry + runner (plugin‑agnostic)
├── plugins-bundled/   Plugins shipped with Franklin
│   └── social/        AI‑powered social engagement
├── session/           Persistent sessions + FTS search
├── stats/             Usage tracking + insights engine
├── ui/                Ink‑based terminal UI
├── proxy/             Payment proxy for Claude Code compatibility
├── router/            Smart model tier routing (free/cheap/premium)
├── wallet/            Wallet management (Base + Solana)
├── mcp/               MCP server auto‑discovery
└── commands/          CLI subcommands
```

---

## Roadmap

### ✅ Shipped in v3.1.0
- Interactive agent with 12 built‑in tools
- 55+ models across Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier
- Plugin SDK (workflow, channel, plugin) — plugin‑first architecture
- **Social plugin** — AI‑powered engagement on Reddit / X
- x402 micropayment integration
- Wallet setup (Base + Solana), balance, funding flow
- Persistent sessions + full‑text search
- Cost insights engine with daily sparklines
- Anthropic prompt caching (ephemeral, multi‑breakpoint)
- Plan/Execute modes, slash commands, compaction, smart routing
- MCP auto‑discovery
- Proxy mode for Claude Code compatibility

### 🚧 In progress
- **Marketing plugin** — campaigns, Reddit/IG outreach, content generation pipelines
- **Trading plugin** — signals, market research, risk analysis
- Video (Runway) and audio (Suno) paid tool routes
- Per‑step budget caps inside workflows
- More languages in `franklin config` (`.yaml` support)

### 💭 Under consideration
- Shared plugin registry (install community plugins with `franklin plugins add`)
- Fiat on‑ramp inside `franklin setup`
- Mobile wallet handoff via WalletConnect

---

## Free tier, for real

Start with **zero dollars**. Franklin defaults to free NVIDIA models (Nemotron 70B, Qwen3 Coder 480B) that need no wallet funding. Rate‑limited to 60 requests/hour on the gateway, but genuinely free.

```bash
franklin --model nvidia/nemotron-ultra-253b
```

Only fund a wallet when you want Claude, GPT, Gemini, Grok, or paid tools like Exa and DALL·E.

---

## Documentation

- 📖 **[Plugin SDK guide](docs/plugin-sdk.md)** — build your own workflow
- 📜 **[Changelog](CHANGELOG.md)** — every release explained
- 🗺 **[Roadmap](docs/ROADMAP.md)** — what's coming next
- 🧭 **[Claude Code compatibility](docs/)** — use Franklin as a payment proxy

---

## Community

- 💬 **[Telegram](https://t.me/blockrunAI)** — realtime help, bug reports, feature requests
- 🐦 **[@BlockRunAI](https://x.com/BlockRunAI)** — release notes, demos
- 🐛 **[Issues](https://github.com/BlockRunAI/franklin/issues)** — bugs and feature requests
- 💡 **[Discussions](https://github.com/BlockRunAI/franklin/discussions)** — ideas, Q&A, show & tell

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

**Contributing:** please open an issue first to discuss meaningful changes. For new features, prefer a plugin over a core change — [docs/plugin-sdk.md](docs/plugin-sdk.md) exists exactly so the core stays lean. PRs welcome on bugs, docs, typos, new models in pricing.

---

## Migrating from RunCode

If you were a RunCode user: **nothing breaks**. The `runcode` binary still works as an alias for `franklin` through the 60‑day compatibility window (until ~June 2026). Your config at `~/.blockrun/`, your wallet, your sessions — all migrate automatically.

To update when convenient:

```bash
npm uninstall -g @blockrun/runcode
npm install -g @blockrun/franklin
```

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

Apache‑2.0. See [LICENSE](LICENSE).

Built on the shoulders of giants: [x402](https://x402.org), [Anthropic](https://anthropic.com), [@modelcontextprotocol](https://github.com/modelcontextprotocol), [Ink](https://github.com/vadimdemedes/ink), [commander](https://github.com/tj/commander.js).

---

<div align="center">

**Franklin runs your money.**<br>
<sub>Your wallet. Your agent. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>
