<p align="center">
  <br>
  <code>
  ██████╗ ██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗
 ██╔═████╗╚██╗██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║██╔██║ ╚███╔╝ ██║     ██║   ██║██║  ██║█████╗
 ████╔╝██║ ██╔██╗ ██║     ██║   ██║██║  ██║██╔══╝
 ╚██████╔╝██╔╝ ██╗╚██████╗╚██████╔╝██████╔╝███████╗
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
  </code>
</p>

<div align="center">

<h1>0xcode</h1>

<p><strong>Open-source AI coding agent. 41+ models. Pay per use with USDC.</strong></p>

<br>

[![npm version](https://img.shields.io/npm/v/@blockrun/0xcode.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/@blockrun/0xcode)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![x402](https://img.shields.io/badge/x402-Payments-purple?style=flat-square)](https://x402.org)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

</div>

---

0xcode is a terminal-based AI coding agent that connects to 41+ LLM models through [BlockRun](https://blockrun.ai). It reads your code, edits files, runs commands, searches the web, and manages tasks — all from your terminal. You pay per request with USDC via the [x402](https://x402.org) protocol. No API keys, no accounts, no subscriptions.

## Quick Start

```bash
npm install -g @blockrun/0xcode
0xcode setup base     # Create a wallet (one-time)
0xcode                # Launch — picks model interactively
```

That's it. Fund the wallet address with USDC on Base, or use free models immediately.

## Features

### Agent Capabilities

0xcode is a full coding agent with 10 built-in tools:

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
0xcode                          # Interactive picker
0xcode -m sonnet                # Claude Sonnet 4.6
0xcode -m gpt                   # GPT-5.4
0xcode -m deepseek              # DeepSeek V3
0xcode -m free                  # Nemotron Ultra 253B (free)
```

Switch models mid-session:

```
/model              # Interactive picker
/model flash        # Switch to Gemini 2.5 Flash
/cost               # Check session cost
```

**30+ shortcuts:**

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
| `free` | Nemotron Ultra 253B | FREE |
| `devstral` | Devstral 2 123B | FREE |
| `qwen-coder` | Qwen3 Coder 480B | FREE |
| `maverick` | Llama 4 Maverick | FREE |

### Token Optimization

Seven layers of automatic optimization keep context usage low and costs down:

1. **Thinking block stripping** — removes old reasoning from history
2. **Tool result budgeting** — caps large outputs at 50K chars with preview
3. **Microcompaction** — clears old tool results (keeps last 8)
4. **Time-based cleanup** — clears stale results after 60min idle
5. **Auto-compact** — summarizes history when approaching context limit
6. **Adaptive max_tokens** — starts at 8K, escalates to 64K on demand
7. **Prompt-too-long recovery** — auto-compacts and retries up to 3x

### Permission System

By default, read-only tools run automatically. Destructive tools (Write, Edit, Bash) prompt for permission:

```
  Permission required: Bash
  Execute: rm -rf node_modules

  Allow? [y]es / [n]o / [a]lways:
```

Use `--trust` to skip all prompts:

```bash
0xcode --trust
```

Configure rules in `~/.blockrun/0xcode-permissions.json`:

```json
{
  "allow": ["Bash(git *)"],
  "deny": ["Bash(rm -rf *)"]
}
```

### Streaming Tool Execution

Concurrent-safe tools (Read, Glob, Grep) start executing while the model is still streaming. Sequential tools (Write, Edit, Bash) wait for the full response. This reduces latency on multi-tool turns.

### Proxy Mode

0xcode also includes a proxy mode for use with Claude Code or other tools:

```bash
0xcode proxy                    # Start payment proxy on :8402
0xcode proxy -m deepseek        # With default model
0xcode init                     # Auto-configure Claude Code + LaunchAgent
```

## Architecture

```
User input → 0xcode CLI
  → Terminal UI (markdown rendering, model picker, spinners)
  → Permission check (allow / deny / ask)
  → Agent loop
    → Token optimization pipeline
    → BlockRun API (direct, with x402 payment)
      → 41+ models (Claude, GPT, Gemini, DeepSeek, Grok, ...)
    → Streaming tool execution
    → Context compaction (when needed)
  → Loop until task complete
```

```
src/
├── agent/                  # Core agent system
│   ├── loop.ts             # Agent loop + interactive session
│   ├── llm.ts              # API client + x402 payment + SSE parsing
│   ├── types.ts            # Type definitions
│   ├── context.ts          # System prompt assembly
│   ├── tokens.ts           # Token estimation
│   ├── compact.ts          # Auto-compaction
│   ├── optimize.ts         # 5-layer token optimization
│   ├── permissions.ts      # Tool permission system
│   └── streaming-executor.ts # Parallel tool execution
├── tools/                  # 10 built-in tools
│   ├── read.ts, write.ts, edit.ts, bash.ts
│   ├── glob.ts, grep.ts
│   ├── webfetch.ts, websearch.ts
│   ├── subagent.ts, task.ts
│   └── index.ts
├── ui/                     # Terminal interface
│   ├── terminal.ts         # Streaming output + markdown
│   └── model-picker.ts     # Interactive model selection
├── proxy/                  # Proxy mode (for Claude Code)
│   ├── server.ts           # HTTP proxy + payment handling
│   ├── fallback.ts         # Auto-fallback chain
│   └── sse-translator.ts   # OpenAI → Anthropic format
├── router/                 # Smart routing engine
│   └── index.ts
├── commands/               # CLI commands
├── config.ts               # Global configuration
└── index.ts                # Entry point
```

## Commands

| Command | Description |
|---------|-------------|
| `0xcode` | Start the agent (interactive model picker) |
| `0xcode -m <model>` | Start with a specific model |
| `0xcode --trust` | Start in trust mode (no permission prompts) |
| `0xcode --debug` | Start with debug logging |
| `0xcode setup [base\|solana]` | Create payment wallet |
| `0xcode balance` | Check USDC balance |
| `0xcode models` | List all models with pricing |
| `0xcode stats` | View usage statistics and savings |
| `0xcode config list` | View configuration |
| `0xcode proxy` | Run as payment proxy for Claude Code |

### Session Commands

| Command | Description |
|---------|-------------|
| `/model` | Interactive model picker |
| `/model <name>` | Switch model (shortcut or full ID) |
| `/models` | Same as `/model` |
| `/cost` | Show session cost and savings |
| `/help` | List all commands |
| `/exit` | Quit |

## Payment

0xcode uses the [x402](https://x402.org) protocol for pay-per-request payments with USDC stablecoins. No accounts, no API keys, no subscriptions.

**Supported chains:**
- **Base** (default) — Coinbase L2, low fees
- **Solana** — also low fees

**Setup:**

```bash
0xcode setup base     # or: 0xcode setup solana
```

Fund the wallet address with USDC. Free models work without funding.

**What does it cost?**

| Model | ~Cost per request |
|-------|-------------------|
| Free models (Nemotron, etc.) | $0 |
| DeepSeek V3 | ~$0.001 |
| Gemini Flash | ~$0.001 |
| Claude Sonnet | ~$0.01 |
| GPT-5.4 | ~$0.01 |
| Claude Opus | ~$0.05 |

Typical usage: **$5-20/month** for active development.

## Development

```bash
git clone https://github.com/BlockRunAI/brcc.git
cd brcc
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
- [npm](https://npmjs.com/package/@blockrun/0xcode)
- [Telegram](https://t.me/blockrunAI)
