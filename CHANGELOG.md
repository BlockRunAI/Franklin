# Changelog

## 3.2.2 (2026-04-11) — Bigger portrait + blockrun.ai tagline

Two visual polish fixes on top of v3.2.1's portrait banner.

### Changed
- **Portrait is now recognizable.** v3.2.1 rendered the full Duplessis
  painting at 20×10, which put Ben's face in a 17-char-wide × 10-row
  block — too small, and most of the pixels were spent on the painting's
  background and Ben's body. User feedback: "看不清" (can't see clearly).
  Now:
  1. Source image is pre-cropped with `sips --cropToHeightWidth 1400 1400
     --cropOffset 400 500` to a square focused on the face.
  2. chafa renders at `30x14` → actual output is 28 chars × 14 rows, a
     2× increase in area with all pixels now dedicated to the face.
  3. Side-by-side layout threshold raised from 90 to 100 terminal cols
     to accommodate the wider portrait.
  4. Text is vertically re-centred inside the 14-row portrait (4 rows
     padding above, 4 below) so the FRANKLIN block sits in the middle.
- **Tagline: `Franklin` → `blockrun.ai`.** The big block-letter FRANKLIN
  above already says the product name. The tagline word underneath was
  redundant. Replacing it with `blockrun.ai` gives readers a real live
  URL (unlike franklin.run which we own but haven't deployed — see v3.1.0
  changelog). Both layouts (side-by-side + text-only) updated.

### Test updates
- `test/local.mjs` and `test/e2e.mjs` now check for `blockrun.ai` +
  `The AI agent with a wallet` in the startup banner instead of the
  literal word `Franklin` (which is now only in the block-letter art).

### Not changed
- Everything else from v3.2.1 — agent loop, `franklin social`, tools,
  wallet, sessions, Chrome profile location.

## 3.2.1 (2026-04-11) — Benjamin Franklin portrait banner

Visual upgrade. The startup banner now shows Benjamin Franklin's face
next to the FRANKLIN text block, side-by-side.

### Changed
- **`src/banner.ts`** — Rendered a 10-row × 17-col Ben Franklin portrait
  from the Joseph Duplessis 1785 oil painting (the same source image as
  the face on the US $100 bill). Converted via `chafa --size=20x10
  --symbols=block --colors=256` and baked into the TS source as a
  hex-escaped string array. No runtime dependency on chafa — it's only
  used at build time to regenerate the portrait if we ever update it.
- **Side-by-side layout** when terminal width ≥ 90 columns:
  ```
  [portrait 10 rows]   [gap]   [FRANKLIN gradient text]
                                Franklin · The AI agent with a wallet · vX.Y.Z
  ```
  The FRANKLIN text is vertically centred inside the portrait's 10 rows.
- **Text-only fallback** for narrow terminals (<90 cols): identical to
  v3.2.0's banner. Nobody gets a wrapped/mangled hero.
- **Gradient preserved** — gold→emerald (`#FFD700` → `#10B981`) across the
  6 rows of FRANKLIN block letters, unchanged from v3.1.0.

### Rationale
Block-letter "FRANKLIN" was generic. Every CLI tool has some block-letter
ASCII banner. Adding a Ben Franklin face ties the brand to the *person*
the tool is named after and to the Benjamins / $100 bill cultural anchor
in one glance. Ben's face is literally the center of the $100 bill, so
one portrait gives us both identity anchors at once. Docker has a whale,
Kubernetes has a helm, Laravel has an "L" — Franklin now has Ben's face.

Public domain painting, public domain conversion, zero licensing risk.

### Not changed
- Every other subsystem — agent loop, `franklin social`, wallet, tools,
  sessions — identical to v3.2.0.

## 3.2.0 (2026-04-11) — Native X bot (franklin social)

First shipped user-facing workflow: **`franklin social`** is a fully native
X (Twitter) auto-reply subsystem living in `src/social/`. No MCP dep, no
plugin SDK indirection, no external CLI. Ships as part of the core npm
package. Pattern-for-pattern port of mguozhen/social-bot with several
behavioural fixes; architecture fits Franklin's plugin-first core cleanly.

