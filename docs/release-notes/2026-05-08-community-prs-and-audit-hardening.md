# Franklin 3.15.77 → 3.15.88 — community PRs land + audit-driven hardening

*May 6 – May 7, 2026 · 12 patch releases*

Two things happened this cycle that haven't happened before in Franklin's
release history:

1. **Five external PRs from `0xCheetah1` merged in 36 hours** — the first
   sustained outside contributor. Real diffs, real product wins, all anchored
   in the same audit-forensics methodology the maintainer's been using.
2. **Source code is now English-only by policy** — enforced literally, not
   "best-effort." A repo-wide sweep landed at the end of the cycle.

The rest is audit-driven hardening: every fix has a receipt — a real session
that surfaced a 422, a stream that mangled a table, a gateway 200-OK whose
body said "rate limited," an extraction loop quietly costing $0.005 per
session exit.

---

## 1. Five community PRs from `0xCheetah1`

### PR #43 — terminal paste + exit UX (3.15.82)

The Ink terminal UI now speaks the bracketed-paste protocol. Pre-fix, a
multiline paste corrupted the prompt as N raw lines hit the input handler in
sequence; the session would render the paste mid-typing and the user lost
whatever they were composing. Post-fix:

- `\x1b[?2004h` / `\x1b[?2004l` enable/disable on UI mount/unmount.
- Pasted blocks captured atomically, rendered as a single `[Pasted ~N lines]`
  pill in the prompt. Cursor navigation (Home / End / arrows / backspace)
  treats each block as one logical character.
- **Double-Ctrl+C exit.** First press warns *"Press Ctrl+C again to exit"*;
  second press within 2 seconds actually exits. Standard Unix shell UX.
  Required `exitOnCtrlC: false` on Ink's `render()` so Ink wouldn't intercept
  the first press.
- Idempotent cleanup via a `cleanedUp` flag — fixes the rare double-teardown
  that left terminals in a bad mode after edge-case exits.
- On graceful exit, the goodbye footer prints a `franklin --resume <id>`
  line when `messageCount > 0`. Empty sessions don't get the confusing
  "resume me" footer.

The session-id capture for the resume footer required a new
`onSessionStart?: (sessionId: string) => void` field on `AgentConfig` —
threaded through `loop.ts` once the session id resolves.

### PR #44 — gateway-error-as-text doesn't kill the session (3.15.83)

Real failure mode: some upstream providers swallow rate-limit / quota errors
and emit them as a single bracketed text block on a **200 OK**. Pre-fix, that
text-shaped error got `throw`n into the outer error classifier, was often
mis-classified as transient, triggered auto-retry — which hit the same wall,
retried, and eventually exhausted `recoveryAttempts` after a long stall.
Worst case the session ended.

The PR converts the throw in `looksLikeGatewayErrorAsText`'s match branch
into a graceful turn-end:

```ts
lastSessionActivity = Date.now();
persistSessionMeta();
onEvent({ kind: 'turn_done', reason: 'error', error: gatewayErr.message });
break;
```

Same 4-step shape used in 4 other turn-error paths in `loop.ts`. The user
sees the gateway error immediately and the prompt is back. They can `/retry`,
`/model`, or rephrase. Auto-retry on this specific pattern was almost
always wrong.

### PR #45 — Gemini Pro reasoning models use non-streaming `/v1/messages` (3.15.85)

`google/gemini-2.5-pro` and `google/gemini-3.1-pro` reject requests with a
missing or zero `thinking.budget_tokens`. The gateway's streaming SSE path
was dropping the `thinking` block, so every Gemini-Pro request through
Franklin hit the upstream "Budget 0 is invalid" error.

The PR detects those two model IDs and forces the request through the
non-streaming `/v1/messages` endpoint where the gateway preserves the
thinking block. Budget defaults to `min(max_tokens, 8192)`.

To keep the rest of the agent loop unchanged, a new
`parseNonStreamingMessage` generator converts the JSON response back into the
same internal `StreamChunk` events the streaming parser produces:
`message_start` → per-block `content_block_start / _delta / _stop` →
`message_delta (with usage)` → `message_stop`. Tool-use blocks emit
`input_json_delta` with the full input as one chunk. Thinking blocks emit
`thinking_delta` + an optional `signature_delta`.

