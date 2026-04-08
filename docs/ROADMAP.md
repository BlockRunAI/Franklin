# RunCode Roadmap

## What RunCode Is

RunCode is an open-source AI coding agent. 55+ models. Pay per use with USDC. No accounts, no subscriptions, no rate limits.

**Current version:** 2.5.31

```
runcode
  │
  ├── Standalone AI coding agent
  │     ├── Ink-based terminal UI (React for terminal)
  │     ├── 11 built-in tools
  │     │     Read, Write, Edit, Bash, Glob, Grep,
  │     │     WebFetch, WebSearch, Task, ImageGen, AskUser
  │     ├── 45 slash commands
  │     │     /model, /compact, /ultrathink, /ultraplan,
  │     │     /commit, /pr, /plan, /execute, /history, /resume...
  │     ├── MCP server integration
  │     │     blockrun (built-in), unbrowse (built-in),
  │     │     + user-configured servers via ~/.blockrun/mcp.json
  │     ├── Sub-agent spawning for parallel work
  │     └── Session persistence (JSONL) + /resume
  │
  ├── Smart router
  │     ├── 15-dimension weighted classifier
  │     ├── 4 profiles: auto, eco, premium, free
  │     ├── 4 tiers: SIMPLE → MEDIUM → COMPLEX → REASONING
  │     └── Automatic fallback chains per tier
  │
  ├── Proxy mode (for Claude Code + other tools)
  │     ├── localhost:8402, x402 payment signing
  │     ├── In-session model switching (last-message detection)
  │     ├── Daemon mode (background process)
  │     └── LaunchAgent auto-start on macOS
  │
  └── Payment (USDC via x402 protocol)
        ├── Base (Ethereum L2) — default
        ├── Solana — alternative
        └── No account, no subscription, no rate limits
```

---

## What's Shipped (v2.5.31)

### Models

55+ models across 9 providers. Switch mid-conversation with `/model`.

| Provider | Models | Pricing |
|----------|--------|---------|
| Anthropic | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 (4 models) | $1-25/1M tokens |
| OpenAI | GPT-5.4, 5.3 Codex, 5.2, 5 Mini, 5 Nano, 4.1, O3, O4 Mini, O1 (18 models) | $0.05-180/1M tokens |
| Google | Gemini 3.1 Pro, 3 Pro/Flash Preview, 2.5 Pro, 2.5 Flash, Flash Lite (6 models) | $0.10-12/1M tokens |
| xAI | Grok 4, Grok 3, Grok 3 Mini, Grok 2 Vision, Grok Fast Reasoning (8 models) | $0.20-15/1M tokens |
| DeepSeek | DeepSeek V3, DeepSeek Reasoner (2 models) | $0.28-0.42/1M tokens |
| Minimax | Minimax M2.7, M2.5 (2 models) | $0.30-1.2/1M tokens |
| Moonshot | Kimi K2.5 (1 model) | $0.60-3/1M tokens |
| Zhipu AI | GLM-5.1, GLM-5.1 Turbo (2 models) | $0.001/call (promo) |
| NVIDIA (free) | Nemotron Ultra 253B, GPT-OSS 120B/20B, DeepSeek V3.2, Qwen3 Coder, Devstral 2, Maverick, Mistral Large 3, GLM-4.7 (11 models) | **$0.00** |

### Agent Tools

| Tool | What it does | Concurrent |
|------|-------------|------------|
| Read | Read files with line ranges | Yes |
| Write | Create new files | No (permission required) |
| Edit | Modify files with replacements | No (permission required) |
| Bash | Execute shell commands (30s timeout, 32KB output cap) | No (permission required) |
| Glob | Find files by pattern | Yes |
| Grep | Search file contents with regex | Yes |
| WebFetch | Fetch URL, convert HTML to markdown | Yes |
| WebSearch | Real-time web + X/Twitter + news search | Yes |
| Task | In-session task management | Yes |
| ImageGen | Generate images (DALL-E 3, Flux) | Yes |
| AskUser | Interactive question dialog | No |
| SubAgent | Spawn child agents for parallel work | No |

### Slash Commands (45)

**Session:** `/clear`, `/compact`, `/history`, `/sessions`, `/resume <id>`, `/delete <exchanges>`, `/retry`, `/exit`

**Model:** `/model` (show current), `/model <name>` (switch), `/model` (interactive picker with 16 models)

**Modes:** `/plan` (read-only), `/execute` (normal), `/ultrathink` (deep reasoning), `/ultraplan` (deep planning), `/dump` (show system prompt)

**Git:** `/status`, `/diff`, `/log`, `/undo`, `/stash`, `/unstash`, `/commit`, `/push`, `/pr`, `/review`, `/branch`

