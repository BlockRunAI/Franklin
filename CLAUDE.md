# Franklin

**The AI agent with a wallet.**

Franklin is the first AI agent in the **Autonomous Economic Agent** category — it doesn't just write text, it autonomously spends USDC from a user-funded wallet to execute real work: marketing campaigns, trading signals, content generation.

Two products under one brand:
- **franklin.run** — Marketing agent (campaigns, content, outreach)
- **franklin.bet** — Trading agent (signals, research, risk)

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
├── index.ts                # CLI entry point (franklin + runcode alias)
├── banner.ts               # FRANKLIN ASCII banner
├── agent/                  # Agent loop, LLM client, compaction, commands
├── tools/                  # 12 built-in tools (Read/Write/Edit/Bash/Grep/...)
├── plugin-sdk/             # Public plugin contract (Workflow / Channel / Plugin)
├── plugins/                # Plugin registry + runner (plugin-agnostic core)
├── plugins-bundled/        # Plugins ship with Franklin (social, marketing)
├── session/                # Persistent sessions + full-text search
├── stats/                  # Usage tracking + insights engine
├── ui/                     # Ink-based terminal UI
├── proxy/                  # Payment proxy for Claude Code compatibility
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
- npm registry: `@blockrun/franklin` (primary), `@blockrun/runcode` (deprecated alias)
- Binary commands: `franklin` (primary), `runcode` (60-day alias)

## Positioning

**Franklin runs your money.** Every feature decision should be tested against this positioning:

- Does it make Franklin more of "the agent with a wallet"? → yes
- Does it dilute us back to "another coding tool"? → no

The moat is the payment layer. The category is Autonomous Economic Agent. The verticals are marketing (franklin.run) and trading (franklin.bet). Everything else is execution.
