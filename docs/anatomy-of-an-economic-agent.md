# Anatomy of an Economic Agent

A walk-through of Franklin's internals — router, x402, brain,
Telegram — shown on a single user prompt.

---

## What happens when you ask it to do something

You type:

> Research the three biggest AI agent repositories by stars, write me
> a 500-word technical comparison, and save the draft to
> `~/drafts/agent-comparison.md`.

Below is every thing Franklin does between that prompt and the file
appearing on disk. It's a good cross-section of the product because
it exercises the router, the wallet, two tools, the brain, the
streaming pipeline, and the session store.

---

## Layer 1 — CLI entry and session hydration

You invoke `franklin` (or `franklin resume` / `franklin telegram`).
The binary lives at `dist/index.js`. On start it:

1. Loads the wallet chain you've chosen (`base` or `solana`) — the
   private key lives on disk at `~/.blockrun/`, never leaves the
   machine.
2. Reads `~/.blockrun/config.json` for the default model and any
   overrides.
3. Resolves `--resume` or `--continue` — if a session ID is given,
   the entire prior `history[]` is hydrated from `sessions/<id>.jsonl`
   and the session keeps appending to the same file.
4. Assembles the system prompt. This is a deterministic concatenation
   of ~12 sections: core instructions, code style, tool patterns,
   verification, model-specific guidance, and any `CLAUDE.md` /
   `RUNCODE.md` found in the working directory (with a prompt-
   injection scanner that neutralizes suspicious patterns).
5. Registers the 16+ built-in capabilities. MCP servers discovered in
   `~/.blockrun/mcp.json` are auto-connected, adding their tools.

The whole session, capability registry, permission mode, and
conversation history are bundled into an `AgentConfig` and handed to
`interactiveSession()`.

---

## Layer 2 — The agent loop

`interactiveSession()` is a single `while (true)` that:

1. Awaits user input (from stdin, Ink TUI, Telegram channel, or a
   queued message).
2. Appends the message to `history[]` and persists it to the session
   JSONL.
3. Runs a pipeline of history optimizations before each LLM call:
   - `optimizeHistory` — strips thinking blocks, budgets tool
     results, does time-based cleanup.
   - `reduceTokens` — ages old results, normalizes whitespace, trims
     verbose messages.
   - `microCompact` — clears old tool results to prevent context
     snowball.
   - `autoCompactIfNeeded` — full summarization when approaching
     context limit.
4. Calls the model, streams text + thinking deltas to the UI,
   receives zero or more tool calls.
5. Executes the tool calls concurrently where safe, sequentially
   otherwise.
6. Feeds the results back into `history[]` and loops.

Every iteration logs usage, records tool-call patterns for
anti-looping guardrails, and tracks session cost in USDC.

---

## Layer 3 — Smart router

Before calling any model, Franklin decides *which* model to call.
The router (`src/router/index.ts`) runs on every request:

1. Classifies the user's prompt into a tier — `SIMPLE`, `MEDIUM`,
   `COMPLEX`, or `REASONING` — using keyword signals, token volume,
   imperative style, and multi-step patterns.
2. Looks up the tier in the current profile's model config. Profiles
   are `auto` (best quality-to-cost), `eco` (cheapest with decent
   quality), `premium` (highest quality regardless of cost), and
   `free` (only free-tier models).
3. Applies a small learned Elo adjustment from the user's past
   outcomes — retries and stuck sessions count as negative signal,
   successful completions as positive.
4. Returns `{ model, tier, confidence, signals, savings }`.

For our research prompt, the router classifies `COMPLEX`
(multi-step: research + write + save) and returns
`anthropic/claude-sonnet-4.6` with 0.84 confidence and 82% estimated
savings vs always-Opus.

The savings number is real — it's computed against the pricing sheet
of the default Opus-tier baseline. It goes on the session's cost
receipt.

---

## Layer 4 — Weak-model guard and think-tag stripping

If the router selected a model known to hallucinate tool calls
(`nvidia/*`, `zai/glm-4*`, `qwen3-coder`, `deepseek-*-lite`), the
model client appends a small system-prompt guardrail:

```
# Available tools
You have exactly these tools: Read, Write, Edit, Bash, Glob, Grep,
WebFetch, WebSearch, Task, ImageGen, VideoGen, MemoryRecall, AskUser,
SubAgent, MoA, TradingSignal, TradingMarket, TradingPortfolio,
TradingOpenPosition, TradingClosePosition, TradingHistory,
ContentCreate, ContentAddAsset, ContentShow, ContentList.
Do not invent other tool names. Do not emit literal "[TOOLCALL]",
"<tool_call>", or similar tokens in your text — call tools via the
proper API only.
```

