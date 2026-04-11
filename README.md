<h1 align="center">Franklin</h1>

<p align="center">
  <strong>The AI agent with a wallet.</strong>
</p>

<p align="center">
  While others chat, Franklin spends — turning your USDC into real work.
</p>

<p align="center">
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/v/@blockrun/franklin.svg?style=flat-square&color=FFD700" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square" alt="License: Apache-2.0"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/x402-Payments-10B981?style=flat-square" alt="x402"></a>
  <a href="https://franklin.run"><img src="https://img.shields.io/badge/Marketing-franklin.run-06B6D4?style=flat-square" alt="franklin.run"></a>
  <a href="https://franklin.bet"><img src="https://img.shields.io/badge/Trading-franklin.bet-10B981?style=flat-square" alt="franklin.bet"></a>
</p>

---

## Franklin runs your money

Franklin is the first AI agent that can actually **spend money** to get work done. Not just write text about it.

```bash
$ franklin marketing campaign "Launch my AI coding app to indie hackers"
  Budget cap: $10

  ✓ $0.50  Research competitors via Exa
  ✓ $1.20  Write 5 blog post drafts (Claude Sonnet 4.6)
  ✓ $0.48  Generate 3 hero images (DALL-E 3)
  ✓ $3.50  Generate 15-second launch video (Runway)
  ✓ $0.80  Generate background music (Suno)
  ✓ $0.30  Find 20 relevant Reddit discussions
  ✓ $1.50  Draft Reddit comments (Claude Sonnet 4.6)
  ✓ $0.10  Post 3 casts to Farcaster

  Total spent: $8.58 · Time: 4m 32s
  Deliverables: 5 blog posts, 3 hero images, 1 launch video, 1 music
                track, 20 Reddit drafts, 3 Farcaster casts (live)
```

**One wallet. Every model. Every paid API. No subscriptions. No accounts.**

---

## Two products, one Franklin

