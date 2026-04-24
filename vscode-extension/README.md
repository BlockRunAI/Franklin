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
