# Changelog

## 3.8.6 — Opt-in telemetry + canonical source back on BlockRunAI

### Added

- **Opt-in local telemetry** — `franklin telemetry [status|enable|
  disable|view|summary]`. Default OFF. When enabled, appends a
  sanitized JSON line per session to
  `~/.blockrun/telemetry.jsonl`. Zero content (no prompts, tool
  inputs/outputs, paths, or wallet addresses); only per-tool counts
  + per-session tokens/cost + model id + driver tag + random
  per-install UUID. No network transmission; the log is purely
  local and inspectable. Designed as truth-data input for future
  positioning decisions, not as a surveillance channel.
- `SessionMeta.toolCallCounts` — per-session tool-invocation
  counters now live in session meta JSON, populated by the agent
  loop and consumed by the telemetry subsystem.

### Changed

- **Canonical source returns to
  `github.com/BlockRunAI/Franklin`** — the original BlockRunAI
  GitHub org is back, so `package.json` `repository` + `bugs`,
  README badges/links, CONTRIBUTING, and the footer on the four
  content docs all point there. The interim `RunFranklin/franklin`
  repo stays as a personal mirror but is no longer the published
  source of truth.

No behavior changes.

## 3.8.5 — Exa research + MusicGen tools + positioning pivot

### Added

- **`ExaSearch`** — neural web search via the BlockRun `/v1/exa/search`
  endpoint ($0.01/call). Optional category filter
  (`github` / `news` / `research paper` / etc.), date range, and
  include/exclude domain lists. Returns ranked URL + title + score.
- **`ExaAnswer`** — cited Q&A via `/v1/exa/answer` ($0.01/call). Agent
  gets a synthesized grounded answer with real source URLs — like
  Perplexity in a tool, no chaining required.
- **`ExaReadUrls`** — batch Markdown fetch via `/v1/exa/contents`
  ($0.002 per URL, up to 100 URLs). Cheaper than WebFetch for bulk
  reading, returns clean text ready for an LLM context window.
- **`MusicGen`** — MiniMax `music-2.5+` music generation via
  `/v1/audio/generations` ($0.1575/track). Generates a ~3-minute MP3
  from a style prompt, optional custom lyrics or instrumental mode.
  Downloads upstream CDN URL to disk immediately (CDN expires in
  ~24h). Content library budget integration mirrors VideoGen.

All four use the same x402 payment flow (Base or Solana) and are
registered in the default tool registry. `ImageGen` + `VideoGen` +
`MusicGen` now share one Content Library instance — a single Content
piece can carry an image, a video, and an audio track under one
budget.

### Changed

- **Positioning repivot** — three verticals are now Dev + Trading +
  Content (previously Marketing + Trading). Marketing as a headline
  vertical required X-data capability we don't fully control; the
  rewrite leads with Telegram-driven content generation instead.
  README + CLAUDE.md + content docs updated to match.
- **`anatomy-of-an-economic-agent.md`** and
  **`i-gave-franklin-100-dollars.md`** rewritten so their example
  prompts don't rely on X/Twitter posting. The browser-automation
  `SearchX` / `PostToX` tools remain in the source tree but are
  demoted from hero positioning.

## 3.8.4 — Canonical source now github.com/RunFranklin/franklin

### Infrastructure

- `package.json` `repository` + `bugs` flipped from `gitlab.com/blockrunai`
  to `github.com/RunFranklin/franklin` — GitHub is now the canonical
  source of truth for the project, with GitLab kept as a read-only
  historical mirror. README badges, community links, and `git clone`
  instructions all updated.
- All commit authors rewritten to `VickyXAI` for the new canonical
  history.

No behavior changes.

## 3.8.3 — Telegram channel, brain auto-recall, think-tag stripping, VideoGen, repository pointer

### Added

