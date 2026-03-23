# brcc

**Run Claude Code without rate limits.**

Hitting usage limits? Account disabled? Can't verify your phone? brcc fixes all of that.

```bash
npm install -g @blockrun/cc
brcc start
```

One command. No Anthropic account needed. No rate limits. No phone verification. Just USDC.

## The Problem

Claude Code users hit these walls daily ([4,350+ GitHub issue comments](https://github.com/anthropics/claude-code/issues)):

- **"Instantly hitting usage limits with Max subscription"** — 1,252 comments
- **"Account disabled after payment"** — 145 comments
- **"Phone verification — unable to send code"** — 546 comments
- **"5-hour limit reached in less than 1h30"** — 108 comments
- **"Rate limit reached despite Max subscription"** — 89 comments

## The Fix

brcc routes Claude Code through [BlockRun](https://blockrun.ai), a pay-per-use AI gateway. You pay exactly what you use — no subscriptions, no limits, no accounts.

```
Claude Code  -->  brcc (local proxy)  -->  BlockRun API  -->  Any model
                  auto-signs payments      40+ models         GPT-5, Claude, Gemini, ...
                  with your wallet         pay per token
```

## Quick Start

### One-line install (Linux/macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/brcc/main/install.sh | bash
```

Installs Node.js (if missing) + Claude Code + brcc + creates wallet.

### Manual install

```bash
# Prerequisites: Node.js 20+ and Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# Install brcc (use sudo on Linux)
npm install -g @blockrun/cc

# Create a wallet (one time)
brcc setup
# -> Wallet created: 0xCC8c...5EF8
# -> Send USDC on Base to this address

# Fund your wallet
# Send $5-10 USDC on Base chain to your wallet address
# Buy USDC on Coinbase, send directly to your address

# Launch Claude Code
brcc start
```

That's it. Claude Code opens with access to 40+ models, no rate limits.

## What $5 Gets You

| Model | ~Requests per $5 | Best For |
|-------|-------------------|----------|
| Claude Sonnet 4.6 | ~100 | Coding (default) |
| GPT-5.4 | ~80 | Reasoning |
| Claude Haiku 4.5 | ~500 | Fast tasks |
| DeepSeek V3 | ~5,000 | Budget coding |
| GPT-OSS 120B | Unlimited | Free tier |

## Why brcc vs Claude Max Subscription

| | Claude Max ($100-200/mo) | brcc |
|--|--------------------------|------|
| **Rate limits** | Constantly hit | None |
| **Account locks** | Common | Impossible — no account |
| **Phone verification** | Required | Not needed |
| **Pricing** | Opaque, subscription | Transparent, pay-per-token |
| **Region restrictions** | Some countries blocked | Works everywhere |
| **Models** | Claude only | 40+ models (GPT, Gemini, DeepSeek...) |
| **Monthly cost** | $100-200 fixed | $5-50 based on usage |
| **Auth issues** | OAuth, API key conflicts | Wallet = identity |

## Commands

### `brcc setup`

Creates a wallet and shows the address for funding.

```bash
brcc setup          # Default: Base chain
brcc setup base     # Explicit Base (Coinbase L2)
brcc setup solana   # Solana chain
```

```
$ brcc setup base
Wallet created!
Address: 0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8
Send USDC on Base to this address to fund your account.
Chain: base — saved to ~/.blockrun/
```

Your wallet is saved to `~/.blockrun/` and shared with all BlockRun tools (Python SDK, TS SDK, ClawRouter).

### `brcc start`

Starts the payment proxy and launches Claude Code.

```
$ brcc start
brcc — BlockRun Claude Code

Wallet:  0xCC8c...5EF8
Proxy:   http://localhost:8402
Backend: https://blockrun.ai/api

Starting Claude Code...
```

Options:
```bash
brcc start                              # Default model (Sonnet 4.6)
brcc start --model nvidia/gpt-oss-120b  # Free model
brcc start --model openai/gpt-5.4      # GPT-5.4
brcc start --model deepseek/deepseek-chat  # Budget option
brcc start --no-launch                  # Proxy only
brcc start -p 9000                      # Custom port
```

Inside Claude Code, use `/model` to switch between Sonnet, Opus, and Haiku — each maps to the BlockRun model you configured.

### `brcc models`

List all available models with pricing.

```
$ brcc models
Available Models

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
  ...
```

### `brcc config`

Customize model mappings for Claude Code's `/model` picker.

```bash
# Map Claude Code's "Haiku" to a cheap model
brcc config set haiku-model deepseek/deepseek-chat

# Map "Sonnet" to GPT-5.4
brcc config set sonnet-model openai/gpt-5.4

# Set default model
brcc config set default-model nvidia/gpt-oss-120b

# View all settings
brcc config list
```

### `brcc balance`

Check your USDC balance.

```
$ brcc balance
Wallet: 0xCC8c44AD3dc2A58D841c3EB26131E49b22665EF8
USDC Balance: $4.17
```

## How It Works

1. `brcc start` launches a local HTTP proxy on port 8402
2. Claude Code connects to the proxy (via `ANTHROPIC_BASE_URL`)
3. When Claude Code makes an API request, the proxy forwards it to BlockRun
4. If payment is needed, the proxy automatically signs a USDC micropayment
5. BlockRun processes the request and returns the response
6. Claude Code gets the response as normal

Your private key never leaves your machine. Only payment signatures are sent.

## Funding Your Wallet

brcc uses USDC on Base (Coinbase's L2 chain). To fund:

1. **Buy USDC** on [Coinbase](https://coinbase.com), [Binance](https://binance.com), or any exchange
2. **Send USDC** to your brcc wallet address (shown in `brcc setup`)
3. **Make sure it's on Base chain** — not Ethereum mainnet

Typical cost: $0.001-0.05 per Claude Code interaction. $5 lasts most developers a week.

## Available Models

All [BlockRun models](https://blockrun.ai) work through brcc:

- **OpenAI**: GPT-5.4, GPT-5.2, GPT-5-mini, o3, o4-mini
- **Anthropic**: Claude Opus 4.6, Sonnet 4.6, Haiku 4.5
- **Google**: Gemini 3.1 Pro, 2.5 Pro, 2.5 Flash
- **DeepSeek**: V3, Reasoner
- **xAI**: Grok 3, Grok 4
- **Free**: NVIDIA GPT-OSS 120B (no payment needed)

## FAQ

**Q: Is this legal?**
A: Yes. brcc is an API proxy. You're using Claude Code (Anthropic's open CLI) with a different API backend. OpenRouter, LiteLLM, and others do the same thing. No Anthropic terms are violated because no Anthropic services are used.

**Q: Do I need an Anthropic account?**
A: No. brcc bypasses Anthropic entirely. You don't need an Anthropic account, API key, or subscription.

**Q: Is my wallet safe?**
A: Your private key stays on your machine (`~/.blockrun/.session`, chmod 600). It's only used for local signing — never transmitted over the network.

**Q: What if BlockRun goes down?**
A: Your wallet and funds are yours on-chain. USDC is always withdrawable regardless of BlockRun's status.

**Q: Can I use models other than Claude?**
A: Yes. Claude Code works with any model that speaks the Anthropic Messages API format. Through brcc, you can use GPT-5, Gemini, DeepSeek, and 30+ other models.

## Links

- [BlockRun](https://blockrun.ai) — The AI gateway powering brcc
- [BlockRun TypeScript SDK](https://www.npmjs.com/package/@blockrun/llm)
- [Telegram](https://t.me/+mroQv4-4hGgzOGUx)
- [GitHub Issues](https://github.com/BlockRunAI/brcc/issues)

## License

[Business Source License 1.1](LICENSE) — Free to use, modify, and deploy. Cannot be used to build a competing hosted service. Converts to MIT in 2030.