Strong frontier models skip this nag — they don't need it and the
extra text would cost prompt-cache hits.

For the same class of models, streaming text is run through a
`ThinkTagStripper`. Reasoning models like Nemotron Ultra and
DeepSeek-R1 emit their chain of thought inline in the text field:

```
<think>
Okay, the user wants a technical comparison of agent repos...
</think>

Here's the comparison:
```

Without stripping, the user sees the raw `<think>` tags and the
agent's internal monologue bleeds into the stored conversation
history, wasting context on every subsequent turn. The stripper is a
streaming state machine that splits these tags out across chunk
boundaries (including tags that arrive split between deltas) and
routes them to the thinking channel instead of the text channel. The
final committed response is clean, and a compact "Thought for 3.2s ·
~420 tokens" line appears above it as a paid-cost receipt.

---

## Layer 5 — x402 and the wallet hit

The model call goes to the BlockRun gateway at `https://blockrun.ai`.
On a paid model, the gateway returns `HTTP 402 Payment Required`
with a JSON body describing what the call costs, where to send it,
and how long the payment is valid.

Franklin's model client sees the 402, opens the wallet, and signs a
payment payload:

- On **Base**, an EIP-712 signed message authorizing a USDC transfer
  via Coinbase's x402 facilitator.
- On **Solana**, a signed transfer instruction against a
  facilitator-paid fee-payer.

The signed payload goes into the `PAYMENT-SIGNATURE` header on a
retry of the original request. The gateway validates the signature,
settles the transfer on-chain, then proxies the actual model call.
Total added latency: ~500ms for Base, ~800ms for Solana.

The whole flow is in `src/agent/llm.ts` around line 300 — 50 lines of
code end-to-end. There's no subscription, no API key, no per-user
rate limit. The wallet is the only gate.

---

## Layer 6 — Streaming executor

When the model returns tool calls, Franklin's streaming executor
(`src/agent/streaming-executor.ts`) looks at each one:

- **Concurrent-safe tools** (Read, Grep, Glob, WebFetch, MemoryRecall,
  trading-data queries) start executing the moment the tool's input
  JSON finishes streaming — before the model even finishes its turn.
- **Non-concurrent tools** (Write, Edit, Bash, ImageGen, VideoGen,
  trading-execute) queue until the turn closes, then run serially so
  their side effects have a defined order.

For the research prompt this means:

1. `WebSearch("top AI agent github repositories")` starts before the
   model finishes its reply.
2. `WebFetch(top 3 URLs)` starts next, still concurrent.
3. The reading completes before the model starts drafting.
4. When the model calls `Write(~/drafts/agent-comparison.md, ...)`,
   the Write runs after streaming ends, with a permission check.

Each tool prints a live USDC running total. Concurrency is where
Franklin gets its speed — a multi-search research prompt that would
be sequential in a pure-subscription CLI runs in half the wall time
here.

---

## Layer 7 — Brain auto-recall

Between every user turn and the LLM call, Franklin scans the new
message plus the last assistant reply for known entity mentions:

```ts
const mentioned = extractMentions(userInput + priorAssistant, entities);
if (mentioned.length > 0) {
  const brainContext = buildEntityContext(mentioned, entities);
  systemParts.push(brainContext);
}
```

Entities and observations live in
`~/.blockrun/brain/entities.jsonl` and are harvested from every
session after it ends (`extractBrainEntities` runs at session close,
with a 15-second hard cap). For our research prompt, if you've
previously talked to Franklin about "agent repos" or named a specific
competitor, the brain injects:

```
# Known Entities
## BlockRun (company)
- Ships Franklin, an open-source AI agent CLI
- Uses x402 for all paid calls

## Hermes (project)
- Self-evolution agent with FTS5 session search
```

The injection is cached per user turn — if the inner agent loop
iterates 5 times (planner → executor → ...), the brain scan runs
once.

This is the memory that survives across sessions. It's the reason
Franklin remembers what it knows about you after a process restart,
including after a Telegram bot restart — sessions tagged with
`telegram:<ownerId>` are found by `findLatestSessionByChannel()` on
boot and resumed automatically.

---

## Layer 8 — The tools

Franklin ships with 20+ built-in capabilities:

