# Franklin Architecture

> **Franklin -- The AI agent with a wallet.**
> The reference implementation for the Autonomous Economic Agent category: it doesn't just generate text, it autonomously spends USDC to execute real work (marketing, trading, content).

This document describes the overall architecture, module boundaries, and key data flows of the `brcc` repository (published as `@blockrun/franklin`).

---

## 1. High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Terminal (Ink + React)                          │
│                     src/ui/app.tsx  ·  model-picker                    │
└───────────────┬─────────────────────────────────────────┬───────────────┘
                │ StreamEvent                              │ User input
                ▼                                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                       Agent Loop  src/agent/                            │
│                                                                         │
│  interactiveSession()                                                   │
│    ├─ optimize → reduce → microCompact → autoCompact  (token pipeline)  │
│    ├─ ModelClient.complete()   (SSE streaming + prompt caching)         │
│    ├─ StreamingExecutor        (concurrent tool execution)              │
│    ├─ PermissionManager        (default / trust / plan / deny)         │
│    └─ ErrorClassifier          (context / rate / payment / transient)  │
└──────┬──────────────────┬──────────────────┬────────────────┬──────────┘
       │                  │                  │                │
       ▼                  ▼                  ▼                ▼
┌──────────┐      ┌───────────────┐   ┌──────────────┐  ┌──────────────┐
│  Tools   │      │    Plugins    │   │     MCP      │  │   Wallet     │
│ src/tools│      │  src/plugins  │   │   src/mcp    │  │  src/wallet  │
│          │      │               │   │              │  │              │
│ 11 built │      │ registry +    │   │ stdio + HTTP │  │ @blockrun/llm│
│ -in caps │      │ runner        │   │ discovery +  │  │ Base + Solana│
│          │      │ (workflow /   │   │ trust model  │  │ x402 signing │
│          │      │  channel)     │   │              │  │              │
└──────────┘      └───────┬───────┘   └──────────────┘  └──────┬───────┘
                          │                                    │
                          ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Payment Proxy  src/proxy/server.ts                    │
│       (Claude Code / third-party SDK compatibility layer, :8402)        │
│                                                                         │
│   Request → model alias resolution → Gateway call → 402 → sign → retry │
│             ↑ smart router (src/router) scores on 15 dimensions         │
│             ↑ fallback chain (src/proxy/fallback)                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS POST /v1/messages
                                ▼
                  ┌──────────────────────────────────┐
                  │   BlockRun Gateway               │
                  │   blockrun.ai / sol.blockrun     │
                  │                                  │
                  │   55+ LLMs  +  paid APIs         │
                  │   x402 micropayments             │
                  └──────────────────────────────────┘