**Code:** `/fix`, `/debug`, `/test`, `/init`, `/todo`, `/deps`, `/optimize`, `/security`, `/lint`, `/migrate`, `/clean`, `/tasks`

**Info:** `/help`, `/version`, `/bug`, `/tokens`, `/context`, `/cost`, `/wallet`, `/mcp`, `/doctor`

### Token Management

Multi-stage pipeline that keeps context healthy during long sessions:

1. **Optimize** — Strip thinking blocks, budget tool results, time-based cleanup
2. **Reduce** — Age old results, normalize whitespace, trim verbose messages
3. **Microcompact** — Compress history when >15 messages
4. **Auto-compact** — Summarize entire exchanges when approaching context limit
5. **Fallback** — Even more aggressive stripping if still over limit

Proactive warning at 70% context usage. Suggests `/compact`.

### Permission System

| Mode | Behavior |
|------|----------|
| `default` | Prompt for Write, Edit, Bash. Allow Read, Glob, Grep, etc. |
| `trust` | Allow all tools without prompting |
| `plan` | Read-only (no Writes, Edits, Bash) |
| `deny-all` | Block everything except read-only tools |

Interactive permission dialog: `y` (yes), `n` (no), `a` (allow all pending). Shows pending count when multiple tools queued.

### MCP Integration

- **Built-in servers** (auto-discovered if installed): `blockrun-mcp`, `unbrowse`
- **User servers**: `~/.blockrun/mcp.json` (global) + `.mcp.json` (project, requires trust)
- **Transport**: stdio (5s connection timeout, 30s per-tool timeout)
- **Naming**: `mcp__<server>__<tool>`

### Session Persistence

- JSONL format in `~/.blockrun/sessions/`
- Metadata: model, working directory, timestamps, turn count
- Auto-prune: keeps last 20 sessions
- Resume: `/resume <id>` restores full conversation

### Proxy Mode

Run RunCode as a payment proxy for Claude Code or any OpenAI-compatible tool:

```bash
runcode proxy                          # Start proxy on localhost:8402
runcode proxy --model sonnet           # Default to Claude Sonnet
runcode daemon start                   # Background daemon
runcode init                           # Auto-start on login (macOS LaunchAgent)
```

Claude Code connects via `ANTHROPIC_BASE_URL=http://localhost:8402/api`. The proxy signs x402 payments with your local wallet and forwards to BlockRun.

### Stats & Cost Tracking

- Per-request logging: model, tokens (in/out), cost, latency, fallback flag
- Per-model aggregation: requests, total cost, avg latency
- Session cost displayed live in the input bar
- `/cost` for detailed breakdown
- `runcode stats` for historical usage

---

## What's Next

### Onboarding (Priority 1)

The biggest drop-off is "Send USDC on Base." Non-crypto users stop here.

- [ ] **Fiat on-ramp integration** — Guide users through buying USDC (Coinbase, MoonPay, or similar). Show QR code + step-by-step. Target: fund wallet in under 3 minutes with a credit card.
- [ ] **First-run wizard** — Interactive setup: choose chain → create wallet → test with free model → show funding instructions only when they want a paid model.
- [ ] **Install script that works** — The current `install.sh` leaves broken state. Rewrite to: detect OS, install Node if missing, `npm install -g @blockrun/runcode`, `runcode setup`, verify `runcode` command exists.
- [ ] **Zero-config start** — `runcode` with no wallet should default to free NVIDIA models. No setup required to try it.

### Agent Quality (Priority 2)

- [ ] **Streaming Bash output** — Currently shows final result. Should stream lines as they appear (partially implemented with 500ms polling, needs real-time pipe).
- [ ] **Better auto-compact** — Current compaction loses important context. Implement selective compaction: keep recent tool results + user instructions, compress old exchanges.
- [ ] **Multi-file edit** — Single tool call that edits multiple files atomically. Reduces turn count for refactoring tasks.
- [ ] **Image understanding** — Accept image input (screenshots, diagrams) in user messages. Requires multimodal API support.
- [ ] **Thinking display** — Currently hidden. Add `/thinking` toggle to show model's reasoning (Claude Code #8477 has 193 upvotes requesting this).

### Ecosystem (Priority 3)

