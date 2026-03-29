# Changelog

## 0.9.12 (2026-03-29)

### Bug Fixes

- **Banner display**: Removed leading blank line from ASCII art so the first visible line is the art itself, not an empty line

## 0.9.11 (2026-03-29)

### Features

- **Welcome banner**: `brcc start` now displays a gold ASCII art BRCC banner with tagline on launch, so users and onlookers can immediately see BlockRun is powering the session

## 0.9.10 (2026-03-29)

### Bug Fixes

- **Terminal distortion (complete fix)**: `fallback.ts` was still using `console.error` for network error messages (e.g., `[fallback] anthropic/claude-sonnet-4.6 network error: fetch failed`), which printed to stderr — also inherited by Claude Code's terminal. All fallback error messages now go to the log file only. Combined with v0.9.9, brcc is now fully silent while Claude Code is running

## 0.9.9 (2026-03-28)

### Bug Fixes

- **Terminal distortion (root cause fix)**: Removed `console.log` from the proxy's runtime `log()` function. Claude Code is launched with `stdio: inherit`, so brcc and Claude Code share the same terminal. Printing to stdout while Claude Code's `* Thinking…` spinner writes `\r` to the same fd caused the garbled/overwritten display. Runtime messages now go to `~/.blockrun/brcc-debug.log` only — use `brcc logs` or `brcc logs -f` to monitor live

## 0.9.8 (2026-03-28)

### Bug Fixes

- **Terminal distortion in `brcc logs`**: Strip ANSI escape sequences and carriage returns from log entries before writing to `~/.blockrun/brcc-debug.log`. Previously, spinner/progress output from Claude Code (e.g., `* Thinking…`) contained `\r` characters that caused cursor jumps and screen corruption when replayed by `brcc logs` or `brcc logs -f`

## 0.9.7 (2026-03-27)

### Features

- **`brcc logs` command**: View debug logs with `brcc logs`, tail with `-f`, show last N lines with `-n 100`, clear with `--clear`. Auto-rotates at 10MB to prevent disk bloat
- **Always-on logging**: `[brcc]` messages now always written to `~/.blockrun/brcc-debug.log` (no need for `--debug` flag for basic logs)

### Bug Fixes

- **Fallback + payment mismatch**: When fallback switches to a different model and the backend returns 402 (payment required), the payment handler now uses the correct fallback model body instead of the original failed model body

## 0.9.6 (2026-03-26)

### Bug Fixes

- **Login prompt fix**: Use `ANTHROPIC_AUTH_TOKEN` instead of `ANTHROPIC_API_KEY` to prevent Claude Code from showing login prompt when launched via `brcc start` (thanks @0xCheetah1, #2)
- Consistent env var in all output messages (proxy-only mode, error fallback)

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