```

---

## 2. Directory Structure

```
src/
├── index.ts                 # CLI entry point (commander) + subcommand registration
├── banner.ts                # Franklin ASCII banner (chafa-generated)
├── config.ts                # Version, chain, Gateway URL, BLOCKRUN_DIR
├── pricing.ts               # MODEL_PRICING (55+ models, single source of truth)
│
├── agent/                   # Agent main loop
│   ├── loop.ts              # interactiveSession() — reasoning/action loop
│   ├── llm.ts               # ModelClient — streaming + x402 + SSE parsing
│   ├── types.ts             # CapabilityHandler / StreamEvent / AgentConfig
│   ├── compact.ts           # Auto-compaction + micro-compaction
│   ├── tokens.ts            # Estimated vs actual token accounting
│   ├── reduce.ts            # Token budget optimization pipeline
│   ├── optimize.ts          # max_tokens tier promotion (4K → 64K)
│   ├── commands.ts          # /retry · /model · /compact · /wallet …
│   ├── permissions.ts       # Permission modes
│   ├── streaming-executor.ts# Concurrent tool executor
│   └── error-classifier.ts  # Error classification and recovery strategies
│
├── tools/                   # 11 built-in capabilities
│   ├── index.ts             # Capability registry
│   ├── read · write · edit · bash · glob · grep
│   ├── webfetch · websearch
│   ├── task · imagegen · askuser
│   └── subagent.ts          # Sub-agent factory
│
├── plugin-sdk/              # Public plugin contract
│   ├── plugin.ts            # Plugin · PluginManifest · PluginContext
│   ├── workflow.ts          # Workflow · Step · ModelTier
│   ├── channel.ts           # Channel · ChannelMessage
│   ├── tracker.ts           # TrackedAction
│   └── search.ts            # SearchResult
│
├── plugins/                 # Plugin runtime
│   ├── registry.ts          # Discovery and loading (dev / user / bundled)
│   └── runner.ts            # Workflow execution orchestration
├── plugins-bundled/         # Plugins shipped with Franklin
│
├── wallet/manager.ts        # @blockrun/llm wrapper (Base + Solana)
│
├── proxy/                   # Local payment proxy (Claude Code compatibility layer)
│   ├── server.ts            # HTTP :8402 + x402 flow
│   ├── fallback.ts          # Fallback chain
│   └── sse-translator.ts    # SSE format translation
│
├── router/index.ts          # Smart router — 15-dimension request classification
│
├── session/                 # Session persistence
│   ├── storage.ts           # JSONL append-only writes + meta.json
│   └── search.ts            # In-memory full-text search (no SQLite)
│
├── stats/                   # Usage and insights
│   ├── tracker.ts           # recordUsage() + debounced disk writes
│   └── insights.ts          # Cost trends + projections
│
├── ui/                      # Ink + React terminal UI
│   ├── app.tsx              # Main component (input / tool status / streaming render)
│   ├── model-picker.ts      # Model selector categories
│   └── terminal.ts          # ANSI / raw mode / graceful exit
│
├── mcp/                     # MCP client
│   ├── config.ts            # Server discovery + project trust table
│   └── client.ts            # @modelcontextprotocol/sdk wrapper
│
├── social/                  # Native X bot (first-class citizen since v3.2.0, no longer a plugin)
│   ├── db.ts                # JSONL deduplication + reply log
│   ├── x.ts                 # X API
│   └── a11y.ts              # Accessibility
│
└── commands/                # CLI subcommand implementations (13 total)
    ├── start · proxy · setup · balance · models · config
    ├── stats · logs · daemon · init · uninit
    ├── social · plugin
