# Franklin — The AI Agent with a Wallet

Franklin is an autonomous AI agent that runs directly in VS Code. It doesn't just write text — it spends USDC from a user-funded wallet to execute real work: coding, trading signals, and content generation.

> **Install the latest version from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=blockrun.franklin-vscode)** to get all new features and bug fixes.

---

## Features

- **Chat interface** — Side panel chat powered by the Franklin agent engine
- **55+ models** — Claude Opus/Sonnet/Haiku, Gemini, GPT, Grok, Kimi, DeepSeek, and more, switchable mid-session
- **Image & video generation** — `/image` and `/video` slash commands; the agent picks the best model per prompt and shows a cost preview before spending
- **Smart routing** — Auto/Eco/Premium profiles pick the right model per task automatically
- **Extended thinking** — Watch the model reason step-by-step, collapsible per turn
- **Workflow timeline** — Visual timeline of every tool call and action taken
- **Proactive market data** — detects tickers in your messages and prefetches live prices before the model responds
- **Session history** — Persistent sessions with search and auto-resume
- **Doctor panel** — one-click environment health check (wallet, gateway, Node.js version, MCP config)
- **Usage insights** — 30-day spend and session analytics dashboard
- **Trading dashboard** — launches Franklin's web panel with real-time portfolio and market data
- **Chain switcher** — toggle between Base and Solana payment wallets from the toolbar
- **MCP support** — connect external tools via MCP servers

---

## Requirements

- VS Code 1.85+
- Node.js 20+ (for Trading Dashboard auto-launch)
- A funded wallet on Base or Solana to use paid models (free models require no funding)

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Open the Franklin panel from the Activity Bar
3. Run `franklin setup` in a terminal to create your wallet, or fund the address shown in the panel with USDC
4. Start chatting — free models work immediately, paid models activate once your wallet has USDC

---

## Changelog

### 0.5.1
- **Fix: \"Saved vs Opus\" no longer goes negative** — when meaningful spend hit ImageGen / VideoGen, the savings widget showed numbers like `$-8.79` because chat-only Opus baseline was being compared against total spend (chat + media). Now compared apples-to-apples (media counts on both sides; saved is the chat-side delta, clamped to >= 0). Mirror of upstream PR #36.

