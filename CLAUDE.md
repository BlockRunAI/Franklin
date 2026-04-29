# Franklin

**The AI agent with a wallet.**

Franklin is the first AI agent in the **Autonomous Economic Agent** category — it doesn't just write text, it autonomously spends USDC from a user-funded wallet to execute real work: coding, trading, content generation.

Three verticals under one brand:
- **Dev agent** — coding, debugging, review across 55+ models with wallet-bound spending
- **Trading agent** — signals, portfolio, risk, persistent P&L across sessions
- **Content agent** — ImageGen, VideoGen, budget-tracked media production

Built on three layers:
1. **x402 micropayment protocol** — HTTP 402 native payments
2. **BlockRun Gateway** — aggregates 55+ LLMs + paid APIs (Exa, DALL-E, future Runway/Suno/CoinGecko)
3. **Franklin Agent** — this repo, the reference client

## Commands

```bash
npm install              # install dependencies
npm run build            # compile TypeScript + copy plugin assets
npm run dev              # watch mode
npm start                # launch agent
npm test                 # local test suite (no API calls)
npm run test:e2e         # end-to-end tests (hits real models, needs wallet funding)
```

## Project structure

```
src/
├── index.ts                # CLI entry point (franklin)
├── banner.ts               # FRANKLIN ASCII banner
├── agent/                  # Agent loop, LLM client, compaction, commands
├── tools/                  # 12 built-in tools (Read/Write/Edit/Bash/Grep/...)
├── plugin-sdk/             # Public plugin contract (Workflow / Channel / Plugin)
├── plugins/                # Plugin registry + runner (plugin-agnostic core)
├── plugins-bundled/        # Plugins ship with Franklin
├── session/                # Persistent sessions + full-text search
├── stats/                  # Usage tracking + insights engine
├── ui/                     # Ink-based terminal UI
├── proxy/                  # Payment proxy for Anthropic-compatible CLI agents
├── router/                 # Smart model tier routing (free/cheap/premium)
├── wallet/                 # Base + Solana wallet management
├── commands/               # CLI subcommands
└── mcp/                    # MCP server integration (auto-discovery)
```

## Key dependencies

- `@blockrun/llm` — LLM gateway SDK with x402 payment handling
- `@modelcontextprotocol/sdk` — MCP protocol for extensible tools
- `ink` / `react` — Terminal UI framework
- `commander` — CLI argument parsing

## Conventions

- TypeScript strict mode
- ESM (`"type": "module"`)
- Node >= 20
- Apache-2.0 license
- npm registry: `@blockrun/franklin`
- Binary command: `franklin`

## Positioning

**Franklin runs your money.** Three layers, from external to internal:

| Layer | Message | Audience |
|-------|---------|----------|
| External (X, YouTube, KOL) | **The AI Agent with a Wallet** — it holds your USDC and actually spends it for you | Everyone |
| Core users / docs | **Autonomous Economic Agent** powered by x402 payment layer | Developers, crypto AI community |
| Product direction | **Dev + Trading + Content** — scenarios where spending money = value | Power users |

Every feature decision should be tested against this positioning:

- Does it make Franklin more of "the agent with a wallet"? → yes
- Does it dilute us back to "another coding tool"? → no

The moat is the payment layer. The category is Autonomous Economic Agent. The verticals are Dev, Trading, and Content. Coding intelligence is table stakes — necessary but not the differentiator.

**What sets Franklin apart:**
- Most coding agents write great code but can't spend money to buy APIs, data, or ads
- Memory-focused agents have strong recall but no wallet or economic autonomy
- Franklin: you fund the wallet, it decides what's worth spending on