- [ ] **HTTP/SSE transport for MCP** — Currently stdio only. HTTP enables remote MCP servers.
- [ ] **More built-in MCP servers** — Evaluate: GitHub (issues, PRs), Slack, Linear, Notion.
- [ ] **Custom tool plugins** — User-defined tools in `~/.blockrun/tools/` without writing a full MCP server.
- [ ] **CLAUDE.md / AGENTS.md support** — Auto-load project context files (Claude Code #6235 has 3,517 upvotes).

### Team & Enterprise (Priority 4)

- [ ] **Shared wallets** — Team funds a single wallet, developers draw from it
- [ ] **Per-developer budgets** — `runcode team budget dev@example.com 50` ($50/week cap)
- [ ] **Usage dashboard** — Web UI showing per-developer cost, model usage, request patterns
- [ ] **Audit logs** — Track who ran what, when, on which model

### Growth & Community (Priority 5)

- [ ] **GitHub Discussions** — Enable on the RunCode repo for community Q&A
- [ ] **Blog posts targeting Claude Code pain points** — Rate limits, account bans, regional pricing, token drain. SEO-optimized, linking to RunCode as the solution.
- [ ] **Discord / Telegram community** — Already have Telegram (t.me/blockrunAI), grow it
- [ ] **Model comparison benchmarks** — Publish coding benchmarks across all 55+ models. Help users pick the right model.

---

## Architecture Reference

### Key Files

```
src/
├── index.ts                  # CLI entry (commander)
├── config.ts                 # VERSION, API_URLS, chain management
├── pricing.ts                # Per-model pricing (single source of truth)
├── banner.ts                 # Startup banner
│
├── agent/
│   ├── loop.ts               # Main agent loop (reasoning-action cycle)
│   ├── streaming-executor.ts # Concurrent/sequential tool dispatch
│   ├── permissions.ts        # Permission system (default/trust/plan/deny-all)
│   ├── tokens.ts             # Token estimation + context windows
│   ├── compact.ts            # Conversation compaction
│   ├── optimize.ts           # Token optimization (strip thinking, budget results)
│   ├── reduce.ts             # Token reduction (age old results, normalize)
│   ├── context.ts            # System prompt assembly
│   ├── llm.ts                # LLM API client (streaming)
│   ├── commands.ts           # Slash command dispatch
│   └── types.ts              # TypeScript interfaces
│
├── tools/
│   ├── index.ts              # Tool registry (all capabilities)
│   ├── read.ts, write.ts, edit.ts, bash.ts
│   ├── glob.ts, grep.ts
│   ├── webfetch.ts, websearch.ts
│   ├── task.ts, imagegen.ts, askuser.ts
│   └── subagent.ts
│
├── router/
│   └── index.ts              # 15-dimension classifier + tier routing
│
├── proxy/
│   ├── server.ts             # HTTP proxy server (x402 payment)
│   ├── fallback.ts           # Model fallback chains
│   └── sse-translator.ts     # SSE streaming translation
│
├── mcp/
│   ├── config.ts             # MCP server discovery (built-in + user)
│   └── client.ts             # MCP client (stdio transport)
│
├── session/
│   └── storage.ts            # JSONL session persistence
│
├── stats/
│   └── tracker.ts            # Usage statistics + cost tracking
│
├── wallet/
│   └── manager.ts            # Wallet abstraction (Base + Solana)
│
├── ui/
│   ├── app.tsx               # Ink terminal UI (React)
│   ├── model-picker.ts       # Model shortcuts + interactive picker
│   └── terminal.ts           # Terminal utilities
│
└── commands/
    ├── start.ts              # runcode (default) — launch agent
    ├── proxy.ts              # runcode proxy — payment proxy
    ├── daemon.ts             # runcode daemon start/stop/status
    ├── init.ts               # runcode init — auto-start config
    ├── uninit.ts             # runcode uninit — remove config
    ├── models.ts             # runcode models — list models
    ├── balance.ts            # runcode balance — check USDC
    ├── config.ts             # runcode config — settings
    ├── stats.ts              # runcode stats — usage stats
    ├── setup.ts              # runcode setup — create wallet
    └── logs.ts               # runcode logs — debug logs
```

### Environment Variables

```bash
RUNCODE_CHAIN          # Payment chain: base (default) or solana
ANTHROPIC_BASE_URL     # Override API endpoint (set by proxy mode)
ANTHROPIC_API_KEY      # API key (set by proxy mode)
```

### Config File

`~/.blockrun/runcode-config.json`:

```json
{
  "default-model": "zai/glm-5.1",
  "smart-routing": "auto",
  "permission-mode": "default",
  "max-turns": 100,
  "auto-compact": true,
  "session-save": true,
  "debug": false
}
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `@blockrun/llm` | LLM gateway SDK (x402 payments, wallet, models) |
| `@modelcontextprotocol/sdk` | MCP protocol (server discovery, tool calls) |
| `ink` + `react` | Terminal UI framework |
| `commander` | CLI argument parsing |
| `@solana/web3.js` | Solana blockchain integration |
| `chalk` | Terminal colors |

---

## Links

- [GitHub](https://github.com/BlockRunAI/runcode)
- [npm](https://npmjs.com/package/@blockrun/runcode)
- [BlockRun](https://blockrun.ai)
- [Telegram](https://t.me/blockrunAI)
- [x402 Protocol](https://x402.org)
