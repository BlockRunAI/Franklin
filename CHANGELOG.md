# Changelog

## 1.2.0 (2026-04-04)

### Bug Fixes (36 fixes across 5 rounds)

**Security**
- Permission system no longer defaults to allow on EOF — piped input now denies destructive ops
- Glob pattern matching in permissions: `*` matches non-space only (was matching everything including `/`)
- Global `unhandledRejection` + `uncaughtException` handlers prevent silent crashes

**Memory & Resource Leaks**
- WebFetch reader released on exception (try-finally)
- ImageGen/WebFetch timeout timers cleaned up on all error paths
- Proxy stream reader cancelled after timeout
- Stats flush timer cleaned up on process exit

**Race Conditions**
- Solana wallet init uses promise-cache to prevent concurrent initialization
- Stats uses in-memory cache + debounced write (no more load→save races)
- Proxy `lastOutputTokens` tracked per-model (no cross-request pollution)
- Daemon stop waits for process exit before removing PID file

**Error Handling**
- Proxy `pump()` now logs streaming errors (was silently swallowing)
- Proxy server has `error` event handler — port-in-use shows clear message
- Proxy handles `SIGTERM` for graceful container shutdown
- Init warns when settings.json is corrupted (was silent)
- Config `saveConfig` catches disk errors

**Validation**
- Port validation on `init`, `daemon`, `proxy` commands (NaN → error)
- `logs --lines` validates input (NaN → default 50)
- `config unset` validates key against known keys
- WebSearch `max_results` capped at 20

**Pricing**
- Haiku display price fixed ($0.8/$4 → $1/$5)
- DeepSeek output price added to Ink UI picker

**Tools**
- Edit tool shows similar lines when string not found (was showing first 10 lines)
- Bash timeout message now mentions timeout parameter
- Native grep handles `**/*.ts` patterns
- `rg --version` check cached (was re-running every grep call)
- Glob: only `**` triggers recursion (was over-recursing on `/`)
- Glob: symlink loop protection via realpath tracking
- Glob: suggests `**/<pattern>` when non-recursive finds nothing

**Timeouts**
- Git context operations: 5s timeout (prevents startup hang)
- Proxy stream pump: 5min timeout
- WebSearch: 15s timeout
- SubAgent: 5min total timeout

### New Features