```

Persistence root: **`~/.blockrun/`**

```
~/.blockrun/
├── payment-chain               # Current chain (base | solana)
├── sessions/                   # JSONL session history (retains most recent 20)
├── runcode-stats.json          # Cumulative usage stats
├── runcode-debug.log           # Debug log
├── social-replies.jsonl        # X bot reply records
├── social-prekeys.jsonl        # Pre-deduplication fingerprints
├── mcp.json                    # Global MCP configuration
├── trusted-projects.json       # Project .mcp.json trust table
└── plugins/<id>/               # Per-plugin user-installed data directory
```

---

## 3. Core Modules

### 3.1 CLI Entry Point -- `src/index.ts`

Commander registers 15 main commands, with `start` as the default:

| Command | Purpose |
|---|---|
| `setup [chain]` | Create a Base / Solana wallet |
| `start` | Interactive session (default) |
| `proxy` | Start local payment proxy on `:8402` for Claude Code |
| `models` | List all available models and pricing |
| `balance` | Check USDC balance |
| `config` | Read/write user configuration under `~/.blockrun/` |
| `stats` / `insights` | Usage, cost, and trend analysis |
| `logs` | Debug log viewer (supports follow mode) |
| `search <query>` | Full-text search across session history |
| `social [action]` | Native X bot |
| `daemon <action>` | Background proxy management |
| `init` / `uninit` | macOS LaunchAgent auto-start on boot |
| `plugins` | List installed plugins |
| *(dynamic)* | Commands registered by plugins |

Global flags: `--trust`, `--debug`, `-m <model>` apply across all modes.
Shortcut entry: `runcode base` / `runcode solana` persists the chain preference to disk, then enters `start`.

### 3.2 Agent Main Loop -- `src/agent/loop.ts`

`interactiveSession(config, getUserInput, onEvent, onAbortReady)` is the heart of the entire runtime. Each turn proceeds in order:

1. **Token pipeline** (~`loop.ts:117-165`)
   - `optimizeHistory()` -- strip thinking traces, age out old results
   - `reduceTokens()` -- normalize whitespace, shrink verbose messages
   - `microCompact()` -- discard stale tool results to prevent context snowballing
   - `autoCompactIfNeeded()` -- trigger summarization when context exceeds ~80% of the window (with 3-retry circuit breaker)
2. **System prompt injection** (ultrathink optional)
3. **StreamingExecutor** readied (for concurrent tool launches)
4. **`ModelClient.complete()`** fires the SSE request, streaming text/thinking deltas to the UI in real time
5. **Error recovery** (`loop.ts:221-294`)
   - Context overflow --> forced compaction + retry
   - Transient errors --> exponential backoff (2^N x 1000ms)
   - Rate limit --> fall back to free model (per-session dedup to prevent ping-pong)
   - Payment failure --> walk the fallback chain
6. **Token accounting** --> `stats/tracker`
7. **Tool result collection** --> appended back into history
8. **Token budget warning** (fires once per session at 70% usage)

Sessions are persisted as JSONL under `~/.blockrun/sessions/`, with IDs like `session-YYYY-MM-DDTHH-MM-SS`. At most 20 are retained.

### 3.3 ModelClient -- `src/agent/llm.ts`

This is **Franklin's sole bridge to the Gateway**.

**Methods**
- `streamCompletion(req, signal)` --> `AsyncGenerator<StreamChunk>`
- `complete(req, signal, onToolReady?, onStreamDelta?)`

**x402 handshake** (`llm.ts:205-220`, `372-464`)
```
POST /v1/messages  →  402 Payment Required
                 ↓
        parsePaymentRequired(header)
                 ↓
   Base:  createPaymentPayload(pk, from, to, amount, network)
   Sol:   createSolanaPaymentPayload(secretBytes, from, to, amount, feePayer)
                 ↓
   Retry with PAYMENT-SIGNATURE header