### 0.5.0
- **Major core sync** — extension now rides on Franklin core v3.10.0, picking up two months of upstream work since 0.4.5 (no more cherry-pick lag):
  - **Detached background tasks** (v3.10.0) — `Detach` capability spawns long-running work as a separate process; `franklin task list / tail / wait / cancel` to drive them
  - **Skills system** (v3.9.0, #34) — `SKILL.md` loader + registry + bundled `budget-grill` skill, the start of a plugin layer
  - **First-class `Wallet` tool** (#35) — agent can introspect balance / address without going through Bash
  - **Smart timeout recovery** (v3.8.41, #26) — stream timeouts no longer replay expensive previous turns; auto-continue
  - **Default per-turn spend cap raised** — `$0.25` → `$1.00` (v3.8.42, #28) → `$2.00` (v3.9.1) so reference-image edits and multi-stage tasks don't trip on legitimate workflows
  - **Status bar shows active chain** (v3.9.1)
  - **Kimi K2.6 alignment** (v3.9.2), **/model picker trimmed** 28 → 23 (v3.9.3)
  - **Roleplayed JSON tool-calls** + V4 Flash / Omni metadata (v3.9.4)
  - **Nemotron Omni reasoning-prose stripping** (v3.9.5)
  - **Reasoning-model TTFB defaults** + long-task guidance (v3.9.6)
  - Plus proxy fixes (#31), grounding hardening, viem direct-dep cleanup, and more

### 0.4.5
- **New mascot artwork on the empty state** — bigger, transparent-background AI+coin themed Franklin pixel-art portrait (no more dark rounded-rectangle frame, blends seamlessly into any theme background)
- **Per-turn spend cap is now configurable** — new ⚙️ settings field "Per-turn spend cap (USD)" lets you raise the default \$0.25 limit (or set 0 to disable) without editing source; mirrors the new `franklin config set max-turn-spend-usd <n>` CLI key
- **Image-to-image timeout fix** — `gpt-image-2` reference-image edits no longer abort after 60s (the old shared budget couldn't cover reasoning-driven edits + base64 upload + x402 retry); image-to-image now gets 180s, text-to-image keeps 60s
- Synced with Franklin core: PR #19 (i2i timeout), PR #20 (configurable spend cap), PR #21 (README VS Code section)

### 0.4.3
- **History replay shows generated media inline** — closing and reopening a conversation now re-renders any images / videos as preview cards instead of dropping them
- **"+" New chat truly resets the session** — previously only the UI cleared while the agent kept the same `sessionId`, leaking tool guards (`ImageGen disabled`) and prior context into what looked like a new chat
- **Auto-resume warm sessions** — opening the panel within 24h of the last reply continues the same chat instead of fragmenting `/history` into pieces
- **Workflow timeline polish** — line and dots now blend like beads on a string (continuous track, hollow thinking dots filled with editor bg, soft pulsing shadow on active tools)
- **Tool name shows model for ImageGen / VideoGen** — e.g. `⚙ ImageGen   gpt-image-2` so the picked model is visible at a glance; long prompts hidden to keep the timeline scannable
- Synced with Franklin core v3.8.36–v3.8.39: image-to-image (gpt-image-2) support, evaluator hardening for short user inputs, grounding retry forces tool use, longer LLM timeouts (45s/90s) for Sonnet / Opus reasoning

### 0.4.1
- **Vision-capable models can now actually see images** — Read on `.png` / `.jpg` / `.gif` / `.webp` returns the bytes inline as a `tool_result` content block; combined with the gateway-side fix (BlockRun gateway commit `6ac64da`), Sonnet / Opus / GPT-4o / Gemini now describe user-provided images instead of hallucinating. (Closes #10 via core PR #11.)

### 0.4.0
- **Settings popover** — new ⚙️ button in the composer toolbar to toggle payment chain (Base / Solana) and set default image / video models in one place; Save dismisses the popover
- **Inline edit diff cards** — Edit / Write / MultiEdit show a green/red diff in the chat with **Open** and **Revert** buttons; Revert restores the file from an in-memory snapshot
- **Local-path seed images for VideoGen** — `image_url` on VideoGen now accepts local file paths (auto-converted to a data URL, capped at 4 MB)
- **Routing-mode picker** — when the active model is Auto / Eco / Premium the picker shows a single profile card with a toggle; click the toggle to exit routing mode and pick a specific model
- **Preserve routing label across turns** — Auto mode no longer flickers to the per-turn routed model name; the picker stays on "Auto" until you change it
- **Model picker search + recent** — fuzzy search bar at the top, 3 most recently used models pinned under "Recent"
- **Inline media preview** — generated images / videos from ImageGen / VideoGen appear as inline preview cards right below the tool result
- **AskUser inline prompts** — cost previews and multi-option questions from the agent render as clickable buttons instead of silently waiting
- **Streaming caret** — blinking `▍` at the end of the assistant's reply while it's being streamed
- **Empty-state example prompts** — three clickable starter prompts on first launch
- **Inline `franklin config` commands** — typing `franklin config list` / `set` / `get` / `unset` in the chat is handled locally without round-tripping to the LLM
- **Default model is now `blockrun/auto`** (was `google/gemini-2.5-flash`) — matches the CLI default so the Smart Router picks a model per request
- Various layout fixes (empty-state centering, model dropdown search clipping, settings panel positioning on narrow sidebars)
- Synced with Franklin core v3.8.35: prompt refinement for media, VideoGen async submit + polled settlement

### 0.3.0
- Added **image & video generation** — `/image` and `/video` slash commands prefill a natural-language prompt; the agent picks the right model, shows a cost preview with cheaper/premium alternatives, and only spends after you confirm
- Added **in-chat confirmation prompts** — when the agent needs a yes/no or a choice (e.g. media cost preview), a prompt card now appears inline with buttons instead of silently hanging
- Synced with Franklin core v3.8.31–v3.8.34: LLM-routed media model selection, model-choice-preserving status bar, exit/quit mid-turn, reliability pass (ESM, timeouts, retry budget)

### 0.2.1
- Fixed model switching bug — selected model was reverting to default (Gemini 2.5 Flash) after each turn, because `baseModel` wasn't being updated alongside `model`
- Fixed Trading Dashboard on Windows — PATH now split with platform delimiter, executables searched with `.cmd`/`.exe` suffixes, `%APPDATA%\npm` added to search paths

### 0.2.0
- Added **chain switcher** — toggle Base ↔ Solana payment chain from the toolbar badge
- Added **prefetch status indicator** — shows a live pulse "Fetching market data for BTC…" when the agent proactively pulls prices before responding
- Updated free model lineup: GLM-4.7 (new default), Qwen3 Coder 480B, Llama 4 Maverick, Qwen3 Next 80B Thinking (NEW)
- Synced with Franklin core v3.8.9–v3.8.30: unified turn analyzer, proactive prefetch, stocks via x402, panel Base ↔ Solana chain switcher

### 0.1.0
- Initial release
- Chat panel with model picker, wallet balance display, session history with search
- Doctor health panel, usage insights dashboard
- Trading dashboard icon (auto-launches `franklin panel` in the background)
- History dropdown, session auto-resume

---

## Links

- [Website](https://blockrun.ai)
- [GitHub](https://github.com/BlockRunAI/Franklin)
- [Issues](https://github.com/BlockRunAI/Franklin/issues)