| | | |
|---|---|---|
| 🎯 | **[franklin.run](https://franklin.run)** | **Marketing agent** — campaigns, content, outreach, growth |
| 📈 | **[franklin.bet](https://franklin.bet)** | **Trading agent** — signals, research, risk analysis |

Both paid per action in USDC. Both backed by the same [BlockRun gateway](https://blockrun.ai) and x402 protocol.

---

## Why Franklin is different

| | Claude Code | Hermes | OpenClaw | **Franklin** |
|---|---|---|---|---|
| Writes text | ✅ | ✅ | ✅ | ✅ |
| Reads code | ✅ | ✅ | ✅ | ✅ |
| Multi-model | ❌ Claude only | ✅ BYOK | ✅ BYOK | ✅ **55+ via one wallet** |
| **Spends money autonomously** | ❌ | ❌ | ❌ | ✅ |
| **Wallet-native identity** | ❌ | ❌ | ❌ | ✅ |
| **Pay per action** | ❌ subscription | ❌ BYOK | ❌ BYOK | ✅ USDC |
| **Marketing workflows** | ❌ | ❌ | ❌ | ✅ franklin.run |
| **Trading workflows** | ❌ | ❌ | ❌ | ✅ franklin.bet |
| No account / phone verification | ❌ | ⚠️ BYOK | ⚠️ BYOK | ✅ |

**Franklin is the first AI agent in the "Autonomous Economic Agent" category** — an agent that receives a goal, decides what to spend on, and executes autonomously within a hard budget cap enforced by the wallet.

---

## Quick Start

```bash
# Install
npm install -g @blockrun/franklin

# Create a wallet (Base or Solana)
franklin setup base

# Fund wallet with USDC (any amount, $5 gets you started)
# Check address: franklin balance

# Run
franklin                           # Interactive agent — code, research, anything
franklin marketing run             # Marketing workflow
franklin trading signal "BTC"      # Trading workflow
franklin plugins                   # List installed plugins
```

**Start free:** use `franklin` with NVIDIA's free models (Nemotron, Qwen3 Coder) — zero wallet funding required to try it out.

---

## How it works

```
┌─────────────────────────────────────────────────┐
│  Franklin Agent (you)                            │
│  Plugin SDK · CLI · Multi-model router           │
├─────────────────────────────────────────────────┤
│  BlockRun Gateway                                │
│  Aggregates 55+ LLMs + Exa + DALL-E + (soon)    │
│  Runway + Suno + CoinGecko + Dune + Apollo       │
├─────────────────────────────────────────────────┤
│  x402 + Wallet Infrastructure                    │
│  HTTP 402 micropayments · USDC on Base/Solana    │
└─────────────────────────────────────────────────┘
```

Every API call is paid atomically from your wallet via the x402 protocol. You fund once; Franklin spends per task. The wallet is your identity — no accounts, no API keys, no KYC.

---

## Features

### Core agent (55+ models)

- **Multi-model routing** — Claude Sonnet/Opus, GPT-5.4, Gemini 2.5 Pro, DeepSeek, Grok 4, Kimi, GLM-5.1, Llama, NVIDIA free tier
- **Automatic fallback** — if one model fails, Franklin tries the next
- **Smart tiers** — free / cheap / premium per task, user-configurable
- **Prompt caching** — 75% input token savings on Anthropic multi-turn (Hermes pattern)
- **Structured context compression** — Goal / Progress / Decisions / Files / Next Steps template
- **Session search** — `franklin search "payment loop"` — full-text across past sessions
- **Rich insights** — `franklin insights` — cost breakdown, daily activity sparklines, projections

### Plugin SDK

Franklin is plugin-first. Core stays workflow-agnostic. Adding a new vertical requires zero core changes.

```typescript
import type { Plugin, Workflow } from '@blockrun/franklin/plugin-sdk';

const myWorkflow: Workflow = {
  id: 'my-workflow',
  name: 'My Workflow',
  description: '...',
  steps: [
    { name: 'search', modelTier: 'none', execute: async (ctx) => ({ ... }) },
    { name: 'filter', modelTier: 'cheap', execute: async (ctx) => ({ ... }) },
    { name: 'draft',  modelTier: 'premium', execute: async (ctx) => ({ ... }) },
  ],
  // ...
};
```

Full plugin guide: [docs/plugin-sdk.md](docs/plugin-sdk.md)

### Built-in tools

Read · Write · Edit · Bash · Glob · Grep · WebFetch · WebSearch · Task · ImageGen · AskUser · SubAgent (delegated child agents with isolated toolsets)

### MCP integration

Auto-discovers installed MCP servers including `blockrun-mcp` (market data, X data, prediction markets) and `unbrowse` (turn any website into an API). Add your own in `~/.blockrun/mcp.json`.

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Interactive model picker · `/model <name>` to switch |
| `/compact` | Compress conversation history (structured summary) |
| `/search <query>` | Search past sessions by keyword |
| `/insights` | Rich usage analytics — cost, trends, projections |
| `/ultrathink` | Deep reasoning mode for hard problems |
| `/plan` · `/execute` | Read-only planning mode → execution mode |
| `/history` · `/resume <id>` | Session management |
| `/commit` · `/push` · `/pr` · `/review` | Git workflow helpers |
| `/cost` | Session cost and savings vs Claude Opus |
| `/wallet` | Wallet address and USDC balance |
| `/help` | Full command list |

---

## Migration from RunCode

**Nothing breaks.** If you were using RunCode, your `runcode` command continues to work as an alias for `franklin` for 60 days. Your config at `~/.blockrun/` is unchanged. Your wallet, sessions, and settings all migrate automatically.

The package name is now `@blockrun/franklin`. Update when convenient:

```bash
npm uninstall -g @blockrun/runcode
npm install -g @blockrun/franklin
```

Both commands (`franklin` and `runcode`) work for the next 60 days. After v3.1.0 ships, `runcode` will be removed.

---

## Architecture

```
src/
├── agent/              # Core agent loop, multi-model LLM client, compaction
├── tools/              # 12 built-in tools
├── plugin-sdk/         # Public plugin contract (Workflow, Channel, Plugin)
├── plugins/            # Plugin registry + runner (plugin-agnostic)
├── plugins-bundled/    # Ships with Franklin — social, marketing (more coming)
├── session/            # Persistent sessions + FTS search
├── stats/              # Usage tracking + insights engine
├── ui/                 # Terminal UI (Ink-based)
├── proxy/              # Payment proxy for Claude Code compatibility
├── router/             # Smart model tier routing
├── wallet/             # Wallet management (Base + Solana)
└── commands/           # CLI subcommands
```

---

## Development

```bash
git clone https://github.com/BlockRunAI/franklin.git
cd franklin
npm install
npm run build
npm test             # Deterministic local tests (no API calls)
npm run test:e2e     # Live end-to-end tests (hits real models)
node dist/index.js --help
```

---

## Contributing

Contributions welcome. Open an issue first to discuss meaningful changes. For plugin ideas, see [docs/plugin-sdk.md](docs/plugin-sdk.md) — the plugin system is how most new features should land.

---

## Links

- **Marketing**: [franklin.run](https://franklin.run)
- **Trading**: [franklin.bet](https://franklin.bet)
- **Parent**: [BlockRun](https://blockrun.ai)
- **npm**: [@blockrun/franklin](https://npmjs.com/package/@blockrun/franklin)
- **Telegram**: [t.me/blockrunAI](https://t.me/blockrunAI)
- **x402 protocol**: [x402.org](https://x402.org)

---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<p align="center">
  <strong>Franklin runs your money.</strong><br>
  <sub>Your wallet, your agent, your results.</sub>
</p>