```

Wallet cache TTL is 30 minutes (`llm.ts:128-131`).

**Anthropic prompt caching** (`llm.ts:56-119`, `167-177`)

Strategy `system_and_3`: the system prompt is permanently cached; a rolling cache covers the most recent 3 messages plus the last tool definition. This reduces input tokens by ~75% in multi-turn conversations.

**SSE parsing** (`llm.ts:480-543`): 1MB buffer limit, accumulates `text / thinking / tool_use` deltas, terminates on `message_stop`.

**Model-specific behavior**: GLM family uses `temperature=0.8` and enables thinking on `-thinking-` variants; Anthropic models activate the prompt caching beta flag.

### 3.4 Tools -- `src/tools/`

11 built-in capabilities plus 1 sub-agent factory, all implementing `CapabilityHandler`:

| Tool | File | Purpose |
|---|---|---|
| Read | read.ts | Read a file by line range |
| Write | write.ts | Create a new file |
| Edit | edit.ts | Block edit / line replacement |
| Bash | bash.ts | Shell commands |
| Glob | glob.ts | Filename pattern matching |
| Grep | grep.ts | Regex search |
| WebFetch | webfetch.ts | Fetch HTML and parse it |
| WebSearch | websearch.ts | Search (Exa / fallback) |
| Task | task.ts | Task list management |
| ImageGen | imagegen.ts | DALL-E image generation |
| AskUser | askuser.ts | Interactive prompting (delegates to Ink) |
| SubAgent | subagent.ts | Isolated-config sub-agent |

Tools are injected into the agent loop via `config.capabilities: CapabilityHandler[]`. The loop is agnostic to the underlying implementation.

### 3.5 Plugin System -- `src/plugin-sdk`, `src/plugins`, `src/plugins-bundled`

**Public contract** (`plugin-sdk/`)
- **`PluginManifest`** -- id / name / version / provides / entry
- **`Plugin`** -- manifest + workflows? + channels? + commands? + lifecycle hooks
- **`Workflow`** -- `steps: WorkflowStep[]`, each step declares `modelTier: free | cheap | premium | none`
- **`WorkflowStepContext`** -- `callModel(tier, prompt)` / `generateImage?` / `search()` / `sendMessage?` / `track()` / `isDuplicate()` / `dryRun`
- **`Channel`** -- abstract publishing platform (X, Reddit, Telegram, etc.)

**Registry** (`plugins/registry.ts`) scans in priority order:
1. `$RUNCODE_PLUGINS_DIR/*` -- development mode
2. `~/.blockrun/plugins/*` -- user-installed
3. `src/plugins-bundled/*` -- shipped with the package

Each manifest is loaded via dynamic `import(entry)`, injected with `PluginContext { dataDir, pluginDir, log }`, and its `onLoad()` hook is called.

**Runner** (`plugins/runner.ts`) orchestrates in sequence: config --> steps --> model dispatch --> track. Action logs are append-written to `~/.blockrun/workflows/<name>.jsonl`, with pre-key deduplication support.

> `plugins-bundled/` is currently empty: the former social plugin was promoted to `src/social/` (first-class citizen) in v3.2.0. The directory is retained for future official plugins.

### 3.6 Wallet + Payments -- `src/wallet`, `src/proxy`, `src/router`

**`wallet/manager.ts`** is a thin wrapper around `@blockrun/llm`: `walletExists`, `setupWallet`, `setupSolanaWallet`, `getAddress`. All sensitive logic -- private key generation, signing, KDF -- lives in `@blockrun/llm` v1.4.2.

**`proxy/server.ts`** -- local server on :8402, designed to **let Claude Code and third-party Anthropic SDKs transparently use Franklin's wallet**:
- Model alias resolution (`auto`/`eco`/`premium`/`sonnet`/`opus`/`haiku`/`gpt` ...)
- Forwards requests to the Gateway
- 402 --> sign --> retry
- On failure --> walks the `fallback.ts` fallback chain
- `recordUsage()` writes statistics
- Per-model adaptive `max_tokens`

**`router/index.ts`** -- Smart router. Scores each request across 15 dimensions: token volume, code characteristics, reasoning keywords, imperative style, multi-step patterns, agentic patterns, and more. Maps to four tiers -- `SIMPLE / MEDIUM / COMPLEX / REASONING` -- then selects a concrete model based on profile (`auto / eco / premium / free`). Returns `{ model, tier, confidence, signals[], savings% (vs Opus) }`.

| Tier | auto | eco | premium |
|---|---|---|---|
| SIMPLE | gemini-2.5-flash | nemotron-ultra | kimi-k2.5 |
| MEDIUM | kimi-k2.5 | gemini-2.5-flash-lite | gpt-5.3-codex |
| COMPLEX | gemini-3.1-pro | gemini-2.5-flash-lite | claude-opus-4.6 |
| REASONING | grok-4.1-fast-reasoning | grok-4.1-fast-reasoning | grok-4.1-fast-reasoning |

### 3.7 Sessions and Stats

**`session/storage.ts`** -- JSONL append-only writes (crash-safe), with metadata in a separate JSON file. Stored under `~/.blockrun/sessions`; falls back to `/tmp/runcode/sessions` if the primary path is not writable. Retains the 20 most recent sessions; the currently active session is never pruned.

**`session/search.ts`** -- In-memory full-text search (deliberately avoids SQLite): tokenization / quoted phrase matching / snippet extraction / term-frequency scoring with 3x phrase bonus + 1.1x assistant weight + time decay. Designed for a capacity of ~30 turns per day, ~10K lines per year, well under 1MB.

**`stats/tracker.ts`** -- `~/.blockrun/runcode-stats.json`, structured as `{ totalRequests, totalCostUsd, totalInputTokens, totalOutputTokens, totalFallbacks, byModel{}, history[last 1000] }`. Uses **2000ms debounced disk writes** to prevent `load --> modify --> save` data races under high proxy concurrency.

**`stats/insights.ts`** slices data by day to generate cost trends and monthly projections, powering the `/insights` command.

### 3.8 UI -- `src/ui/`

Ink + React terminal UI. `app.tsx` (~37K) is the main component. Its event loop translates `StreamEvent` messages from the agent into non-blocking UI updates:

- Full-width input field showing the current model + wallet balance + session cost
- Tool status: spinner + preview + real-time output
- Text/thinking deltas streamed and rendered in real time
- Model selector: category view first, then flat list with keyboard navigation
- Slash command palette

`terminal.ts` manages raw mode, signal handling, and graceful Ctrl+C exit.

### 3.9 MCP -- `src/mcp/`

**`config.ts`** discovers MCP servers in order:
1. Built-in: `blockrun-mcp`, `unbrowse` (if these executables exist on the system)
2. Global: `~/.blockrun/mcp.json`
3. Project: `{workDir}/.mcp.json` -- **only loaded if the project is in the trust table** at `~/.blockrun/trusted-projects.json`

**`client.ts`** wraps `@modelcontextprotocol/sdk`'s `Client`, supporting both stdio and HTTP (SSE) transports. `listTools()` automatically wraps each MCP tool as a `CapabilityHandler` and injects it into the agent loop.

### 3.10 Social (Native X Bot) -- `src/social/`

Promoted from a plugin to a first-class citizen in v3.2.0. The reason: X integration demands too much ceremony (reply throttling, failure retry, pre-deduplication, daily accounting) that the plugin SDK's generic Channel contract could not adequately express.

**`db.ts`** manages two JSONL files:
- `social-replies.jsonl` -- full record for each reply (including `status = posted / failed / skipped / drafted`, `cost_usd`)
- `social-prekeys.jsonl` -- pre-key deduplication (`sha256(author + snippet + time_bucket)`), used to determine **before spending money on an LLM call** whether a given post has already been seen

On startup, both files are scanned to rebuild three in-memory indexes: `repliesByUrl`, `repliesToday`, `preKeysSet`. Key invariant: `hasPosted()` only recognizes `status='posted'` -- failures do not consume quota.

### 3.11 Commands -- `src/commands/`

13 subcommand files, each responsible for one CLI action. `start.ts` and `proxy.ts` are the two primary modes: the former launches the interactive agent loop, the latter starts the local payment proxy. The rest are administrative commands.

---

## 4. Key Data Flow: Lifecycle of a User Message

```
User types in the terminal
     │
     ▼
interactiveSession() receives userInput, appends it to history
     │
     ▼
Token pipeline
  ├─ optimizeHistory()   (strip thinking + age out old results)
  ├─ reduceTokens()      (normalize + shrink)
  ├─ microCompact()      (discard stale tool_result entries)
  └─ autoCompactIfNeeded() (summarize if > 80% of context window)
     │
     ▼
Inject system prompt (+ ultrathink)
     │
     ▼
ModelClient.complete()
  ├─ Build payload + prompt caching (system_and_3)
  ├─ GLM / Anthropic model-specific handling
  ├─ POST /v1/messages → Gateway
  │    │
  │    ├─ 200 OK + SSE stream
  │    │
  │    └─ 402 Payment Required
  │         │
  │         ├─ parsePaymentRequired(header)
  │         ├─ createPaymentPayload() (Base / Solana)
  │         └─ Retry with PAYMENT-SIGNATURE header
  │
  ├─ Parse SSE:
  │    ├─ text delta     → stream to UI in real time
  │    ├─ thinking delta → stream to UI in real time
  │    └─ tool_use       → onToolReady() launches tool concurrently
  │
  └─ Accumulate stop_reason / usage
     │
     ▼
StreamingExecutor.collectResults()
  (bash / read / edit / grep / … run concurrently, then collect results)
     │
     ▼
tool_result entries appended to history
     │
     ▼
  stop_reason == 'end_turn' ?
     ├─ yes → appendToSession(id) + recordUsage() + turn_done event → wait for next input
     └─ no  → loop back to token pipeline
```

---

## 5. Design Principles

1. **The core is plugin-agnostic.** The agent loop only knows about `CapabilityHandler`. It does not care whether a tool is built-in, provided by MCP, or invoked through a plugin workflow.
2. **The token pipeline is layered.** Cheap operations (strip / reduce / microCompact) are exhausted first before resorting to the expensive autoCompact summarization pass.
3. **x402 is transparent to callers.** Business logic only calls `complete()`. The entire 402 --> sign --> retry flow is encapsulated inside `ModelClient`.
4. **Smart router benchmarks savings against Opus.** Every new model added to the router reports "saves X% vs Opus", giving users a single consistent mental model.
5. **JSONL first, SQLite never.** Sessions, social deduplication, and reply logs are all append-only JSONL. They can be grepped, diffed, and catted. They are crash-safe. The scale is sufficient (~30 replies/day, ~10K lines/year, under 1MB).
6. **The wallet layer is as thin as possible.** All sensitive logic lives in `@blockrun/llm`. Franklin only handles UX and caching (30-minute TTL).
7. **`~/.blockrun/` is the single persistence root.** Migrating or backing up a user's data means copying one directory.
8. **Error recovery is restrained.** The payment failure fallback chain deduplicates per session to avoid repeatedly hitting a broken model. Rate-limit free-model fallback is also tracked per session to prevent oscillation.

---

## 6. External Dependency Boundaries

| Dependency | Purpose | Entry point |
|---|---|---|
| `@blockrun/llm` v1.4.2 | Wallet, x402 signing, DALL-E | `src/wallet/manager.ts`, `src/agent/llm.ts`, `src/tools/imagegen.ts` |
| `@modelcontextprotocol/sdk` v1.29 | MCP client | `src/mcp/client.ts` |
| `commander` | CLI argument parsing | `src/index.ts` |
| `ink` / `react` | Terminal UI | `src/ui/*` |
| **BlockRun Gateway** | Unified entry point for 55+ LLMs + paid APIs | `blockrun.ai/api` (Base) / `sol.blockrun.ai/api` (Solana) |

The protocol between Franklin and the Gateway is an **Anthropic Messages API-compatible streaming interface plus x402**. In other words, any client that can call the Anthropic API can be pointed at the local :8402 payment proxy to transparently gain access to Franklin's wallet, smart routing, and usage tracking. This is the raison d'etre of proxy mode for Claude Code.

---

## 7. How to Extend

- **Add a new tool** -- Create a file in `src/tools/` implementing `CapabilityHandler`, export it from `src/tools/index.ts`, and add it to the agent config's `capabilities` array.
- **Add a workflow plugin** -- Implement the `Plugin` contract, place it in `src/plugins-bundled/<id>/` (official) or `~/.blockrun/plugins/<id>/` (user-installed). The registry will discover it automatically.
- **Add a CLI subcommand** -- Create a file in `src/commands/`, then register it in `src/index.ts` with `program.command(...)`.
- **Integrate a new paid API** -- Put it behind the BlockRun Gateway. Franklin needs no changes; just add a row to `MODEL_PRICING` in `pricing.ts`.
- **Support a new chain** -- Extend `API_URLS` in `config.ts`, add the corresponding wallet and signer to `@blockrun/llm`, and add a branch to `signPayment()` in `llm.ts`.

---

## 8. Positioning Check

> **Franklin runs your money.**

Every new feature should pass this test:

- Does this make Franklin more of "the agent with a wallet"? --> ship it.
- Does this dilute Franklin back into "just another coding tool"? --> don't.

The moat is the payment layer. The category is Autonomous Economic Agent. The verticals are marketing and trading. Everything else is execution.