### Added
- **`src/social/` subsystem** — ~1,200 lines of native TypeScript across:
  - `browser.ts` — Playwright-core wrapper with persistent Chrome profile at
    `~/.blockrun/social-chrome-profile/`. Nine primitives: `open`,
    `snapshot`, `click`, `clickXY`, `type`, `press`, `scroll`, `screenshot`,
    `getUrl`. All argv-based — zero shell injection surface even if the
    LLM emits `$(rm -rf /)` as reply text.
  - `a11y.ts` — `[depth-idx]` ref tree helpers ported from social-bot's
    Python regex model. Elements are located by role + label, not CSS —
    survives X/Reddit DOM changes better than selectors.
  - `db.ts` — JSONL-backed dedup and reply log at
    `~/.blockrun/social-replies.jsonl` and `~/.blockrun/social-prekeys.jsonl`.
    No SQLite dep. In-memory indexes for O(1) lookups. URL canonicalisation
    (x.com ≡ twitter.com ≡ mobile.twitter.com; strips `?s=20` trackers).
  - `ai.ts` — Uses Franklin's `ModelClient` so reply generation gets
    multi-model routing, x402 payments, and automatic fallback for free.
    `detectProduct()` is a pure keyword-score function (no LLM call).
  - `x.ts` — End-to-end X flow: search → pre-key dedup → product routing
    → generate reply → canonical-URL dedup → post → confirmation check.
  - `config.ts` — Typed config at `~/.blockrun/social-config.json` with
    handle, products (name + description + trigger_keywords), X search
    queries, daily target, min delay, reply style rules.
- **`src/commands/social.ts`** — CLI dispatcher for:
  - `franklin social setup` — install chromium (`npx playwright install
    chromium`, one-time ~150MB), scaffold default config.
  - `franklin social login x` — open browser to x.com, wait for manual
    login, cookies persist in the profile dir for all future runs.
  - `franklin social run [--dry-run|--live] [-m <model>]` — search all
    configured queries, generate drafts, optionally post. Default is dry-run
    for safety; `--live` required to actually post.
  - `franklin social stats` — posted/drafted/skipped totals, total cost,
    by-product breakdown.
  - `franklin social config [path|show|edit]` — inspect or edit the config.
- **`playwright-core` dependency** (~2MB). Chromium binary downloaded
  lazily on first run via `franklin social setup`.

### Improved over social-bot's approach
1. **Pre-key dedup runs BEFORE the LLM call.** social-bot generates a
   reply with Sonnet, then opens the tweet, then checks dedup — wasting
   tokens on every duplicate. Franklin hashes
   `(author + snippet[0:80] + time)` first and skips duplicates without any
   LLM spend.
2. **`'failed'` status does NOT blacklist.** social-bot permanently blocks
   any URL that failed once, so transient network errors kill the lead
   forever. Franklin only blacklists `'posted'` — failures can be retried
   on the next run.
3. **Multi-model routing.** social-bot hardcodes `claude-sonnet-4-6` for
   every call, including throwaway filter decisions. Franklin's default
   runs on NVIDIA Nemotron free tier for zero cost; `--model` or the
   `reply_style.model_tier` config escalates per-task.
4. **No shell injection.** social-bot's `browse type '<text>'` with
   `shell=True` f-string interpolation is an LLM-output→RCE primitive.
   Franklin's Playwright calls are all argv arrays.
5. **URL canonicalisation.** x.com/twitter.com/mobile.twitter.com are
   aliased; `?s=20` tracking params stripped; trailing slashes removed.
   social-bot stores raw URLs, so the same tweet can be replied-to twice
   under different URL shapes.

### Retired
- **`src/plugins-bundled/social/`** — the plugin-SDK-based social
  scaffold. It was only ever a skeleton; the real implementation never
  landed in that form. Plugin SDK itself stays for future third-party
  plugins — only the bundled social dir is removed.

### Not changed
- Agent loop, tools, plugin SDK contract, wallet, sessions, payment flow —
  identical to v3.1.2.
- The `runcode` alias still works through the 60-day window from v3.0.0.

## 3.1.2 (2026-04-11) — Upstream 503 auto-retry

Reported by user: gateway returned `HTTP 503 "Service temporarily unavailable:
All workers are busy, please retry later"` and Franklin surfaced the error
directly instead of retrying. Root cause traced and fixed.

### Fixed
- **Gateway 503 errors now correctly classify as transient and retry.**
  `loop.ts` already had an exponential-backoff retry path
  (1s → 2s → 4s, up to 3 attempts) for any `isTransient` error. But
  `llm.ts` was extracting only the inner `.message` field from JSON error
  bodies before throwing — which stripped the HTTP status code AND the
  literal "Service Unavailable" string. The result: `classifyAgentError`
  saw only *"Service temporarily unavailable: All workers are busy..."*,
  which didn't match any of its server-error patterns, so the error was
  categorised as `unknown / isTransient: false` and the retry branch was
  skipped. Two fixes stacked for defense-in-depth:
  1. **`llm.ts`** — the thrown `Error` now includes the HTTP status:
     `HTTP 503: Service temporarily unavailable: ...`. The classifier's
     existing `'503'` pattern picks this up directly.
  2. **`error-classifier.ts`** — broadened the `server` category with
     `temporarily unavailable`, `workers are busy`, `server busy`,
     `overloaded`, `please retry later`, `retry in a few`, and
     `upstream error`. Even if the status prefix is ever lost again,
     the inner text still classifies correctly.
