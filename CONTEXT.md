# Franklin Agent

The reference implementation of an **Economic Agent** — an AI agent that holds a user-funded USDC wallet, prices every action, signs a micropayment per paid call, and stops when the wallet is empty. This file is the canonical glossary used in code, comments, commits, PRs, and design discussions. Higher-level positioning lives in [`PHILOSOPHY.md`](./PHILOSOPHY.md); the project map and conventions live in [`CLAUDE.md`](./CLAUDE.md).

## Language

### Wallet, payment, gateway

**Wallet**:
A user-funded USDC wallet on Base or Solana that Franklin signs micropayments from for every paid call.
_Avoid_: Account, balance (as identity), credits, subscription.

**x402**:
The HTTP `402 Payment Required` micropayment protocol Franklin uses to pay per call: an unpaid probe receives a 402 with payment terms, the wallet signs, the paid request retries.
_Avoid_: Payment middleware (vague), crypto payments (loses the protocol-specific meaning).

**Payment probe**:
The first, unpaid HTTP request whose 402 response carries the payment terms; Franklin signs against those terms and replays the request as the **paid request**.
_Avoid_: Pre-flight, handshake.

**BlockRun Gateway**:
The single upstream service Franklin calls for both LLM completions and paid tools (Exa, ImageGen, VideoGen, MusicGen, market data); aggregates 55+ models and accepts x402.
_Avoid_: API, provider, backend, BlockRun (without "Gateway") when referring to the service.

**Per-turn spend cap**:
The hard USD ceiling on what a single agent turn may spend; default `$1.00`, configurable via `franklin config set max-turn-spend-usd`.
_Avoid_: Budget (overloaded), turn limit.

**Content Library budget**:
A separate per-piece budget shared by `ImageGen` + `VideoGen` + `MusicGen`, distinct from the per-turn cap.
_Avoid_: Media budget, asset budget.

### Models and routing

**Model picker**:
The shortcut → canonical-model-id table at `src/ui/model-picker.ts` and `src/proxy/server.ts`; both must stay in sync.
_Avoid_: Model registry, model list.

**Picker shortcut**:
A short alias (e.g. `free`, `kimi`, `sonnet-4.6`) that resolves to a canonical gateway model id (`nvidia/qwen3-coder-480b`).
_Avoid_: Alias (used in code), nickname.

**Tier**:
A capability bucket the router resolves a request into — one of `SIMPLE`, `MEDIUM`, `COMPLEX`, `REASONING` — used to pick a primary model and fallbacks per profile.
_Avoid_: Level, class.

**Routing profile**:
A user-level intent that biases the tier router — `auto`, `free`, `eco`, `premium`. Selected via `--model blockrun/<profile>` or the `/auto` slash command.
_Avoid_: Mode (overloaded with proxy mode).

**Auto routing**:
The `blockrun/auto` profile: the router classifies the turn into a tier and resolves to a concrete model per turn; the resolved model is printed as `*Auto → <model>*`.
_Avoid_: Smart mode, dynamic mode.

**Free tier matrix**:
The agent-tested set of free gateway models that pass both the echo and Bash-tool live probes; current members are `nvidia/qwen3-coder-480b` and `nvidia/llama-4-maverick`.
_Avoid_: Free models (use this only for the broader picker category).

**Fallback chain**:
The ordered list of canonical model ids the proxy walks when an attempt fails; each step covers the unpaid probe, signing, and the paid request, so a 402, timeout, or 5xx at any stage moves on.
_Avoid_: Retry list, model fallback.

**Payment-aware fallback**:
A fallback chain that treats payment-stage failures (signing error, post-payment timeout) as eligible to advance, not just upstream errors.
_Avoid_: Smart fallback (vague).

### Harness components

**Harness**:
The set of layers Franklin wraps around a raw model call — planner, evaluators, verifiers, polish round, compaction, fallback, telemetry. Each layer encodes an assumption about a current model-capability gap and is expected to be removable when the gap closes (see ADR `docs/adr/0003-harness-as-removable-components.md`).
_Avoid_: Framework, scaffolding.

**Plan-then-execute**:
The two-call planning layer: the model first emits a plan, then executes it. Opt out per-process with `FRANKLIN_NOPLAN=1`.
_Avoid_: Planner mode, two-pass.

**Compaction**:
The context-compression pass that summarizes earlier turns into a shorter prefix once the session approaches a token threshold.
_Avoid_: Context squeezing, summarization (the user-facing reply summary is different).

**Code verifier**:
The harness pass that fires when the agent writes code, sanity-checking the output before showing the user.
_Avoid_: Linter, validator.

**Groundedness evaluator**:
The harness pass that fires on factual replies, checking each claim either traces to a tool call or is hedged as uncertain. Disable with `FRANKLIN_NO_EVAL=1`. Independent of the **code verifier** — both can fire on the same turn.
_Avoid_: Fact checker, hallucination guard.

**Polish round**:
The final clean-up pass that strips raw `<think>` tags, role-played `[TOOLCALL]` text, and other weak-model artefacts from a streamed reply.
_Avoid_: Post-processing.

**Bash risk classifier**:
The pre-execution check on the `Bash` tool that blocks destructive shell commands (`rm -rf` of system paths, history rewrites, `DELETE` without `WHERE`, etc.).
_Avoid_: Bash guard, command filter.

