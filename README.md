# brcc — BlockRun Claude Code

Run Claude Code with any LLM model. Pay per use with Solana USDC.

```
brcc start
```

One command: starts a local payment proxy, launches Claude Code, routes to any model via [BlockRun](https://blockrun.ai).

## How it works

```
Claude Code → localhost:8402 (brcc proxy, signs x402 payments)
            → sol.blockrun.ai/api/v1/messages
            → Any model (GPT-5, Gemini, DeepSeek, Claude, Grok, ...)
```

brcc runs a local HTTP proxy that intercepts Claude Code's API requests, automatically signs [x402](https://x402.org) micropayments with your Solana wallet, and forwards to BlockRun's API gateway. No API keys needed — just USDC.

## Install

```bash
npm install -g brcc
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Node.js 18+.

## Quick start

```bash
# 1. Generate a Solana wallet
brcc setup

# 2. Fund it — send USDC (Solana) + small amount of SOL for fees to the displayed address

# 3. Check balance
brcc balance

# 4. Launch Claude Code with BlockRun
brcc start
```

That's it. Claude Code opens with access to all BlockRun models.

## Commands

### `brcc setup`

Generates a new Solana wallet and saves it to `~/.brcc/wallet.json`. Displays the wallet address for funding.

```
$ brcc setup
Generating new Solana wallet...

Wallet created!

Address: CBDCZyq1hUca2GasD36bQTnfBt9KakkZjPKUieBFtSqo

Send USDC (Solana) to this address to fund your account.
Then run brcc start to launch Claude Code.
```

### `brcc start`

Starts the x402 payment proxy and launches Claude Code.

```bash
brcc start              # Start proxy + launch Claude Code
brcc start --no-launch  # Start proxy only (set env vars manually)
brcc start -p 9000      # Use custom port
```

In proxy-only mode, set these env vars in your shell:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8402/api
export ANTHROPIC_API_KEY=brcc
claude
```

### `brcc balance`

Shows your wallet's USDC and SOL balances.

```
$ brcc balance
Wallet: CBDCZyq1hUca2GasD36bQTnfBt9KakkZjPKUieBFtSqo

USDC Balance: $12.50
SOL Balance:  0.0050 SOL
```

## Available models

All models on [BlockRun](https://blockrun.ai) are available, including:

| Model | Provider |
|-------|----------|
| GPT-5.4 | OpenAI |
| Claude Opus 4.6 | Anthropic |
| Claude Sonnet 4.6 | Anthropic |
| Gemini 2.5 Pro | Google |
| DeepSeek V3 | DeepSeek |
| Grok | xAI |
| GPT-OSS 120B | NVIDIA (free) |

See full list: `curl https://sol.blockrun.ai/api/v1/models`

## Pricing

Pay-per-use via x402 micropayments. Prices match upstream provider rates + 5% platform fee. No subscriptions, no accounts, no API keys.

Free models (like `nvidia/gpt-oss-120b`) require no payment.

## How x402 payment works

1. Claude Code sends a request through the brcc proxy
2. Proxy forwards to `sol.blockrun.ai`
3. If the model requires payment, the server returns `402 Payment Required` with pricing
4. Proxy automatically signs a USDC transfer using your wallet
5. Proxy retries the request with the signed payment
6. Server verifies payment, processes the request, settles on-chain

All payments are USDC on Solana mainnet. Typical cost: $0.001–$0.05 per request depending on model and token count.

## Config

Wallet and config are stored in `~/.brcc/`:

```
~/.brcc/
├── wallet.json    # Solana keypair (chmod 600)
└── config.json    # Settings (future)
```

## Security

- Wallet private key is stored locally in `~/.brcc/wallet.json` with `600` permissions
- The proxy runs on localhost only — not exposed to the network
- Payments are signed locally, never sending your private key over the network

## License

MIT