- **Regression test added** (`test/local.mjs`) — locks in classification
  for all three error shapes (with status prefix, inner message only,
  and just the "workers are busy" fragment).

### What the user sees now
A 503 from the gateway triggers: `Retrying (1/3) after Server error...`
in the scrollback, a 2-second wait, then another attempt. If all three
attempts fail, the final error shows with a recovery tip. Previously,
the very first 503 was shown to the user with no retry attempt at all.

### Not changed
- Agent loop, plugin SDK, tools, wallet, session storage — identical to v3.1.1.
- Token accounting on successful streams is unchanged.
- The retry count, backoff curve, and max attempts are unchanged (3 / 1s→2s→4s).

## 3.1.1 (2026-04-11) — /model picker fixes

Two bugs reported by user **Cheetah**, both fixed.

### Fixed
- **`/model` picker only showed 16 models.** The Ink UI had a hardcoded
  16-entry `PICKER_MODELS` array that was completely disconnected from the
  canonical list in `src/pricing.ts` (55+ models). Users couldn't reach GLM,
  Grok, Kimi, Minimax, Gemini 3.1 Pro, O1, O3, Codex, or most of the NVIDIA
  free tier from the picker at all. Now the picker pulls from a single
  shared source (`PICKER_CATEGORIES` in `src/ui/model-picker.ts`) with
  **32 models across 6 categories**: Promo, Smart routing, Premium frontier,
  Reasoning, Budget, Free. Every ID is verified against `pricing.ts`.
- **Switching models wiped the scrollback.** When a user typed `/model`
  mid-session, Ink's `mode === 'model-picker'` branch returned an entirely
  different render tree, which unmounted the two `<Static>` components
  holding the conversation scrollback (`completedTools` and
  `committedResponses`). When the picker closed, they re-mounted fresh —
  and Ink's `<Static>` doesn't re-commit already-written items, so the
  screen came back visually empty. The agent's message history was actually
  intact on the backend, but from the user's seat the context was gone.
  Now the picker renders inline below the scrollback as an overlay, and
  the Static components stay mounted across mode transitions.

### Internal
- Single source of truth: `PICKER_CATEGORIES`, `PICKER_MODELS_FLAT`, and
  `ModelEntry` are now exported from `src/ui/model-picker.ts` and imported
  by `src/ui/app.tsx`. Previously the Ink UI and the readline picker had
  two independent hardcoded lists that could drift.
- `src/ui/app.tsx` render function always returns the same tree shape
  regardless of `mode` — safer for future UI modes (settings, wallet
  details, etc.) to share scrollback instead of unmounting it.

### Not changed
- Agent loop, plugin SDK, tools, tests, wallet, session storage, payment
  flow — all identical to v3.1.0.
- The `runcode` alias still works through the 60-day window from v3.0.0.

## 3.1.0 (2026-04-11) — Brand cleanup

Remove premature references to `franklin.run` and `franklin.bet` domains
from code and docs. We own both domains but haven't deployed them yet —
linking to URLs that 404 is worse than not linking at all. When the sites
are live, the anchors come back in a later release.

### Changed
- **Banner** — Restored the smooth 6-row gold→emerald gradient
  (`#FFD700` → `#10B981`), rolling back v3.0.2's pure-gold and v3.0.3's
  metallic-gold experiments. Dropped the
  "Marketing: franklin.run · Trading: franklin.bet" tagline line since
  those domains aren't live yet. Restored the `interpolateHex()` helper
  for smooth per-row interpolation.
- **CLI description** — Dropped "Marketing workflows: franklin.run" and
  "Trading workflows: franklin.bet" lines from `franklin --help` text.
- **package.json** — `homepage` now points to
  `https://github.com/BlockRunAI/franklin` (real URL). Description
  shortened, no domain references.