| Group | Tools |
|---|---|
| Filesystem | Read, Write, Edit, Glob, Grep |
| Execution | Bash, Task, SubAgent |
| Web | WebFetch, WebSearch |
| Media | ImageGen (DALL-E, GPT-Image), VideoGen (xAI Grok-Imagine, $0.05/s) |
| Memory | MemoryRecall (read-only brain search) |
| Trading | TradingSignal, TradingMarket, TradingPortfolio, TradingOpenPosition, TradingClosePosition, TradingHistory |
| Content | ContentCreate, ContentAddAsset, ContentShow, ContentList |
| Routing | MoA (mixture-of-agents on demand) |
| Interactive | AskUser |

Each has a typed `input_schema` and a capability handler. The tool
list is part of the per-call contract with the model — the model
sees exactly what it can call, and the runtime enforces it.

Adding a tool is a single file in `src/tools/`, registered in
`src/tools/index.ts`, with an optional per-capability permission
policy. VideoGen was added in ~250 lines and one new registration.

---

## Layer 9 — Session persistence and the Telegram channel

Every turn — user message, assistant response, tool result — is
appended to `~/.blockrun/sessions/<session-id>.jsonl` atomically. A
separate `<session-id>.meta.json` tracks turn count, message count,
token totals, cost, and savings vs the Opus baseline.

Non-CLI drivers tag their sessions via `SessionMeta.channel`:

- `telegram:<ownerId>` for the Telegram bot
- (future) `discord:<guildId>`, `feishu:<userId>`, `slack:<teamId>`

A helper, `findLatestSessionByChannel(channel)`, lets any driver
resume its own most recent session across process restarts. The
Telegram bot uses this on boot — stop the process, start it again,
and the conversation picks up where it left off. `/new` inside the
Telegram chat starts a clean session and the bot transitions
seamlessly.

---

## The architecture as one picture

```
┌──────────────────────────────────────────────────────────────┐
│  franklin CLI (stdin | Ink TUI | Telegram | MCP clients)     │
├──────────────────────────────────────────────────────────────┤
│  Agent Loop                                                  │
│  • Optimize / reduce / microcompact / autocompact history    │
│  • Per-turn brain auto-recall (cached across planner steps)  │
│  • Weak-model system-prompt guardrail (when needed)          │
├──────────────────────────────────────────────────────────────┤
│  Smart Router                                                │
│  • SIMPLE / MEDIUM / COMPLEX / REASONING classification      │
│  • auto / eco / premium / free profiles                      │
│  • Learned Elo adjustment from past outcomes                 │
├──────────────────────────────────────────────────────────────┤
│  Model Client                                                │
│  • Streaming SSE (Anthropic format + OpenAI translator)      │
│  • Think-tag stripping for inline-reasoning models           │
│  • x402 payment signing (Base EIP-712 / Solana)              │
├──────────────────────────────────────────────────────────────┤
│  Streaming Executor                                          │
│  • Concurrent-safe tools start before turn ends              │
│  • Non-concurrent tools run sequentially with permission     │
├──────────────────────────────────────────────────────────────┤
│  Tools — 20+ capabilities                                    │
│  Filesystem · Bash · Web · Media · Memory · X · Trading      │
├──────────────────────────────────────────────────────────────┤
│  Persistence                                                 │
│  • Session JSONL + meta.json (resumable, channel-tagged)     │
│  • Brain JSONL (entities + observations + relations)         │
│  • Learnings (cross-session preferences, decay-weighted)     │
└──────────────────────────────────────────────────────────────┘
                             │ signed USDC (HTTP 402)
                             ▼
                      BlockRun Gateway
                 55+ models / paid APIs
                             │
                             ▼
                       User Wallet
                     (Base or Solana)
```

---

## If you want to read the code

The whole thing is ~15k lines of TypeScript, Apache-2.0, ships as
one npm package. The interesting files for most readers:

- `src/agent/loop.ts` — the reasoning-action cycle
- `src/agent/llm.ts` — model client, x402, streaming
- `src/router/index.ts` — tier routing and profile logic
- `src/agent/streaming-executor.ts` — concurrent tool execution
- `src/brain/` — the entity + observation store and auto-recall
- `src/channel/telegram.ts` — a worked example of a non-CLI driver
- `src/tools/videogen.ts` — the shortest interesting tool, ~250 lines

Clone it, run `npm install && npm run build && node dist/index.js`,
and every path above is live on your machine. Top up a wallet with
$5 of USDC and the paid models light up. Run it with `$0` and
Franklin still works — on free-tier NVIDIA models, with all the
other tools intact.

```bash
npm install -g @blockrun/franklin
franklin setup base
franklin balance
franklin
```

That is the shortest path from "I read about Economic Agents" to
"there is one running on my machine."

---

*Franklin is open-source at
[`github.com/BlockRunAI/Franklin`](https://github.com/BlockRunAI/Franklin).
Apache-2.0. Written in TypeScript.*