Tradeoff: Gemini Pro users lose token-by-token streaming display — they get
the full response at once instead. Acceptable; the request was failing
entirely before. **Non-streaming success beats streaming failure.**

Gating is tight: only fires when
`request.model.startsWith('google/gemini-3.1')` or equals
`'google/gemini-2.5-pro'`. Zero impact on any other model.

### PR #46 — `franklin --resume` seeds the scrollback with prior context (3.15.86)

Pre-fix: `franklin --resume <id>` printed *"Resuming session X (N messages)"*
and dropped the user into a blank prompt. The conversation was loaded into
agent memory (so the model had context) but **invisible to the user**.
People had to manually scroll a saved transcript or guess what they'd been
doing.

The PR seeds the Ink UI's `committedResponses` state with a preview built
from the saved transcript:

- First 4 messages (the opening — what was originally asked)
- Last 6 messages if total > 10 (recent tail)
- A separator `...` between when truncating
- 180-char per-message cap so a single long paste doesn't dominate

User-role lines reuse the gold `❯` styling from PR #43, so the seeded
context blends with live turns. Pure additive — `initialTranscript` is an
optional prop on `launchInkUI` and `RunCodeApp`, undefined keeps prior
behavior exactly.

### PR #47 — terminal returns immediately on exit; extraction is opt-in (3.15.87)

`runWithInkUI` cleanup awaited two background tasks before the user's
terminal returned: `extractLearnings` + `extractBrainEntities` (up to ~15s
combined) and `disconnectMcpServers` (variable). On a typical session, exit
blocked 5–15 seconds with no visible progress.

The PR fires MCP disconnect with `.catch(() => {})` instead of awaiting,
and gates the learning/brain extraction behind `FRANKLIN_EXTRACT_ON_EXIT=1`.
**Default OFF — terminal returns immediately.**

This also closes a small unaudited-spend leak: per the open Stage 2 plan,
`extractLearnings` and `extractBrainEntities` are 4 of the 13 helper-call
sites that bypass `recordUsage` — every session exit was silently costing
~$0.005–0.01 in extraction LLM calls invisible to `franklin stats`. With
the default off, this leak stops by default.

Power users can re-enable in their shellrc:

```bash
export FRANKLIN_EXTRACT_ON_EXIT=1
```

A future change could keep extraction running by default but move it to a
forked detached process — terminal returns immediately AND auto-learning
resumes. Spec: `child_process.fork()` + a tiny `franklin _extract-runner`
subcommand. Out of scope for this PR; the env-var kill-switch shipped here
would stay as the disable mechanism. `runExitBackgroundTasks(...)` is now
its own named function, so the follow-up is a one-line wrapper around fork.

---

## 2. Audit forensics: in-house hardening from real session evidence

### 3.15.77 — Stream sanitizer: `│ / ─ → | / -` at the wire

3.15.76 added a system-prompt nudge asking models to use plain `|` and `-`
in markdown tables. Worked on most models, but a real session had a model
emit a "table" with `│` (U+2502 box-drawing) data rows and `|` separator —
no markdown renderer parsed it, and the prompt nudge alone wasn't enough.

3.15.77 sanitizes the incoming stream before it hits the parser:
`U+2502 → |`, `U+2500 → -`. Wire-level fix that works regardless of model.
Prompt rule still in place as the first line of defense; the sanitizer
catches the cases where the model ignores it.

### 3.15.78 — End-of-turn marker for question turns + dual-listing notice

Two related precision wins surfaced from the same audit slice:

- **End-of-turn marker for question turns.** When the agent ends a turn
  with a clarifying question instead of a tool call, Franklin now emits an
  explicit `turn_done` event with `reason: 'question'` so the UI can show
  the prompt cleanly instead of leaving a "thinking" spinner that never
  resolves.
- **Dual-listing notice for tokenized equities.** Trading data tools now
  surface a one-line notice when a ticker is dual-listed across venues
  (e.g. tokenized stock on multiple chains) — agents would otherwise pick
  one venue arbitrarily and miss the price spread.

### 3.15.79 — `franklin stats` reads the SDK ledger + surfaces recorded-vs-wallet gap

