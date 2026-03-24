<div align="center">

<h1>brcc — BlockRun Claude Code</h1>

<p>Claude Code hits rate limits. Accounts get locked. Phone verification fails.<br>
You're paying $200/month and still can't work.<br><br>
<strong>brcc removes all of that. Any model. No limits. Pay what you use.</strong></p>

<br>

<img src="https://img.shields.io/badge/🚀_No_Rate_Limits-black?style=for-the-badge" alt="No rate limits">&nbsp;
<img src="https://img.shields.io/badge/🔑_No_Account_Needed-blue?style=for-the-badge" alt="No account">&nbsp;
<img src="https://img.shields.io/badge/🤖_40+_Models-yellow?style=for-the-badge" alt="40+ models">&nbsp;
<img src="https://img.shields.io/badge/💰_Pay_Per_Use-purple?style=for-the-badge" alt="Pay per use">&nbsp;
<img src="https://img.shields.io/badge/⛓_Base_+_Solana-green?style=for-the-badge" alt="Base + Solana">

[![npm version](https://img.shields.io/npm/v/@blockrun/cc.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/cc)
[![npm downloads](https://img.shields.io/npm/dm/@blockrun/cc.svg?style=flat-square&color=blue)](https://npmjs.com/package/@blockrun/cc)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/brcc?style=flat-square)](https://github.com/BlockRunAI/brcc)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange?style=flat-square)](LICENSE)

[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base Network](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-9945FF?style=flat-square&logo=solana&logoColor=white)](https://solana.com)
[![BlockRun](https://img.shields.io/badge/Powered_by-BlockRun-black?style=flat-square)](https://blockrun.ai)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

> **brcc** is a local proxy that lets you run Claude Code with any LLM model — GPT-5, Claude, Gemini, DeepSeek, Grok, and 40+ more — without rate limits, without an Anthropic account, and without phone verification. You pay per request with USDC via the [x402](https://x402.org) protocol. Your wallet is your identity. Your private key never leaves your machine.

---

## Why brcc exists

Claude Code users are frustrated. Over **4,350 GitHub issue comments** about the same problems:

|  | Issue | Comments |
|--|-------|----------|
| 🔴 | ["Instantly hitting usage limits with Max subscription"](https://github.com/anthropics/claude-code/issues/16157) | 1,252 |
| 🔴 | ["Phone verification — unable to send code"](https://github.com/anthropics/claude-code/issues/34229) | 546 |
| 🔴 | ["Account disabled after payment"](https://github.com/anthropics/claude-code/issues/5088) | 145 |
| 🔴 | ["5-hour limit reached in less than 1h30"](https://github.com/anthropics/claude-code/issues/6457) | 108 |
| 🔴 | ["Rate limit reached despite Max subscription and only 16% usage"](https://github.com/anthropics/claude-code/issues/29579) | 89 |

**Every one of these people is a potential brcc user.**

brcc eliminates all of these problems:

- **No rate limits** — pay per request, use as much as you want
- **No account** — a wallet is generated locally, no signup
- **No phone verification** — USDC is your authentication
- **No region restrictions** — works everywhere, priced the same
- **No billing surprises** — transparent per-token pricing

---

## How it compares

| | Claude Max ($200/mo) | OpenRouter | **brcc** |
|--|---------------------|------------|----------|
| **Rate limits** | Constantly hit | Per-model limits | **None** |
| **Account required** | Yes + phone | Yes + email | **No** |
| **Models** | Claude only | 200+ (manual select) | **40+ (auto or manual)** |
| **Payment** | Credit card, subscription | Credit card, pre-pay | **USDC per-request** |
| **Auth** | OAuth + API key conflicts | API key | **Wallet signature** |
| **Pricing** | Opaque | Transparent | **Transparent** |
| **Runs locally** | N/A | No | **Yes (proxy)** |
| **Monthly cost** | $100-200 fixed | Varies | **$5-50 based on usage** |

---

## Quick Start

### One-line install (Linux/macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/brcc/main/install.sh | bash
```

Installs Node.js (if needed) + Claude Code + brcc + creates wallet.

### Manual install

```bash
# 1. Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# 2. Install brcc (use sudo on Linux)
sudo npm install -g @blockrun/cc  # use sudo on Linux

# 3. Create wallet
brcc setup base      # Base chain (Coinbase L2)
# or
brcc setup solana    # Solana chain

# 4. Fund your wallet with USDC (or use free models without funding)

# 5. Launch
brcc start
```

That's it. Claude Code opens with access to 40+ models, no rate limits.

---

## Choosing Models

### From the command line

```bash
brcc start                                # Default: blockrun/auto (smart routing)
brcc start --model blockrun/eco           # Cheapest capable model
brcc start --model blockrun/premium       # Best quality (Claude/GPT-5)
brcc start --model nvidia/gpt-oss-120b    # Free — no USDC needed
brcc start --model deepseek/deepseek-chat # Budget coding ($0.28/M)
brcc start --model anthropic/claude-opus-4.6  # Most capable
```

### Smart Routing Profiles

| Profile | Strategy | Savings | Best For |
|---------|----------|---------|----------|
| `blockrun/auto` | Balanced (default) | 74-100% | General use |
| `blockrun/eco` | Cheapest possible | 95-100% | Maximum savings |
| `blockrun/premium` | Best quality | 0% | Mission-critical |
| `blockrun/free` | Free tier only | 100% | Zero cost |

**In-session switching:**
```
use auto      # Switch to smart routing
use eco       # Switch to cheapest
use premium   # Switch to best quality
use free      # Switch to free models
```

### Inside Claude Code

Use `/model` to switch between Sonnet, Opus, and Haiku. Each maps to the BlockRun model you've configured:

```bash
# Customize what each /model option routes to
brcc config set sonnet-model anthropic/claude-sonnet-4.6    # default
brcc config set opus-model anthropic/claude-opus-4.6        # default
brcc config set haiku-model deepseek/deepseek-chat          # cheap alternative
```

### List all models

```bash
$ brcc models

Free Models (no USDC needed)
──────────────────────────────────────────────────────────────────────
  nvidia/gpt-oss-120b
  nvidia/gpt-oss-20b

Paid Models
──────────────────────────────────────────────────────────────────────
  Model                               Input        Output
  deepseek/deepseek-chat              $0.28/M      $0.42/M
  anthropic/claude-haiku-4.5          $1.00/M      $5.00/M
  openai/gpt-5.4                      $2.50/M      $15.00/M
  anthropic/claude-sonnet-4.6         $3.00/M      $15.00/M
  anthropic/claude-opus-4.6           $5.00/M      $25.00/M
  ... (31 models total)
```

---

## What $5 Gets You

| Model | ~Requests per $5 | Best For |
|-------|-------------------|----------|
| DeepSeek V3 | ~5,000 | Budget coding |
| Claude Haiku 4.5 | ~500 | Fast tasks |
| Claude Sonnet 4.6 | ~100 | General coding |
| GPT-5.4 | ~80 | Reasoning |
| Claude Opus 4.6 | ~50 | Most capable |
| GPT-OSS 120B | **Unlimited** | Free tier |

---

## Commands

| Command | Description |
|---------|-------------|
| `brcc setup [base\|solana]` | Create wallet for payments |
| `brcc start [--model <id>]` | Start proxy + launch Claude Code |
| `brcc models` | List all models with pricing |
| `brcc balance` | Check wallet USDC balance |
| `brcc stats` | View usage statistics and savings |
| `brcc config set <key> <value>` | Configure model mappings |
| `brcc config list` | View current settings |

### `brcc setup`

```bash
brcc setup          # Default: Base chain
brcc setup base     # Coinbase L2 — low fees, fast
brcc setup solana   # Solana — also low fees, fast
```

Your wallet is saved to `~/.blockrun/` and shared with all BlockRun tools.

### `brcc start`

```bash
brcc start                              # Default model
brcc start --model nvidia/gpt-oss-120b  # Free model
brcc start --model openai/gpt-5.4       # Specific model
brcc start --no-launch                  # Proxy only mode
brcc start --no-fallback                # Disable auto-fallback
brcc start -p 9000                      # Custom port
```

### `brcc stats`

View your usage statistics and cost savings:

```bash
$ brcc stats

📊 brcc Usage Statistics

───────────────────────────────────────────────────────────

  Overview (7 days)

    Requests:       1,234
    Total Cost:     $4.5672
    Avg per Request: $0.003701
    Input Tokens:   2,456,000
    Output Tokens:  892,000
    Fallbacks:      23 (1.9%)

  By Model

    anthropic/claude-sonnet-4.6
      450 req · $2.1340 (46.7%) · 245ms avg
    deepseek/deepseek-chat
      620 req · $0.8901 (19.5%) · 180ms avg
      ↳ 12 fallback recoveries
    nvidia/gpt-oss-120b
      164 req · $0.0000 (0%) · 320ms avg

  💰 Savings vs Claude Opus

    Opus equivalent: $34.62
    Your actual cost: $4.57
    Saved: $30.05 (86.8%)

───────────────────────────────────────────────────────────
  Run `brcc stats --clear` to reset statistics

$ brcc stats --clear   # Reset all statistics
$ brcc stats --json    # Output as JSON (for scripts)
```

### `brcc config`

```bash
brcc config set default-model nvidia/gpt-oss-120b
brcc config set sonnet-model openai/gpt-5.4
brcc config set opus-model anthropic/claude-opus-4.6
brcc config set haiku-model deepseek/deepseek-chat
brcc config list
```

---

## Automatic Fallback

When a model returns an error (429 rate limit, 500+ server error), brcc automatically retries with backup models. This ensures your work never stops.

**Default fallback chain:**
```
anthropic/claude-sonnet-4.6
    ↓ (if 429/500/502/503/504)
google/gemini-2.5-pro
    ↓
deepseek/deepseek-chat
    ↓
xai/grok-4-fast
    ↓
nvidia/gpt-oss-120b (free, always available)
```

**How it looks:**
```
[brcc] ⚠️  anthropic/claude-sonnet-4.6 returned 429, falling back to google/gemini-2.5-pro
[brcc] ↺ Fallback successful: using google/gemini-2.5-pro
```

To disable fallback:
```bash
brcc start --no-fallback
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code                                                 │
│  (thinks it's talking to Anthropic)                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ Anthropic Messages API format
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  brcc proxy (localhost:8402)                                 │
│                                                              │
│  1. Receives request from Claude Code                        │
│  2. Replaces model name (if --model set)                    │
│  3. Signs x402 USDC payment with your wallet                │
│  4. Forwards to BlockRun API                                │
│  5. Streams response back to Claude Code                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ + x402 payment signature
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  BlockRun API (blockrun.ai or sol.blockrun.ai)              │
│                                                              │
│  Routes to: GPT-5 · Claude · Gemini · DeepSeek · Grok ·    │
│             NVIDIA · MiniMax · Moonshot · 40+ models         │
└─────────────────────────────────────────────────────────────┘
```

Your private key stays on your machine. Only payment signatures are sent.

---

## Funding Your Wallet

brcc uses USDC — a dollar-pegged stablecoin. No crypto volatility.

**Base chain (default):**
1. Buy USDC on [Coinbase](https://coinbase.com)
2. Send to your brcc wallet address (shown in `brcc setup`)
3. Make sure it's on **Base** network (not Ethereum mainnet)

**Solana chain:**
1. Buy USDC on any exchange
2. Send to your brcc Solana address
3. Send on **Solana** network

Typical cost: **$0.001–$0.05 per interaction**. $5 lasts most developers a week.

---

## FAQ

**Do I need an Anthropic account?**
No. brcc connects Claude Code to BlockRun instead of Anthropic.

**Can I use non-Claude models?**
Yes. GPT-5, Gemini, DeepSeek, Grok, and 30+ others work through Claude Code via brcc.

---

## Links

- [BlockRun](https://blockrun.ai) — The AI gateway powering brcc
- [npm package](https://npmjs.com/package/@blockrun/cc)
- [Roadmap](docs/ROADMAP.md)
- [Telegram](https://t.me/blockrunAI)
- [GitHub Issues](https://github.com/BlockRunAI/brcc/issues)

## License

[Business Source License 1.1](LICENSE) — Free to use, modify, and deploy. Cannot be used to build a competing hosted service. Converts to MIT in 2030.