**doctor**:
The `franklin doctor` command and its color-coded health rows (Node, config dir, chain, wallet, gateway, MCP, telemetry, PATH); exits non-zero on any failing row.
_Avoid_: Healthcheck, sanity check.

### Tools

**Hero tools** (also: **Core tools**):
The always-on tool set named in `CORE_TOOL_NAMES`, advertised on every turn so weak-to-mid-tier models actually invoke them. It includes the basic agent surface (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `AskUser`, `Task`, `ActivateTool`) plus Franklin's category-defining hero surface (`TradingMarket`, `TradingSignal`, `ExaAnswer`, `ExaSearch`, `ExaReadUrls`, `WebFetch`, `WebSearch`).
_Avoid_: Default tools, primary tools.

**Long-tail tools**:
Tools gated behind the `ActivateTool` mechanism so they don't bloat the always-on inventory — currently `VideoGen`, `MusicGen`, `ImageGen`, `WebhookPost`, `PostToX`.
_Avoid_: Optional tools, advanced tools.

**ActivateTool**:
The agent-facing tool that promotes a long-tail tool into the active inventory for the current turn.
_Avoid_: Tool loader, tool switcher.

**Subagent**:
A nested Franklin agent invocation; spawning a paid sub-model from a free parent prompts a cost gate before running.
_Avoid_: Child agent, helper agent.

**MOA**:
The Mixture-of-Agents tool that runs several free reference models in parallel and aggregates with a single aggregator model (currently `nvidia/qwen3-coder-480b`).
_Avoid_: Ensemble, multi-model.

**Content piece**:
A single output addressable by the Content Library — can carry an image, a video, and an audio track under one shared budget.
_Avoid_: Asset, media item.

### Sessions, telemetry, verticals

**Session**:
A persistent agent context with full-text search, stored under `~/.blockrun/`; `SessionMeta` carries the per-session token + cost + tool-call counters.
_Avoid_: Conversation, transcript.

**Update check**:
The once-per-day poll of `registry.npmjs.org/@blockrun/franklin/latest`, cached at `~/.blockrun/version-check.json`. Disable with `FRANKLIN_NO_UPDATE_CHECK=1`; CI environments auto-skip.
_Avoid_: Version ping.

**Telemetry**:
The opt-in local-only JSONL log at `~/.blockrun/telemetry.jsonl`; counts only, never content; written by `franklin telemetry enable`.
_Avoid_: Analytics, tracking.

**Three verticals**:
The product surface — **Dev**, **Trading**, **Content**. Marketing was promoted-out and Content promoted-in in v3.8.5; X-data tools (`SearchX`, `PostToX`) remain in tree but are not hero-positioned.
_Avoid_: Pillars, modes.

**Proxy**:
The Anthropic-compatible HTTP server that lets external CLI agents route through Franklin's wallet and fallback chain; lives in `src/proxy/`.
_Avoid_: Bridge, adapter.

## Relationships

- A **Wallet** funds every **paid request**; a **paid request** is the second leg of an **x402** exchange whose first leg is a **payment probe**.
- The **BlockRun Gateway** is the only counterparty Franklin signs against; both **LLM** calls and **paid tools** flow through it.
- The **router** maps a turn to a **Tier** under a **Routing profile**, picks a primary model + **Fallback chain**, and the proxy walks the chain via **Payment-aware fallback** until one succeeds or the **Per-turn spend cap** trips.
- A turn passes through **Plan-then-execute** → tool calls → **Code verifier** and/or **Groundedness evaluator** → **Polish round** → user. Any of these can be disabled per process via env flag; their existence is governed by the harness audit principle in `docs/adr/0003-harness-as-removable-components.md`.
- **Hero tools** are visible every turn; **Long-tail tools** require **ActivateTool**; **Subagent** spawns a child Franklin and is rate-limited by a cost gate when the parent is on the free profile.
- **ImageGen** + **VideoGen** + **MusicGen** share one **Content piece** under one **Content Library budget**; that budget is independent of the **Per-turn spend cap**.

## Example dialogue

> **Reviewer:** "Why is `franklin --model gpt-oss` silently routing to `nvidia/qwen3-coder-480b`?"
> **Author:** "It's a backward-compat **picker shortcut** — the canonical model behind `gpt-oss` was retired by the gateway, so we point the alias at a member of the **free tier matrix** so muscle memory keeps working without falling back to a paid model."
>
> **Reviewer:** "Then a 402 came back on the auto-routed turn and we still kept going?"
> **Author:** "That's the **payment-aware fallback** — the **fallback chain** treats the payment stage as part of the attempt, so a signing failure or post-payment timeout advances to the next model instead of failing the whole turn."

## Flagged ambiguities

- *Free model* used to mean both "any model the picker labels FREE" and "the agent-tested subset that actually answers and uses tools." Resolved: the agent-tested subset is the **free tier matrix**; the broader picker category stays "free models" lowercase and is informational.
- *Auto* used in two unrelated places: the `blockrun/auto` **routing profile** (model selection) and the `--trust` non-interactive **auto mode** (permission). They are distinct; never use "auto" alone in design discussion.
- *Budget* used to mean the wallet, the per-turn cap, and the Content Library budget. Resolved: use the specific term — **Wallet**, **Per-turn spend cap**, or **Content Library budget**.
- *Mode* used for both **Routing profile** and the **Proxy** server. Resolved: prefer the specific term; "mode" alone is rejected.