- **README** — Removed shields.io badges linking to franklin.run/.bet,
  removed all markdown links to those URLs, cleaned the competitor
  comparison table and Links section. Product positioning ("Marketing
  agent" / "Trading agent") stays intact — only the URL anchors come out.
- **CLAUDE.md** — Same domain cleanup.

### Not changed
- Everything else from v3.0.0. This is a pure documentation/brand cleanup.
- Plugin SDK, agent loop, tools, tests, wallet, sessions all identical.
- `runcode` alias still works (60-day compatibility window from v3.0.0).

## 3.0.0 (2026-04-11) — From RunCode to Franklin

**Major rebrand.** RunCode is now **Franklin — The AI agent with a wallet.**

### Why the rename

RunCode was positioned as "a better Claude Code with multi-model support." That's defensive — it defines us by what we're not (not rate-limited, not subscription-locked, not Anthropic-only) rather than what we are. The moment Claude Code changes pricing, that entire differentiation evaporates.

Over the last three weeks of building and iterating, we realized the real opportunity isn't being a better coding tool. It's being the first AI agent that can actually **spend money to get work done**, not just write text about it.

- **Claude Code** writes code.
- **Hermes Agent** grows with you.
- **OpenClaw** helps personally.
- **Franklin** takes your USDC and autonomously runs marketing campaigns, trading signals, and content workflows.

Benjamin Franklin was the founding father who said "time is money," printed his own currency, and deployed capital across the Atlantic to fund a revolution. Our Franklin does the same for AI agents: it turns your wallet into an autonomous economic engine.

### Two TLDs, two products

Franklin is not a single domain. It's a brand umbrella with two verticals:

- **[franklin.run](https://franklin.run)** — Marketing agent (Reddit, IG DM, content generation, campaigns)
- **[franklin.bet](https://franklin.bet)** — Trading agent (signals, market research, risk analysis)

Each TLD is the product definition. `.run` = run campaigns and workflows. `.bet` = place positions and take calculated risks. The URL IS the product.

### Category

**Autonomous Economic Agent** — AI that spends money autonomously within wallet-enforced budget caps to deliver outcomes, not just text.

Built on three layers:
1. **x402 micropayment protocol** — HTTP 402 native payments, wallet-as-identity
2. **BlockRun Gateway** — aggregates 55+ LLMs + paid APIs behind one wallet
3. **Franklin Agent** — reference client with Plugin SDK (this repo)

### What changed

- **Package:** `@blockrun/runcode` → `@blockrun/franklin` (new name on npm)
- **CLI command:** `franklin` is the primary binary; `runcode` remains as a **60-day alias** so existing scripts don't break
- **Banner:** new FRANKLIN ASCII art with gold→green "money" gradient
- **README:** complete rewrite with new positioning, two-TLD architecture, Autonomous Economic Agent category framing
- **CLI help text:** all mentions of "coding agent" updated to "the AI agent with a wallet"
- **GitHub repo description:** updated
- **Version:** 2.8.0 → 3.0.0 (major bump because this is a category-level change, not a feature addition)

### What did NOT change

- **All plugins work identically** — `social`, `marketing`, any future verticals
- **Plugin SDK v2.7** contract is unchanged — no migration needed for third-party plugins
- **Hermes patterns from v2.8** (prompt caching, structured compaction, session search, insights) all remain
- **Config files at `~/.blockrun/`** are unchanged — no migration needed
- **Wallet, sessions, stats** all preserved
- **Payment flow, API compatibility, E2E behavior** — identical

### Migration

Zero work required for existing users:

```bash
# Old command (still works for 60 days)
runcode marketing run

# New command (recommended)
franklin marketing run
```

When you're ready, switch package names:

```bash
npm uninstall -g @blockrun/runcode
npm install -g @blockrun/franklin
```

After v3.1.0, the `runcode` alias will be deprecated. Full removal in v3.2.0 (at least 60 days out).

### The tagline

> **Franklin runs your money.**

Short. Active. Ownership. Economic. Tweet-grade.

Long form:
> **The AI agent with a wallet. While others chat, Franklin spends — turning your USDC into real work.**

---

## 2.8.0 (2026-04-10)

### Added — Hermes Agent patterns adopted

Major upgrade inspired by [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent).

- **Anthropic prompt caching (`system_and_3` strategy)** — 4 cache_control breakpoints on system prompt + last 3 messages. ~75% input token savings on multi-turn Anthropic conversations. Pattern from Hermes `agent/prompt_caching.py`.
- **Structured context compression** — replaced free-form summary with Goal/Progress/Decisions/Files/Tool Results/Preferences/Next Steps template. Supports iterative updates (merges existing `[CONTEXT COMPACTION]` rather than nesting). Pattern from Hermes `agent/context_compressor.py`.
- **`/search <query>` + `runcode search`** — full-text search across past sessions. Phrase search with `"..."`, relevance-ranked results with snippets. Zero-dependency in-memory tokenized search over JSONL.
- **`/insights [--days N]` + `runcode insights`** — rich usage analytics: cost breakdown by model, daily activity sparklines, projections (per day/month/year), avg cost per request, savings vs Claude Opus. Pattern from Hermes `agent/insights.py`.

### Changed

- Compacted history now uses `[CONTEXT COMPACTION]` header (was `[Context from earlier conversation]`) for detection by future compactions.
- Session storage exports `getSessionFilePath()` helper for external readers.

## 2.7.0 (2026-04-10)

### Architecture: Plugin SDK

Major refactor inspired by OpenClaw's plugin-first architecture.

- **`src/plugin-sdk/`** — public contract for plugins (Workflow, Channel, Plugin, Tracker)
- **`src/plugins/`** — core plugin runtime: registry, loader, runner (plugin-agnostic)
- **`src/plugins-bundled/`** — plugins shipped with runcode (currently: social)
- **Core stays plugin-agnostic** — adding a plugin never requires editing core
- **Dynamic CLI registration** — plugins discovered at startup, commands registered automatically
- **Strict boundaries** — plugins import ONLY from `@blockrun/runcode/plugin-sdk`, never from core internals

### Added

- `runcode plugins` — list installed plugins
- Plugin discovery from 3 locations: `$RUNCODE_PLUGINS_DIR`, `~/.blockrun/plugins/`, bundled
- `docs/plugin-sdk.md` — full plugin development guide
- Channel abstraction for messaging platforms (Reddit, X, Telegram — channels coming next)

### Changed

- `runcode social` is now a bundled plugin (`src/plugins-bundled/social/`)
- Removed hardcoded `src/social/` and `src/workflow/` directories
- `src/commands/social.ts` → `src/commands/plugin.ts` (generic dispatcher)
- Build now copies plugin assets via `scripts/copy-plugin-assets.mjs`

### Migration

No user-facing breaking changes. All `runcode social *` commands work identically.
Future workflows (`runcode trading`, `runcode content`) follow the same plugin pattern.

## 2.6.0 (2026-04-09)

### Added

- **`runcode social`** — AI social growth workflow
  - Search Reddit/X for relevant posts (Exa neural search + WebSearch)
  - Multi-model reply generation: free models for warmup, cheap for filtering, premium for high-value leads
  - Interactive onboarding: 4 questions → auto-generate keywords, subreddits, config
  - Lead scoring and tracking with SQLite
  - Dry-run mode: preview drafts before posting
  - `runcode social init` / `run` / `stats` / `leads`

- **Workflow Engine** — shared framework for vertical AI workflows
  - Reusable base: model routing, dedup, tracking, display, scheduling
  - Designed for future `runcode trading`, `runcode content` etc.
  - Multi-model tier system: free / cheap / premium per step

### Fixed

- Text wrapping: long responses no longer overflow terminal width
- Payment fallback: cascading free model chain (qwen3-coder → nemotron → devstral)
- Fallback ping-pong loop prevented (session-level failed model tracking)
- Input box: second message no longer eaten (stale `ready` closure)
- Duplicate short response display removed
- AskUser restricted to destructive actions only

## 2.5.32 (2026-04-08)

### Performance

- **Context snowball fix**: Aggressive microcompaction cuts token usage 40-60% in long sessions
  - Clear old tool results after 3 exchanges (was 8)
  - Truncate old tool_use inputs (Edit replacements, Bash commands)
  - Idle threshold reduced to 5 minutes (was 60)
  - Triggers at 6 messages (was 15)

### Added

- **Busy indicator**: Spinner in input box and status bar when agent is working — always visible whether waiting for API, thinking, or running tools
- **Unbrowse built-in**: Auto-discovers [Unbrowse](https://github.com/unbrowse-ai/unbrowse) MCP server when installed

### Changed

- **GLM-5 → GLM-5.1**: Default model and turbo variant updated
- **55+ models**: Updated model count across all docs (was 41+)
- **Brand cleanup**: Removed all legacy BRCC and ClawRouter references

## 2.5.31 (2026-04-08)

### Changes

- **GLM-5 → GLM-5.1**: Default model updated to `zai/glm-5.1` (server-side upgrade)
- **GLM-5 Turbo → GLM-5.1 Turbo**: Turbo variant updated to `zai/glm-5.1-turbo`
- **Unbrowse built-in**: Auto-discovers [Unbrowse](https://github.com/unbrowse-ai/unbrowse) MCP server when installed — turn any website into a reusable API for your agent

## 2.5.22 (2026-04-06)

### Improvements

**Terminal bell notification on turn completion**
- Rings the terminal bell (`\x07`) when the AI finishes a response
- Shows notification badge in iTerm2/Terminal.app when tabbed away
- No more checking back to see if the AI is done — the bell tells you

## 2.5.11 (2026-04-06)

### Improvements

**Bash live output streaming**
- Bash now emits the latest stdout/stderr line to the UI spinner every 500ms while running
- Shows `└ [last output line]` below the spinner so long-running downloads/builds are visible

**Tool spinner shows command/input preview**
- Active tool spinner now shows a truncated preview of what's running: `⠙ Bash: yt-dlp https://...`
- Applies to Bash (command), Read/Write/Edit (file path), Grep/Glob (pattern), WebFetch (url)

**Completed tool shows error detail**
- Failed tools now show the error message in the result line: `✗ Bash 515s — error: ...`
- Previously only showed `✗ Bash 515s` with no explanation

**Accurate elapsed time — permission wait no longer included**
- `onStart` is now called AFTER permission is granted for sequential tools
- Previously the timer started before the permission dialog appeared, inflating elapsed time

## 2.5.10 (2026-04-06)

### Bug Fixes

**Terminal tab bell notification on permission request**
- When a tool requires permission, the terminal bell (`\x07`) is now sent to stderr
- Causes iTerm2/Terminal.app to show the attention badge on the tab so users know action is needed

## 2.5.9 (2026-04-06)

### Bug Fixes

**Permission dialog immediately auto-denied in Ink UI** (critical)
- Ink owns stdin in raw mode; `askQuestion()` created a second `readline` on stdin, got EOF immediately, and resolved with `'n'` (deny) without user interaction
- Fixed by injecting a `permissionPromptFn` into `AgentConfig`; `PermissionManager` uses it when set, falling back to readline only in non-Ink (piped) mode
- Permission dialog is now rendered as an Ink component; `useInput` captures `y`/`n`/`a` keypresses without touching stdin directly

**24 stacked permission boxes / dialog keeps jumping**
- When the model issued N sequential Bash operations in one response, each required a separate dialog, causing rapid Ink re-renders that left ghost frames in terminal scrollback
- Pre-count pending sequential invocations per tool type in `collectResults`; pass remaining count to `promptUser`
- Dialog now shows `N pending — press [a] to allow all` so users skip all at once with one keypress

**Completed tool results caused Ink re-render artifacts**
- Tool results were kept in reactive state, causing Ink to re-render and change component height on every completion, leaving partial dialog boxes in scrollback
- Moved completed tool results to Ink `Static` component — permanently committed to scrollback, excluded from re-render cycle

**Glob infinite loop after permission deny**
- When Write was denied, the model received a bare "User denied" message and looped endlessly through Glob calls trying to find an alternative
- Deny messages now include explicit instruction: "Do not retry — ask the user what they'd like to do instead"

**Input box disappeared while agent was running**
- `InputBox` was only rendered when `ready === true`, causing it to vanish during agent execution
- Now always rendered; unfocused (placeholder only) while agent runs, regains focus when done

## 2.5.1 (2026-04-05)

### Bug Fixes (end-to-end test)

**Terminal UI: piped input only read one line** (critical)
- `promptUser()` was creating a new `readline.Interface` per call, closing stdin after each read
- Replaced with a persistent rl + line-queue approach that buffers all stdin eagerly
- EOF now clears the queue and resolves all waiters immediately (prevents hang on exit)

**Unsettled top-level await warning on exit**
- `process.exit(0)` was called inside `startCommand` before the top-level `await startCommand()` could complete
- Moved `process.exit(0)` to the top-level in `index.ts` after the await resolves
- Also removed stale `/help` from `terminal.ts` (all slash commands now go through `commands.ts`)

**Token anchor desync after micro-compaction**
- `microCompact()` reduced history size but `resetTokenAnchor()` was not called
- Token budget warnings and compaction triggers were using stale counts
- Added `resetTokenAnchor()` after micro-compact modifies history

**StreamingExecutor pending tools not cleared on error**
- `this.pending` was cleared at the end of `collectResults()`, but errors skipped the clear
- Changed to clear pending snapshot immediately at start of `collectResults()` to prevent stale state

**Bash tool synchronous spawn error not caught**
- `spawn()` could throw synchronously if the shell was unavailable
- Added try/catch around spawn call; resolves with error message instead of hanging promise

## 2.5.0 (2026-04-04)

### Power User Features (inspired by free-code/Claude Code)

**Ultrathink Mode** (`/ultrathink`)
- Toggle session-level deep reasoning mode — injects a thorough analysis instruction into every system prompt turn
- One-shot: `/ultrathink <query>` prefixes the query with deep-reasoning instructions without toggling the mode
- When ON, the model is instructed to: consider multiple approaches, check edge cases, challenge initial assumptions, and show reasoning explicitly

**Ultraplan Mode** (`/ultraplan`)
- New command that triggers an ultra-thorough planning pass before any code is written
- Agent reads ALL relevant files first, maps dependencies and side effects, identifies edge cases and security implications, then produces a numbered implementation plan with specific file paths and function names
- No code written — plan only

**System Prompt Dump** (`/dump`)
- Dumps the current assembled system instructions (all sections) for debugging
- Useful for verifying that RUNCODE.md / CLAUDE.md project configs are being picked up correctly

**Token Budget Proactive Warnings**
- Proactively warns when context usage crosses 70% (once per session)
- Shown inline after the agent's response: "Token budget: 73% used (~92k / 128k tokens). Run /compact to free up space."
- Previously required manually running `/tokens` to discover budget pressure

**Updated /help**
- Now shows ultrathink status (ON/OFF) when mode is active
- Lists new commands in dedicated "Power" category

## 2.3.0 (2026-04-04)

### Token Management Overhaul

Comprehensive token reduction improvements based on Claude Code comparison audit:

**Smarter Optimization Pipeline**
- **Conditional microcompact**: Only runs when history >15 messages (was running every single loop iteration, wasting cycles on short conversations)
- **Circuit breaker**: Stops retrying auto-compaction after 3 consecutive failures (prevents spam of doomed API calls)
- **Conservative token estimation**: 33% padding factor on byte-based estimates (was under-counting, causing late compaction triggers)

**Selective Thinking Retention**
- Keeps thinking blocks from last 2 assistant turns (was stripping all except latest)
- Preserves recent reasoning context while still reducing old bloat

**Per-Model Output Budgeting**
- Default max_tokens raised from 8K to 16K (was too low for code generation)
- Per-model max output caps: Opus 32K, Sonnet 64K, Haiku 16K, GPT-5.4 32K, etc.
- Prevents requesting more tokens than a model supports

**Cheaper Compaction**
- Smarter model selection: tiers down further (haiku/mini/nano → Gemini Flash)
- Free models available as compaction target

**New /tokens Command**
- Shows detailed token breakdown: estimated count, context usage %, tool results count+size, thinking block count
- Warns when >80% context used

## 2.2.0 (2026-04-04)

### Architecture
- **Command registry extracted**: 60+ inline slash commands moved from loop.ts (938→564 lines) to dedicated `commands.ts` (240 lines). Uses dispatch pattern: direct-handled, prompt-rewrite, and arg-based commands.

### Bug Fixes
- **Partial response saved on abort**: When user presses Esc mid-generation, streamed content is now saved to session history instead of lost.
- **Tool result aggregate cap**: Once per-message budget exceeded, remaining results are truncated immediately (was continuing to iterate and add bloated messages).
- **AskUser EOF**: Returns error on EOF/piped input instead of misleading "(user skipped)" string.
- **SSE buffer overflow logging**: Debug message now logged when SSE buffer exceeds 1MB (was silent).
- **Glob depth limit**: Increased from 20 to 50 for deep monorepo support.
- **Read tool offset**: offset=0 now treated as offset=1 (1-based as documented).

## 2.1.0 (2026-04-04)

### Security
- **MCP project config trust**: `.mcp.json` from project directories now requires explicit trust (`/mcp trust`). Prevents arbitrary code execution from untrusted repos.
- **Write tool symlink protection**: Now also checks if the target file itself is a symlink to a sensitive location (was only checking parent directory).

### MCP Improvements
- **@blockrun/mcp built-in**: BlockRun MCP server auto-registered — zero config needed for search, dex, markets, chat tools.
- **5s connection timeout**: Slow MCP servers don't block startup anymore.
- **30s tool call timeout**: Hanging MCP tools don't freeze the agent.
- **Transport leak fix**: Failed connections now properly clean up stdio transport.

### Token Management
- **Anchor sanity check**: Token anchor invalidated when history grows unexpectedly (e.g., /resume with large session). Falls back to estimation instead of wrong counts.
- **LLM parse warning**: Malformed tool JSON input now logged in debug mode (was silently defaulting to {}).

### Bug Fixes
- **Session JSONL recovery**: Corrupted lines now skipped individually instead of failing entire session load.
- **Session prune safety**: Active session ID protected from pruning.
- **Tool result truncation**: Now truncates at line boundaries for cleaner previews.
- **ImageGen download timeout**: 30s timeout on image URL download (was unlimited).
- **Compact threshold**: Keep boundary now 8-20 messages (was unbounded 30% that could prevent compaction on long sessions).

## 2.0.0 (2026-04-04)

### MCP Support (Model Context Protocol)
- **Built-in MCP client**: Connect to any MCP server via stdio transport
- **Auto-discovery**: Tools from MCP servers automatically available to the agent
- **Config**: Global `~/.blockrun/mcp.json` + project `.mcp.json` support
- **Namespaced tools**: MCP tools appear as `mcp__<server>__<tool>` (no name collisions)
- **`/mcp` command**: List connected servers and their tools
- **Graceful degradation**: Failed MCP connections don't block startup
- **Cleanup**: MCP connections properly closed on exit

### Token Management Improvements
- **API-anchored tracking**: Token counts anchored to actual API response values
- **Estimation on top**: New messages estimated relative to last API count (more accurate)
- **Anchor reset on compaction**: Prevents stale counts after history compression
- **`/context` enhanced**: Shows tokens as `~X / Yk (Z%)` with anchored indicator (✓/~)
- **Context window percentage**: See how full your context is at a glance

## 1.8.0 (2026-04-04)

### Major Features
- **Session Persistence**: Conversations auto-save to `~/.blockrun/sessions/`. Use `/sessions` to list, `/resume <id>` to continue.
- **Plan Mode**: `/plan` restricts to read-only tools for safe exploration. `/execute` restores full access.
- **AskUser Tool**: Agent can ask clarifying questions with suggested answers.
- **40+ Slash Commands**: Organized by category (Coding, Git, Analysis, Session).

### Slash Commands Added (v1.5.0 → v1.8.0)

**Coding Workflow:**
`/commit`, `/review`, `/test`, `/fix`, `/debug`, `/explain <file>`, `/search <query>`, `/find <pattern>`, `/refactor <desc>`, `/scaffold <desc>`, `/init`, `/todo`, `/deps`

**Git Operations:**
`/push`, `/pr`, `/undo`, `/status`, `/diff`, `/log`, `/branch [name]`, `/stash`, `/unstash`

**Code Analysis:**
`/security`, `/lint`, `/optimize`, `/clean`, `/migrate`, `/doc <target>`

**Session Management:**
`/plan`, `/execute`, `/sessions`, `/resume <id>`, `/compact`, `/context`, `/retry`, `/tasks`, `/doctor`, `/bug`, `/version`

### Tool Enhancements
- **AskUser**: Agent-initiated clarifying questions with styled prompt box
- **Read**: Directories return listing; binary files show type+size instead of garbled output
- **Grep**: `multiline` mode for cross-line patterns; `before_context`/`after_context` params
- **WebFetch**: JSON auto-formatting; HTML stripping removes nav/header/footer/aside
- **Bash**: Sets `RUNCODE=1` env var for script detection
- **Task**: Delete action + list shows done/remaining counts

### System Improvements
- System prompt: safety rules, AskUser guidance, lists all 40+ slash commands
- Config: 5 new keys (permission-mode, max-turns, auto-compact, session-save, debug)
- Help panel: organized into Coding/Git/Analysis/Session categories

## 1.4.0 (2026-04-04)

### New Features
- **`/retry` command**: Resend the last prompt for a fresh response
- **Input history**: Up/Down arrows recall previous prompts (last 50 stored)
- **Edit diff preview**: Edit tool now shows `- old / + new` lines in output
- **Error recovery tips**: API errors include actionable suggestions (/retry, /model, /compact)
- **Setup next-steps**: `runcode setup` shows clear guidance when wallet already exists

### Bug Fixes
- **thinkingText persists**: Now properly cleared on turn_done and /compact
- **/compact force mode**: `/compact` now always compresses, even below auto-threshold
- **Abort handling**: Esc key emits clean 'aborted' event instead of unhandled error
- **Token map unbounded**: Proxy per-model tracking capped at 50 entries
- **Write symlink traversal**: Resolves symlinks before checking sensitive paths
- **SSE buffer overflow**: 1MB cap prevents memory growth on malformed streams
- **Fallback timeout**: 60s per fallback attempt prevents infinite hangs
- **Proxy direct fetch**: 2min timeout on non-fallback requests
- **Models command**: 15s fetch timeout + handles empty API response

### UX Improvements
- Tool output preview increased from 60 to 200 chars
- Running tools show elapsed seconds in real-time
- Permission prompts styled with box-drawing characters
- Terminal UI: /retry, /compact, /model (no args shows current)
- Bash tool description documents output cap and timeout params
- Help panel lists all commands including /retry and /compact

## 1.3.0 (2026-04-04)

### New Features

- **`/compact` command**: Manually compress conversation history to save tokens. Shows before/after token count.
- **Thinking content display**: Ink UI now shows last line of model's thinking process (was only showing spinner).
- **Transient error retry**: Network timeouts, 429 rate limits, and server errors now auto-retry with exponential backoff (up to 3 attempts) instead of terminating the session.
- **First-run tips**: New users see helpful tip about `/model`, `/compact`, and `/help` on first launch.
- **GLM promo auto-expiry**: Default model automatically switches from GLM-5 to Gemini Flash after promo ends.

### Bug Fixes

- **System prompt completeness**: All 11 tools now documented with constraints (was missing 5 tools)
- **Model shortcuts synced**: 16 missing shortcuts added to terminal picker (was out of sync with proxy)
- **Token estimation**: tool_use overhead now includes 16-token framing cost
- **Router code block detection**: Triple backtick code blocks now boost complexity score
- **Router token estimation**: Uses byte length for better accuracy with CJK/Unicode
- **Context window registry**: Added 20+ missing models (xAI, GLM, Minimax, etc.) + pattern-based fallback
- **Glob recursion**: Only `**` triggers full recursion (was over-recursing on `/` patterns)
- **WebSearch parser**: Fallback regex when DuckDuckGo updates HTML; skip internal DDG links
- **Tool descriptions**: Read, Grep, Glob schemas now document key limits and defaults
- **Terminal UI commands**: `/model`, `/cost`, `/help`, `/compact` now work in piped/non-TTY mode
- **Escape to abort**: Press Esc during generation to cancel current turn
- **Per-turn cost display**: Session cost shown after every response

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

- Built-in smart routing — 15-dimension classifier for automatic model selection
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