- **`franklin telegram`** — drive Franklin from a Telegram chat via
  long-polling. Owner-locked by numeric Telegram user id. Slash commands
  `/help`, `/new`, `/balance`, `/status` are intercepted by the bot
  layer; anything else forwards to the agent. Progressive streaming
  flushes partial responses at paragraph boundaries once the buffer
  crosses 1,500 chars. Cross-process session resume via a new
  `channel` tag on `SessionMeta` — the next boot picks up the latest
  `telegram:<ownerId>` session automatically, so a restart doesn't drop
  the conversation. After each session ends, `extractLearnings` +
  `extractBrainEntities` run with a 15-s hard cap so the brain actually
  learns from Telegram conversations.
- **`VideoGen` capability** — generates MP4 videos via the BlockRun
  `/v1/videos/generations` endpoint (`xai/grok-imagine-video`,
  $0.05/s). Handles x402 payment on Base or Solana, downloads the MP4
  to disk, and optionally records the asset against a Content piece's
  budget. Paid e2e gated behind `RUN_PAID_E2E=1`.
- **Brain auto-recall** — each user turn scans the new input plus the
  previous assistant reply for known entity mentions (word-boundary
  match on names + aliases) and injects `buildEntityContext()` into the
  system prompt. Computed once per user turn and cached across
  planner/executor iterations. `MemoryRecall` is also exposed as an
  agent tool for explicit lookups ("what do we know about X?").
- **`ThinkTagStripper`** — streaming state machine that splits inline
  `<think>…</think>` / `<thinking>` tags emitted by reasoning models in
  the text field (NVIDIA Nemotron, DeepSeek-R1, QwQ) into separate
  text / thinking segments. Tags across chunk boundaries are buffered
  correctly; stored history stays clean. Display-only — brain
  continuity isn't affected.
- **Per-turn reasoning meter** — Ink UI now shows
  `✻ Thought for 3.2s · ~420 tokens` above each committed response
  when the model actually thought. First thinking delta starts the
  clock; first text delta stops it.
- **Tool-call JSON failure classifier** — the `[Tool call to X failed:
  incomplete JSON…]` fallback now reports one of three classified
  causes: canceled (abort signal), cut off (model truncation), or
  malformed (invalid JSON), with actionable follow-up suggestions.
- **Weak-model hallucination guard** — NVIDIA, GLM-4, and Qwen coder
  models now get an explicit "Available tools: …" inventory appended
  to the system prompt, plus a one-shot debug warning if they emit
  literal `[TOOLCALL]` / `<tool_call>` tokens in text. Strong frontier
  models skip the nag to keep prompt cache warm.
- **Streaming markdown renderer** — `renderMarkdownStreaming()` renders
  only closed lines with full inline formatting, holds the trailing
  partial line as plain text until its newline arrives. Eliminates the
  broken-ANSI / mangled-link artifacts caused by regex-matching a
  half-written `**bold**` or `[link](` pair. Link regex tightened to
  reject URLs containing unbalanced parens.

### Changed

- `buildEntityContext()` now loads `observations.jsonl` and
  `relations.jsonl` once at entry and filters in-memory instead of
  doing N+1 file reads per turn.
- `SessionMeta` gained an optional `channel` tag so non-CLI drivers can
  find their own sessions via `findLatestSessionByChannel()`.

### Fixed

- Build preserves the exec bit on `dist/index.js` (`chmod 0o755` in
  `scripts/copy-plugin-assets.mjs`) so a local `rm -rf dist && npm
  run build` produces a runnable binary.
- Opus 4.7 no longer receives the legacy `thinking: { type: 'enabled' }`
  flag — adaptive thinking is built in and the flag triggers a 400.

### Infrastructure

- `package.json` `repository` + `bugs` now point at
  `gitlab.com/blockrunai/franklin` (canonical source). README badges,
  community links, and `git clone` instructions updated to match.

## 3.8.2 (2026-04-17)

Build / release hygiene. No behavior changes.

## Earlier releases

Earlier version history has been consolidated. Run
`git log --oneline` on the repo for the per-commit changelog, or
`npm info @blockrun/franklin` for published release dates.
