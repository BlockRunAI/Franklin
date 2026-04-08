<p align="center">
  <img src="assets/banner.png" alt="RunCode" width="600">
</p>

<div align="center">

<p><strong>Open-source AI coding agent. 55+ models. Pay per use with USDC.</strong></p>

<br>

[![npm version](https://img.shields.io/npm/v/@blockrun/runcode.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/runcode)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![x402](https://img.shields.io/badge/x402-Payments-purple?style=flat-square)](https://x402.org)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

---

## Why RunCode?

| | Claude Code | Cursor | Aider | **RunCode** |
|---|---|---|---|---|
| Models | Claude only | Mixed (limited) | Bring your key | **55+ models, one tool** |
| Pricing | $200/mo subscription | $20/mo + usage | Free + API costs | **Pay per request** |
| Payment | Credit card | Credit card | API keys | **USDC — no accounts** |
| Open source | No | No | Yes | **Yes** |
| Switch models mid-session | No | No | Yes | **Yes** |

RunCode gives you the same agent capabilities — file editing, shell commands, web search, sub-agents — across every major model provider. You pay only for what you use, with stablecoin. No API keys to manage, no accounts to create, no subscriptions to cancel.

## Quick Start

```bash
npm install -g @blockrun/runcode
runcode setup base     # Create a Base wallet (or: runcode setup solana)
runcode                # Launch — picks model interactively
```

Fund the wallet address with USDC on Base, or use free models immediately — no funding required to start.

## Features

### Agent Capabilities

RunCode is a full coding agent with 10 built-in tools:

| Tool | Description |
|------|-------------|
| **Read** | Read files with line numbers |
| **Write** | Create or overwrite files |
| **Edit** | Targeted find-and-replace edits |
| **Bash** | Run shell commands with timeout |
| **Glob** | Find files by pattern |
| **Grep** | Search file contents (uses ripgrep) |
| **WebSearch** | Search the web |
| **WebFetch** | Fetch and read web pages |
| **Agent** | Spawn sub-agents for parallel tasks |
| **Task** | Track tasks within a session |

### Model Selection

Launch with the interactive model picker, or specify directly:

```bash
runcode                          # Interactive picker
runcode -m sonnet                # Claude Sonnet 4.6
runcode -m gpt                   # GPT-5.4
runcode -m deepseek              # DeepSeek V3
runcode -m free                  # Nemotron Ultra 253B (free)
```

Switch models mid-session:

```
/model              # Interactive picker
/model flash        # Switch to Gemini 2.5 Flash
/cost               # Check session cost
```

<details>
<summary><strong>All model shortcuts (30+)</strong></summary>

| Shortcut | Model | Price (in/out per 1M) |
|----------|-------|----------------------|
| `sonnet` | Claude Sonnet 4.6 | $3 / $15 |
| `opus` | Claude Opus 4.6 | $5 / $25 |
| `gpt` | GPT-5.4 | $2.5 / $15 |
| `gemini` | Gemini 2.5 Pro | $1.25 / $10 |
| `flash` | Gemini 2.5 Flash | $0.15 / $0.6 |
| `deepseek` | DeepSeek V3 | $0.28 / $0.42 |
| `r1` | DeepSeek R1 | $0.28 / $0.42 |
| `haiku` | Claude Haiku 4.5 | $0.8 / $4 |
| `mini` | GPT-5 Mini | $0.25 / $2 |
| `nano` | GPT-5 Nano | $0.05 / $0.4 |
| `o3` | O3 | $2 / $8 |
| `o4` | O4 Mini | $1.1 / $4.4 |
| `grok` | Grok 3 | varies |
| `glm` | GLM-5 (Zhipu) | $0.001/call |
| `glm-turbo` | GLM-5-Turbo (Zhipu) | $0.001/call |
| `free` | Nemotron Ultra 253B | FREE |
| `devstral` | Devstral 2 123B | FREE |
| `qwen-coder` | Qwen3 Coder 480B | FREE |
| `maverick` | Llama 4 Maverick | FREE |

</details>

### Token Optimization

Nine layers of automatic optimization keep context usage low and costs down:

1. **Thinking block stripping** — removes old reasoning from history
2. **Tool result budgeting** — caps large outputs at 50K chars with preview
3. **Microcompaction** — clears old tool results (keeps last 8)
4. **Time-based cleanup** — clears stale results after 60min idle
5. **Auto-compact** — summarizes history when approaching context limit
6. **Adaptive max_tokens** — starts at 8K, escalates to 64K on demand
7. **Prompt-too-long recovery** — auto-compacts and retries up to 3x
8. **Anthropic prompt caching** — automatically adds `cache_control` markers on system prompt, tools, and recent messages; cuts cached input cost ~90%
9. **GLM-5 tuning** — sets temperature=0.8 (Zhipu spec), enables thinking mode for `-thinking-` variants; flat $0.001/call billing tracked accurately

### Permission System

By default, read-only tools run automatically. Destructive tools (Write, Edit, Bash) prompt for permission:

```
  Permission required: Bash
  Execute: rm -rf node_modules

  Allow? [y]es / [n]o / [a]lways:
```

Use `--trust` to skip all prompts:

```bash
runcode --trust
```

Configure rules in `~/.blockrun/runcode-permissions.json`:

```json
{
  "allow": ["Bash(git *)"],
  "deny": ["Bash(rm -rf *)"]
}
```

### Streaming Tool Execution

Concurrent-safe tools (Read, Glob, Grep) start executing while the model is still streaming. Sequential tools (Write, Edit, Bash) wait for the full response. This reduces latency on multi-tool turns.

### Proxy Mode

Use any model through Claude Code by running RunCode as a payment proxy. It translates between OpenAI and Anthropic formats, handles x402 payments, and adds automatic fallback when a model is unavailable.

```bash
runcode proxy                    # Start payment proxy on :8402
runcode proxy -m deepseek        # With default model
```

**One-command setup for Claude Code:**

```bash
runcode init                     # Auto-configures Claude Code + LaunchAgent
```

This writes the proxy endpoint into Claude Code's config and installs a macOS LaunchAgent so the proxy starts automatically on login. Run `runcode uninit` to undo.

**How it works:**

```
Claude Code → RunCode proxy (:8402) → BlockRun API → 55+ models
                 ↓
          x402 payment (USDC)
          SSE format translation
          Auto-fallback on failure
```

## Payment

RunCode uses the [x402](https://x402.org) protocol for pay-per-request payments with USDC stablecoins. No accounts, no API keys, no subscriptions.

### Supported chains

| Chain | Default | API endpoint | Gas token |
|-------|---------|-------------|-----------|
| **Base** | ✓ | `blockrun.ai/api` | ETH (tiny, ~$0.00) |
| **Solana** | — | `sol.blockrun.ai/api` | SOL (tiny, ~$0.00) |

Both chains use **USDC** (USD Coin) as the payment token. USDC is a stablecoin pegged 1:1 to USD — $1 USDC = $1.

### Quick setup

**Option A — Base (recommended for most users):**
```bash
runcode setup base         # Create an EVM wallet (Base chain)
runcode balance            # Check USDC balance
```

Fund with USDC on Base:
- Buy ETH on Coinbase → bridge to Base → swap to USDC on [Aerodrome](https://aerodrome.finance)
- Or: buy USDC directly on Coinbase and withdraw to Base network
- Or: transfer USDC from any Base wallet to the address shown by `runcode balance`

**Option B — Solana:**
```bash
runcode setup solana       # Create a Solana wallet
runcode balance            # Check USDC balance
```

Fund with USDC on Solana:
- Buy SOL on Coinbase/Binance → swap to USDC on [Jupiter](https://jup.ag)
- Or: buy USDC on any exchange and withdraw to Solana network
- Or: transfer USDC from any Solana wallet (e.g., Phantom, Backpack)

### Switching chains

```bash
runcode solana             # Switch to Solana
runcode base               # Switch to Base
```

Or via environment variable (useful for CI/CD):
```bash
RUNCODE_CHAIN=solana runcode
RUNCODE_CHAIN=base runcode
```

Wallets are stored locally in `~/.blockrun/`. Each chain has its own wallet — switching doesn't affect the other.

### What does it cost?

| Model | ~Cost per request |
|-------|-------------------|
| Free models (Nemotron, Devstral, etc.) | **$0** |
| DeepSeek V3 / Gemini Flash | ~$0.001 |
| GLM-5 / GLM-5-Turbo | **$0.001/call** (flat rate, any token count) |
| Claude Haiku / GPT-5 Mini | ~$0.005 |
| Claude Sonnet / GPT-5.4 | ~$0.01 |
| Claude Opus | ~$0.05 |

The balance shown in the status bar updates in real-time as you spend — no need to wait for on-chain confirmation.

Typical usage: **$5-20/month** for active development. Start with free models — no funding required.

### Where to get USDC

| Source | Chain | Notes |
|--------|-------|-------|
| [Coinbase](https://coinbase.com) | Base (native) | Cheapest — withdraw directly to Base |
| [Binance](https://binance.com) | Solana | Withdraw as USDC-SPL |
| [Jupiter](https://jup.ag) | Solana | Swap any Solana token → USDC |
| [Aerodrome](https://aerodrome.finance) | Base | Swap ETH/USDC on Base |
| [Uniswap](https://app.uniswap.org) | Base | Swap on Base network |

## Commands

| Command | Description |
|---------|-------------|
| `runcode` | Start the agent (interactive model picker) |
| `runcode -m <model>` | Start with a specific model |
| `runcode --trust` | Start in trust mode (no permission prompts) |
| `runcode --debug` | Start with debug logging |
| `runcode setup [base\|solana]` | Create payment wallet for Base or Solana |
| `runcode base` | Switch to Base chain |
| `runcode solana` | Switch to Solana chain |
| `runcode balance` | Check USDC balance |
| `runcode models` | List all models with pricing |
| `runcode stats` | View usage statistics and savings |
| `runcode config list` | View configuration |
| `runcode proxy` | Run as payment proxy for Claude Code |
| `runcode init` | Auto-configure Claude Code + LaunchAgent |
| `runcode uninit` | Remove Claude Code proxy config |

### Session Commands

| Command | Description |
|---------|-------------|
| `/model` | Interactive model picker |
| `/model <name>` | Switch model (shortcut or full ID) |
| `/cost` | Show session cost and savings |
| `/help` | List all commands |
| `/exit` | Quit |

## Architecture

```
src/
├── agent/                  # Core agent loop, LLM client, token optimization
├── tools/                  # 10 built-in tools (read, write, edit, bash, ...)
├── ui/                     # Terminal UI + model picker
├── proxy/                  # Payment proxy for Claude Code
├── router/                 # Smart model routing
├── commands/               # CLI commands (setup, balance, stats, ...)
├── wallet/                 # Wallet management
├── stats/                  # Usage tracking
├── config.ts               # Global configuration
└── index.ts                # Entry point
```

## Development

```bash
git clone https://github.com/BlockRunAI/runcode.git
cd runcode
npm install
npm run build
node dist/index.js --help
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[Apache License 2.0](LICENSE)

## Links

- [BlockRun](https://blockrun.ai) — The AI gateway
- [x402 Protocol](https://x402.org) — Internet-native payments
- [npm](https://npmjs.com/package/@blockrun/runcode)
- [Telegram](https://t.me/blockrunAI)
