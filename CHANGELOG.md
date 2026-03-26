# Changelog

## 0.9.5 (2026-03-25)

### Bug Fixes

- **Fallback 400 errors**: Removed virtual routing profiles (`blockrun/auto`, `blockrun/eco`) from fallback chain — backend doesn't recognize these, causing 400 loops. Fallback now uses concrete models: `deepseek/deepseek-chat` → `google/gemini-2.5-flash` → `nvidia/nemotron-ultra-253b`
- **Safety filter**: `buildFallbackChain()` now strips routing profiles to prevent them from ever reaching the backend
- **`brcc start` automation**: Smarter claude binary detection — searches PATH + common install locations (`~/.local/bin`, `/usr/local/bin`). Falls back to printing manual env vars instead of crashing

### Docs

- Use `blockrun.ai/brcc-install` short URL in README install command

## 0.9.4 (2026-03-24)

### Bug Fixes

- Override native Anthropic model IDs (e.g. `claude-sonnet-4-6-20250514`) while respecting BlockRun model IDs that contain `/`
- Skip npm publish in CI if version already exists

### Docs

- Updated README for v0.9.3 — 50+ models, new shortcuts, nemotron default

## 0.9.3 (2026-03-24)

### Features

- Expand model catalog to 50+ models with updated routing and pricing
- New in-session shortcuts: `use grok-4`, `use codex`, `use kimi`, `use devstral`, `use qwen-coder`, and more

## 0.9.2 (2026-03-23)

### Bug Fixes

- Wrap backend errors in Anthropic format to prevent Claude Code from showing login page
- Streaming memory cap (5MB) to prevent OOM on long sessions
- Complete model pricing table for accurate cost tracking
- Improve error messages and show debug log path

## 0.9.1 (2026-03-22)

### Features

- Built-in smart routing from ClawRouter — 15-dimension classifier for automatic model selection
- Default to `blockrun/auto` with 4 routing profiles: auto, eco, premium, free
- In-session model switching — type `use gpt` or `use deepseek` inside Claude Code
- Automatic fallback chain when models fail (429, 5xx)
- Usage statistics with `brcc stats`
- User-Agent and version headers on backend requests

### Bug Fixes

- Adaptive max_tokens: `max(lastOutput*2, 4096)` prevents token starvation
- Debug logs to file (`~/.blockrun/brcc-debug.log`) instead of stderr
- Always inject max_tokens default to prevent 400 on Turn 2+
- Fix version mismatch, token parsing, port validation

## 0.9.0 (2026-03-20)

### Features

- Initial release
- Local proxy for Claude Code → BlockRun API
- Dual chain support (Base + Solana)
- x402 micropayment signing
- `brcc setup`, `brcc start`, `brcc models`, `brcc balance` commands
- 40+ model support with `--model` flag
- Install script for one-line setup