Stage 1 of a multi-stage spend-reconciliation effort. `franklin stats` now
reads `cost_log.jsonl` (the BlockRun SDK's per-call ledger) and compares
against `franklin-stats.json` (Franklin's own per-turn aggregator). When
the two diverge, the gap surfaces as a `⚠ Gap` line.

Real failure mode this caught: the audit log forensics from the prior cycle
turned up 13 helper-call sites that bypass `recordUsage`. Pre-3.15.79 those
calls hit the wallet but didn't appear in `franklin stats`. Post-3.15.79
they show up as a recorded-vs-wallet gap so the user can see the leak.

### 3.15.80 → 3.15.81 — Stalled-intent recovery + English-only by policy

Real failure mode: a model declares an action ("I'll search for X") and
emits zero tool_use blocks — turn ends with intent but no work. Pre-fix,
Franklin treated this as a successful turn and waited for user input.
Post-fix, the loop detects stalled intent and switches to a different model
on the next turn rather than re-entering the same dead end.

3.15.80 added the detector. 3.15.81 dropped the localized regex branches —
the detector is now English-only by policy. The LLM-based intent classifier
above the regex is multilingual; the regex fast-path doesn't need to be.

### 3.15.82 (continued) — stats gap-warning windowing

3.15.79 introduced the SDK-ledger reconciliation but compared **all-time
`cost_log.jsonl`** against **all-time `franklin-stats.json`**. On a real
machine where `cost_log.jsonl` had been rotated/truncated, the all-time
comparison generated a false `⚠ Gap` warning even when the recent slice
was perfectly aligned.

Fix: window the SDK ledger query by `stats.resetAt ?? stats.firstRequest`
so we compare ledger and stats over the SAME time window. New
`resetAt: number` field on the `Stats` interface, captured in
`clearStats()`. The gap warning now only fires when there's a real
discrepancy in the post-reset window. `stats.json` and `stats --json`
output gain `sinceMs` / `windowStartMs` fields so callers can see exactly
which window the reconciliation ran against.

The "empty stats" early-return now checks BOTH `stats.totalRequests === 0`
AND `sdkTotal === 0` — a brand-new install where Franklin hasn't recorded
anything yet but the SDK ledger already has rows still surfaces the ledger
summary.

### 3.15.84 — synthetic-label regex accepts em dashes / colons / digits

Audit slice 2026-05-07 from a third-party observer surfaced
`[GROUNDING CHECK FAILED — RETRY ROUND]` slipping through the 3.15.71/76
audit-prompt sanitizer because the previous regex `[A-Z _-]` didn't accept
em dashes. Other common extended-label shapes —
`[ESCALATION: stronger model]`, `[CONTEXT WINDOW 200K]` — would have
leaked the same way.

Char class extended to `[A-Z0-9 _\-—–:]` — A–Z, 0–9, space, underscore,
hyphen, em dash (U+2014), en dash (U+2013), colon. Both the
start-anchored skip path and the trailing-strip path use the same regex,
so labels that *start* the message AND labels appended *after* a real
prompt both get cleaned. Three new regression assertions added to the
existing `extractLastUserPrompt strips TRAILING synthetic labels (3.15.76)`
test cover em-dash-start, em-dash-trailing, and colon-label cases.

---

## 3. Source code is English-only by policy (3.15.88)

`grep -rE '[\\x{4e00}-\\x{9fff}]' src/ --include='*.ts'` now returns zero
matches. A repo-wide sweep cleaned literal restricted-script characters
out of:

- **Tool spec descriptions** — example user phrases removed from routing
  examples and notification keyword lists. The model is multilingual; it
  can still apply the routing rule when the actual user types in any
  language.
- **System prompts** (`src/agent/context.ts`, `src/learnings/extractor.ts`)
  — routing nudges, forbidden-phrase lists, language examples translated
  to generic English wording.
- **Loop comments + few-shot examples** across `loop.ts`, `turn-analyzer.ts`,
  `media-router.ts`, `evaluator.ts`, `commands/content.ts`.
- **Domain-relevance regex** (`isToolRelevantToPrompt`) — localized
  alternation branches dropped from the crypto / X.com / media detection
  regexes.
- **Router fast-path keyword arrays** — per-category localized keyword
  lists removed. The LLM-based classifier above the keyword fast-path is
  multilingual and continues to route other-language queries correctly.

No encoded exception kept — `src/social/a11y.ts:X_TIME_LINK_PATTERN` no
longer hides escaped restricted-script date markers. The source policy is
enforced literally, not by hiding restricted-script text behind Unicode
escapes.

The behavioral implication is small: the LLM-level classifier already
handles multilingual input well, and the keyword fast-path is a small
optimization that now misses some other-language queries on the cold path.
Net spend impact: indistinguishable from noise on a 30-day window.

362/362 tests pass, including a tracked-text guard that fails on
restricted-script characters.

---

## 4. What you actually need to know if you're a Franklin user

```bash
npm install -g @blockrun/franklin@latest    # picks up 3.15.88
```

If you ran `franklin` before this cycle, you probably hit at least one of:

- A multiline paste that scrambled your prompt
- A Gemini Pro session that "Budget 0 is invalid"-errored on first call
- A `franklin --resume` that dropped you into a blank screen
- A 5–15 second hang on session exit
- A gateway 200-OK with rate-limit text in the body that ended your session
- An audit log full of `[FRANKLIN HARNESS PREFETCH]` rows masquerading as
  user prompts

All fixed. Restart your `franklin` process to pick them up — npm install
alone updates the binary on disk but a long-running `franklin` keeps the
old code in memory.

---

## 5. What we deliberately didn't do

- **No restoration of a "cheap" SIMPLE auto-tier.** Still flagged from the
  prior cycle. SIMPLE and MEDIUM both currently route to `deepseek-v4-pro`
  for tool-use reliability. The temptation to put `gemini-2.5-flash` or
  `glm-5.1` back as primary for SIMPLE remains; the regression risk in
  agent loops is still the deciding factor.
- **No backfill of polluted audit prompts.** 3.15.71/76/84 fixes apply
  going forward. Old rows stay polluted; the new field stays clean as
  usage rolls forward. Backfill costs more than it returns.
- **No detached-process auto-learning.** PR #47 made extraction opt-in by
  env var. The "fork it to a detached process so it runs without blocking"
  follow-up is one function call away (`runExitBackgroundTasks` is already
  its own named function) but ships in a separate cycle once the spec is
  written.
- **No streaming-mode workaround for Gemini Pro.** The non-streaming path
  shipped in PR #45 is the right shape for now. Reverse-engineering the
  gateway's SSE serializer to inject the missing thinking-budget block
  belongs upstream at the gateway, not in Franklin.

---

## 6. Honest reflection on the cycle

**The community-PR onboarding worked because of audit-log evidence.** Every
one of `0xCheetah1`'s five PRs starts from a real session: a paste that
broke, a Gemini call that 400'd, a resume that landed on a blank screen,
an exit that hung. The maintainer's audit-forensics methodology was
contagious — outside contributors picked up the pattern from reading recent
release notes and replicated it in their own PRs. That's the cheapest
possible code review: the contributor and maintainer are aligned on what
counts as evidence before the PR opens.

**The English-only sweep was technical debt that almost slipped past.**
3.15.81 hit one localized regex; the assumption was the rest of the
codebase was clean. A `grep -rE '[\\x{4e00}-\\x{9fff}]' src/` returned 47
matches. The lesson: when you ship a "by policy" rule, enforce it with a
test in CI, not in the maintainer's memory. The 362nd test added in
3.15.88 is exactly that — fails the suite if any tracked text file
contains restricted-script characters.

**Not every follow-up landed.** Two same-day follow-ups proposed reversing
design decisions that had just shipped: full-replay resume scrollback
instead of the truncated preview, and a unified chronological scrollback
under a single `<Static>`. Both were closed with feedback. The originals
were deliberate calls — the truncated preview is for orientation, not
replay; the separate scrollback regions exist because Ink's `<Static>`
can't safely have its head sliced. Reversing decisions ~24 hours after they
ship without new product evidence isn't the bar for a merge. The right
follow-up shape — preserve paragraph breaks, virtualize long-session
hydration — got documented in the close comments and stays open as future
work.