- **Escape to abort**: Press Esc during generation to cancel the current turn
- **Per-turn cost display**: Session cost shown after every response (e.g. `$0.0042 session`)
- **`/clear` command**: Clear conversation display
- **Terminal UI commands**: `/model`, `/cost`, `/help` now work in piped/non-TTY mode
- **Improved system prompt**: All 11 tools documented with constraints (file size limits, output caps, defaults)
- **Tool descriptions enhanced**: Read, Grep, Glob schemas document key limits
- **Model shortcuts synced**: 16 missing shortcuts added to terminal picker
- **Router improvement**: Code block detection (```) boosts complexity score; byte-length token estimation
- **Banner shows `/help` hint**
- **Input box shows `esc to abort/quit`**

## 0.9.13 (2026-03-30)

### Features

- **`runcode init`**: Permanently configure Claude Code to use runcode — writes `~/.claude/settings.json` and installs a macOS LaunchAgent so the proxy auto-starts on login. Run `claude` directly after init, no need to remember `runcode start`
- **`runcode daemon start|stop|status`**: Run the proxy as a background process, detached from the terminal
- **`runcode uninit`**: Remove runcode from Claude Code settings and uninstall the LaunchAgent

### Bug Fixes

- **Smart routing now default**: When no `--model` flag is specified, `blockrun/auto` is used automatically — every request is classified and routed to the optimal model instead of always paying for Sonnet
- **Fixed OAuth token deletion**: Also deletes `CLAUDE_CODE_OAUTH_TOKEN` (the actual env var Claude Code uses) so proxy auth is exclusive with no conflicts
- **Restored `src/proxy/sse-translator.ts`**: TypeScript source was missing (only compiled JS existed). Restored from compiled output — required for non-Anthropic models that return OpenAI-format SSE streams
- **Version deduplication**: `start.ts` no longer re-reads `package.json` at runtime; version flows from `index.ts`

## 0.9.12 (2026-03-29)

### Bug Fixes

- **Banner display**: Removed leading blank line from ASCII art so the first visible line is the art itself, not an empty line

## 0.9.11 (2026-03-29)

### Features

- **Welcome banner**: `runcode start` now displays a gold ASCII art RUNCODE banner with tagline on launch, so users and onlookers can immediately see BlockRun is powering the session

## 0.9.10 (2026-03-29)

### Bug Fixes

- **Terminal distortion (complete fix)**: `fallback.ts` was still using `console.error` for network error messages (e.g., `[fallback] anthropic/claude-sonnet-4.6 network error: fetch failed`), which printed to stderr — also inherited by Claude Code's terminal. All fallback error messages now go to the log file only. Combined with v0.9.9, runcode is now fully silent while Claude Code is running

## 0.9.9 (2026-03-28)

### Bug Fixes

- **Terminal distortion (root cause fix)**: Removed `console.log` from the proxy's runtime `log()` function. Claude Code is launched with `stdio: inherit`, so runcode and Claude Code share the same terminal. Printing to stdout while Claude Code's `* Thinking…` spinner writes `\r` to the same fd caused the garbled/overwritten display. Runtime messages now go to `~/.blockrun/runcode-debug.log` only — use `runcode logs` or `runcode logs -f` to monitor live

## 0.9.8 (2026-03-28)

### Bug Fixes

- **Terminal distortion in `runcode logs`**: Strip ANSI escape sequences and carriage returns from log entries before writing to `~/.blockrun/runcode-debug.log`. Previously, spinner/progress output from Claude Code (e.g., `* Thinking…`) contained `\r` characters that caused cursor jumps and screen corruption when replayed by `runcode logs` or `runcode logs -f`

## 0.9.7 (2026-03-27)

### Features

- **`runcode logs` command**: View debug logs with `runcode logs`, tail with `-f`, show last N lines with `-n 100`, clear with `--clear`. Auto-rotates at 10MB to prevent disk bloat
- **Always-on logging**: `[runcode]` messages now always written to `~/.blockrun/runcode-debug.log` (no need for `--debug` flag for basic logs)

### Bug Fixes

- **Fallback + payment mismatch**: When fallback switches to a different model and the backend returns 402 (payment required), the payment handler now uses the correct fallback model body instead of the original failed model body

## 0.9.6 (2026-03-26)

### Bug Fixes

- **Login prompt fix**: Use `ANTHROPIC_AUTH_TOKEN` instead of `ANTHROPIC_API_KEY` to prevent Claude Code from showing login prompt when launched via `runcode start` (thanks @0xCheetah1, #2)
- Consistent env var in all output messages (proxy-only mode, error fallback)

## 0.9.5 (2026-03-25)

### Bug Fixes

- **Fallback 400 errors**: Removed virtual routing profiles (`blockrun/auto`, `blockrun/eco`) from fallback chain — backend doesn't recognize these, causing 400 loops. Fallback now uses concrete models: `deepseek/deepseek-chat` → `google/gemini-2.5-flash` → `nvidia/nemotron-ultra-253b`
- **Safety filter**: `buildFallbackChain()` now strips routing profiles to prevent them from ever reaching the backend
- **`runcode start` automation**: Smarter claude binary detection — searches PATH + common install locations (`~/.local/bin`, `/usr/local/bin`). Falls back to printing manual env vars instead of crashing

### Docs

- Use `blockrun.ai/runcode-install` short URL in README install command

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
- Usage statistics with `runcode stats`
- User-Agent and version headers on backend requests

### Bug Fixes

- Adaptive max_tokens: `max(lastOutput*2, 4096)` prevents token starvation
- Debug logs to file (`~/.blockrun/runcode-debug.log`) instead of stderr
- Always inject max_tokens default to prevent 400 on Turn 2+
- Fix version mismatch, token parsing, port validation

## 0.9.0 (2026-03-20)

### Features

- Initial release
- Local proxy for Claude Code → BlockRun API
- Dual chain support (Base + Solana)
- x402 micropayment signing
- `runcode setup`, `runcode start`, `runcode models`, `runcode balance` commands
- 40+ model support with `--model` flag
- Install script for one-line setup
