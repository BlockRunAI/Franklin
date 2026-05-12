# Changelog

## 3.15.95 — Audit captures `cache_creation_input_tokens` / `cache_read_input_tokens` (vision + cache calls no longer look 28× over-billed)

Observability fix. The streaming client was reading `input_tokens`
from Anthropic's `usage` object but ignoring the two cache fields
(`cache_creation_input_tokens` at 1.25× base, `cache_read_input_tokens`
at 0.1× base) that vision and prompt-cache calls return. Result: the
wallet charge was correct (gateway settled against the full token
count), but the audit log recorded only the uncached portion — making
per-call cost/token ratios look insane in dashboards.

Verified 2026-05-11 from a real audit row:

```
Opus 4.7 call: inputTokens=3653, outputTokens=56, costUsd=$0.567
```

At Opus 4.7's $5/M input rate, $0.567 implies ~113K real billed
tokens — 28× what the audit shows. The missing 109K were
cache-creation tokens from a vision-heavy turn.

### Fix

- `CompletionUsage` gains optional `cacheCreationInputTokens` /
  `cacheReadInputTokens`.
- The SSE parser in `src/agent/llm.ts` reads both fields from
  `message_start` and `message_delta` events.
- `AuditEntry` carries the fields end-to-end so dashboards can compute
  true billed-token counts and cache-hit rate.
- The local `usage` declaration in `src/agent/loop.ts` now references
  `CompletionUsage` directly instead of an inline narrower type, so
  future additions to the interface flow through automatically.

### Tests

New round-trip test in `test/local.mjs`:

```js
appendAudit({
  ...,
  inputTokens: 3653,
  cacheCreationInputTokens: 96000,
  cacheReadInputTokens: 0,
  costUsd: 0.567,
});
// Read back and assert both cache fields survived.
```

383/383 tests pass.

### What didn't change

- Wallet charges are unaffected — they were always correct (the
  gateway settles against Anthropic's real billing).
- Stats `costUsd` totals are unaffected — those use the real x402
  settlement (3.15.89's fix).
- The fix only restores observability. No new model selection, no
  new behavior, no new failure modes.

### Why this matters

Dashboards that compute `costPerInputToken` or "cache hit rate" or
"input efficiency" against `byModel` totals were silently broken for
every vision-capable session since 3.15.91. This release restores the
ground truth. Cache-hit-rate visibility — a major lever for cost
reduction — now becomes possible.

## 3.15.94 — Research-bloat compactor fires on $1 cost ceiling, not just 15-call gate

Real-production fix found via `franklin doctor --anomaly` (3.15.92's
new diagnostic). debug.log entry from a real session:

```
[2026-05-11T21:58:09] Research-bloat compacted at 16 calls / $9.4552: ~3129 tokens
```

Compare to two normal compactions earlier the same day:

```
[18:31] 17 calls / $0.2848 / ~9528 tokens
[18:49] 16 calls / $0.0832 / ~5850 tokens
```

The 21:58 compact was **34× more expensive per call** for one-third the
recovered context. By the time the 16-call gate fired, the turn had
already burned $9.45 on input-replay.

### Root cause

The gate required BOTH `turnToolCalls > 15` AND `turnCostUsd > 0.03`.
For cheap models (`deepseek-chat`, `glm-5.1`, `qwen-coder`), 16 calls
clears the $0.03 floor trivially → compact fires at the right time. For
Opus-class models (`anthropic/claude-opus-4.7` at $5/$25 per M tokens),
cost climbs much faster than call count. By call #4 the per-call input
might already be 50K+ tokens; call #16 = $9.45 of cumulative input
replay before the 15-call gate releases the compact.

### Fix

Add a high-cost early-exit to the trigger:

```ts
if (
  !bloatCompactedThisTurn &&
  compactFailures < 3 &&
  (
    (turnToolCalls > 15 && turnCostUsd > 0.03) ||   // existing gate
    turnCostUsd > 1.00                              // NEW early-exit
  )
)
```

`$1.00/turn` is intentionally conservative. Even extended-thinking Opus
shouldn't need >$1 of context replay before compacting; the compact
itself runs on a cheaper model and costs <$0.05. With this gate, the
21:58 session would have triggered around call 4-5, saving ~$8 on that
turn.

### What didn't change

- Call-count gate still applies for cheap-model bloat (16+ calls is
  still the canonical "long research session" tripwire).
- Fire-once-per-turn flag is unchanged.
- The compactor itself (`forceCompact`) is unchanged — only the trigger
  fires earlier.

382/382 tests pass.

## 3.15.93 — `franklin doctor` forces a fresh version fetch (no more 24h-stale "all clear")

Single-fix patch found while reviewing the user's own ledger.

**The bug.** `franklin doctor` was relying on the daily-refreshed
`~/.blockrun/version-check.json` cache for its Franklin-version check.
With 4 patch releases in 3 days (3.15.89 → 3.15.92), a user could
trivially be 4 versions behind while doctor printed `✓ Franklin v3.15.88`
— because the cache hadn't refreshed yet, the cached `latestVersion`
still pointed at an older release, and `compareSemver(cache.latest, VERSION)`
returned 0.

Verified on a real machine 2026-05-11: global `franklin` was 3.15.88
for the entire 48 hours during which 3.15.89/90/91 shipped. Doctor said
"all clear" the whole time. Worse, the bug-fix releases (cost_log
writer, agent-side stats writer) couldn't run in production for that
user — every paid call in those 48 hours hit the wallet but neither
the cost_log nor stats trackers captured it. The wallet dropped $22
that didn't land in any local ledger.

**The fix.** New `getAvailableUpdateFresh()` in `src/version-check.ts`
forces a real `fetch()` against npm (bounded by the existing 2s
timeout). Doctor now kicks the fetch off in parallel with the other
checks; total wall-clock stays under 2s. If the fetch fails (offline,
slow npm), falls back to the cached value — same behavior as before,
just refreshed when possible.

The daily-cache `kickoffVersionCheck()` path is unchanged for other
entry points (banner, etc.) so we don't hammer npm on every startup.

### Tests

`compareSemver` got explicit unit coverage in `test/local.mjs`:
basic ordering, leading-v tolerance, pre-release suffix stripping,
unparseable-input safety. Smoke test confirms doctor renders correctly
when on latest.

382/382 tests pass.

## 3.15.92 — Tool failure taxonomy + per-tool anomaly detector + `franklin doctor --anomaly`

Adopts a Cursor-style tool-failure taxonomy and a baseline-vs-recent
spike detector so the "check failures.jsonl by hand every day" loop
stops being a manual human task. Six categories
(`InvalidArguments`, `UnexpectedEnvironment`, `ProviderError`,
`UserAborted`, `Timeout`, `Unknown`), each captured per failure record,
plus a 24h-vs-30d rate-normalized spike detector that surfaces
brand-new failure types and >3× regressions per `(tool, category)`
bucket.

### What landed

- **`src/stats/failures.ts`** — new `ToolFailureCategory` enum,
  `classifyToolFailure()` layered pattern matcher (drawn from real
  errors in this repo's `failures.jsonl`), `category` field on every
  `FailureRecord`. Writer auto-classifies on append; reader back-fills
  historical entries on load — no file migration needed. Now honors
  `FRANKLIN_NO_AUDIT` / `FRANKLIN_NO_PERSIST` so test runs don't
  pollute `~/.blockrun/failures.jsonl`. Path resolves at call-time via
  `FRANKLIN_HOME` (existing convention from `src/tasks/paths.ts`) so
  sandbox runs work cleanly.
- **`getToolAnomalies(opts)`** — rate-normalized comparison of last 24h
  vs last 30d. Surfaces a bucket when `recentCount >= 3` and
  `spikeRatio >= 3.0`, or when the baseline is zero (brand-new failure
  type, sorts first). Defaults overridable per call.
- **`franklin doctor --anomaly`** — one-line CLI summary. Exits 0 when
  clean, 1 when any anomaly is surfaced — suitable for cron / CI hooks.
  `--json` for machine-readable output.

### Why now

The last six release cycles all started with "check the log" — user
asks, agent scans `failures.jsonl` + `franklin-debug.log` by hand,
proposes fixes. That works, but it's hand-driven and gates every
review on a human session. The data to automate it is already on disk;
this release adds the classifier + spike detector that closes the loop.

Inspired by Cursor's published harness-engineering writeup (same five
categories + per-tool baselines). Tuned classifier patterns to
Franklin's actual tool surface (SearchX login-walls, Bash EACCES, x402
payment rejections, etc.).

### Tests

Eight new in `test/local.mjs`:

- Six classifier round-trips, one per category, using real error
  messages observed in production (the
  `"Cannot read properties of undefined (reading 'snapshot')"` test
  is the actual SearchX failure that prompted the playwright-snapshot
  fix earlier this week).
- One math fixture for `getToolAnomalies`: synthetic 5 / 4 / 6 / 80
  failure mix → asserts new-type Infinity spike surfaces first,
  sub-3× ratio does NOT surface, sufficient-baseline 6× DOES.

381/381 tests pass.

### Smoke tests

Real machine, current `failures.jsonl` (clean):

```
$ franklin doctor --anomaly
  No anomalies. Tool failure rates match the 30-day baseline.
exit: 0
```

Synthetic spike (sandbox via `FRANKLIN_HOME` + four fresh SearchX
entries):

```
  • SearchX / InvalidArguments  NEW failure type (no baseline)  recent=4, baseline=0
    sample: Cannot read properties of undefined (reading 'snapshot')

  1 anomalies. Investigate before they snowball.
exit: 1
```

Full write-up: `docs/release-notes/2026-05-11-tool-failure-taxonomy.md`.

## 3.15.91 — Vision-aware routing: Auto picks eyes, manual mode stops blind submits

3.15.89/90 made sure image bytes actually reach the model. This release
makes sure the *right model* receives them.

The problem: a new session on `blockrun/auto` could send a `.png` to
`deepseek-v4-pro` (text-only) because Auto's SIMPLE/MEDIUM tier picks
V4 Pro for cost reasons. The gateway tokenized the base64 as text and
the model hallucinated from the `"Image file: <path>"` stub. Same
class of failure when a user manually picked any text-only SKU
(deepseek family, `xai/grok-4-1-fast-reasoning`, `gpt-5.3-codex`,
`qwen3-coder-480b`) and then attached an image.

### What landed

- **`src/router/vision.ts`** (new) — curated allowlist of vision-capable
  gateway models, basename-anchored image-path regex, OpenAI- and
  Anthropic-format messages scanner, family-aware sibling picker. The
  allowlist is hand-maintained rather than fetched from `/v1/models` so
  routing stays sync; models churn only at release time, which already
  touches the router and pricing tables.
- **`src/router/index.ts`** — `routeRequest`, `routeRequestAsync`, and
  `resolveTierToModel` now accept `needsVision`. When true, walk the
  tier's primary+fallback chain for the first vision-capable model;
  escalate to COMPLEX (Opus, always vision) if the whole tier is
  text-only. Elo-learned routing applies the same substitution when its
  pick lacks vision — vision is a hard requirement, not an Elo
  dimension.
- **`src/agent/loop.ts`** — detects image references in user input on
  the first iteration of each turn and threads `needsVision` into the
  router. The Auto-routed line gets an `👁️` tag so the user knows
  vision was the reason for the pick. For manual mode (no routing
  profile) on an image turn with a text-only model, swaps to the
  family-closest vision sibling for that turn with a visible warning
  (`⚠️ <orig> can't see images — using <swap> for this turn.`). The
  existing top-of-turn model-recovery block restores `baseModel` on
  the next turn, so the user's selection isn't permanently overridden.
- **`src/proxy/server.ts`** — same logic on the Anthropic-format proxy
  path. Scans `messages[]` for `image` / `image_url` / `input_image`
  parts plus image paths in text parts. Manual-mode swap logs at
  `warn` level; Auto-mode routing logs include the `vision-required`
  signal.

### Tests

Five new tests in `test/local.mjs`:

1. `isVisionModel allowlist matches curated set` — explicit positive
   and negative coverage including the failure modes (deepseek family,
   grok-4-1-fast-reasoning, codex 5.3, qwen3-coder).
2. `messageNeedsVision detects image path refs in user text` — Unix-,
   home-, relative-, Windows-style paths plus bare basenames.
3. `messagesNeedVision detects image parts and embedded paths` —
   Anthropic image blocks, OpenAI image_url, and string content with
   path embeds.
4. `Auto with image upgrades V4 Pro pick to a vision model` — across
   SIMPLE / MEDIUM / COMPLEX tiers and through `routeRequest`.
5. `pickVisionSibling stays within the user-chosen family` — DeepSeek
   falls through to default; xai stays in xai; openai stays in openai.

373/373 tests pass.

### Behavioral implications

- New sessions on `auto` with a `.png` attachment now route to
  sonnet-4.6 / gemini-flash / opus depending on tier instead of V4 Pro.
  Per-call cost on those turns goes up — that's the cost of the model
  actually being able to see the image, same delta 3.15.89 introduced.
- Manual selections persist across turns as before; the per-turn vision
  swap is one-shot and surfaces a warning so the user can decide
  whether to switch their session's default.

## 3.15.90 — Vision sweep: cherry-pick PR #53 + patch sibling sites it missed

3.15.89 fixed `optimize.ts:budgetToolResults`. The bug class — running
`JSON.stringify(part.content)` over arrays containing image blocks and
then writing back a string preview — actually existed in **five** places.
PR #53 from `KillerQueen-Z` caught a second one (`reduce.ts:ageToolResults`)
plus added a client-side image resize on `Read` to stop the gateway from
billing a 1.9 MB PNG as 1.36 M text tokens. This release lands those
plus patches the remaining two destructive siblings the PR didn't touch.

### What landed

- **`src/agent/reduce.ts:ageToolResults`** (from PR #53) — image-bearing
  tool_results now short-circuit age-decay. Long conversations beyond
  3 turns no longer silently lose attached images.
- **`src/tools/read.ts` + `sharp@^0.34.5`** (from PR #53) — images > 150 KB
  resize to long-edge 1280 px, re-encode as JPEG q85; PNG preserved when
  the source has non-opaque alpha. Smoke-tested 1898.7 KB → 117.6 KB
  (16× cut). Workaround for the gateway-side base64-as-text tokenization
  on `/v1/messages`; the resize keeps per-call cost bounded regardless
  of when that lands.
- **`src/agent/reduce.ts:deduplicateToolResultLines`** (new) — same
  array-aware fix. Dedupe runs over text only; image blocks rebuild
  alongside the deduped text segment.
- **`src/agent/reduce.ts:collapseRepetitiveTools`** (new) — image-bearing
  results skip the collapser entirely. The `[first-line...]` stub
  rewrite is text-only intent; image bytes stay.
- **`CONTRIBUTING.md`** — fixes typos (`cd franklin` → `cd Franklin`,
  duplicate `5.` numbering, stale "RunCode" reference). Adds a
  "Quality bar for fixes" section: search for sibling instances of a
  bug class before opening a PR — PR #53 was the prompt (fixed 1 of 5
  sites; review caught the rest).

### Tests

Two new regression tests in `test/local.mjs`:

1. `deduplicateToolResultLines preserves image blocks while deduping text` —
   repeated lines + image → text is deduped, image survives in the
   rebuilt content array.
2. `collapseRepetitiveTools leaves image-bearing tool_results alone` —
   six WebSearch-like calls with one image-bearing result → string
   results get the `[first-line...]` collapse, the image-bearing one
   passes through untouched.

368/368 tests pass.

### Credits

`KillerQueen-Z` (PR #53) for the `ageToolResults` fix and the `sharp`
client-side image normalization. The optimize.ts hunk in #53 duplicated
3.15.89 and was dropped during cherry-pick; the rest landed verbatim.

## 3.15.89 — Vision images survive the budgeter

Single-issue patch. Vision calls (sonnet-4.6, opus-4.7, any image-capable
model) had been silently hallucinating against attached PNGs because
Franklin's own char-budgeter was destroying the image blocks before the
request left the agent.

`src/agent/optimize.ts:budgetToolResults` was running
`JSON.stringify(part.content)` over arrays containing base64 image
blocks, the resulting string trivially tipped past the 32K char cap, and
the entire content array got replaced with a truncated text preview.
The model only ever saw a 2KB self-referential string starting with
`"[Output truncated: 275,952 chars → 2000 preview]\n\n[{\"type\":\"text\"…"`
instead of the image.

Verified from a real gateway log: a sonnet-4.6 vision call recorded
20,723 input tokens (should have been ~150K with the image present),
and the tool body was that same 2KB self-referential string.

### Fix

Decompose `tool_result.content` into text vs image segments before
measuring size. Only text counts toward `MAX_TOOL_RESULT_CHARS` /
`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`. Image segments pass through
untouched on every code path: under cap, per-tool truncation,
per-message truncation. Bare-string content (the original path) is
unchanged.

### Tests

Three regression tests added in `test/local.mjs`:

1. 300KB image + small text → image survives, base64 untruncated.
2. 60K text + small image → text truncated, image survives alongside.
3. 50K bare string → still truncates to a string preview (no
   regression on the original path).

366/366 tests pass.

### Behavioral implications

Vision-capable flows that route an image through a tool result — ImageGen,
Read on `.png`/`.jpg`, browser screenshots — will now actually let the
model see the image. Expect input-token counts on those calls to jump
(a single screenshot can easily add 100K+ vision tokens) and answers to
become accurate instead of hallucinatory. Wallet impact is real but
expected: this is the cost of the model actually seeing what you sent.

Full write-up: `docs/release-notes/2026-05-10-vision-image-fix.md`.

## 3.15.88 — Source code is English-only by policy

\`grep -rE '[\\x{4e00}-\\x{9fff}]' src/ --include='*.ts'\` now returns
zero matches. Sweep across source, tests, changelog, and release notes
cleaning literal restricted-script characters out of comments, system
prompts, tool spec descriptions, classifier keyword arrays, and few-shot
examples. Continuing the
"English-only by policy" rule first applied in 3.15.81 (localized regex
branches dropped from \`looksLikeStalledIntent\`), now generalized
across tracked text files.

### What changed in code

- **Tool spec descriptions** (\`src/tools/wallet.ts\`,
  \`src/tools/prediction.ts\`, \`src/tools/searchx.ts\`): example user
  phrases like \`wallet balance\` / \`copy trade\` / \`mentions\` removed from
  routing examples and notification keyword lists. The model is
  multilingual; it can still apply the routing rule when the actual
  user types in any language.
- **System prompts** (\`src/agent/context.ts\`,
  \`src/learnings/extractor.ts\`): routing nudges, forbidden-phrase
  lists, and language examples translated to generic English wording.
- **Loop comments + few-shot examples** (\`src/agent/loop.ts\`,
  \`src/agent/turn-analyzer.ts\`, \`src/agent/media-router.ts\`,
  \`src/agent/evaluator.ts\`, \`src/commands/content.ts\`): inline
  non-English examples translated or replaced.
- **Domain-relevance regex** (\`src/agent/loop.ts:isToolRelevantToPrompt\`):
  localized alternation branches dropped from the crypto / X.com / media
  detection regexes. Same shape as the 3.15.81 fix.
- **Router fast-path keyword arrays** (\`src/router/categories.ts\`,
  \`src/router/index.ts\`): per-category localized keyword lists removed.
  The LLM-based classifier above the keyword fast-path is multilingual
  and continues to route other-language queries correctly.

### No encoded exception kept

\`src/social/a11y.ts:X_TIME_LINK_PATTERN\` no longer carries escaped
restricted-script date markers. The source policy is enforced literally,
not by hiding restricted-script text behind Unicode escapes.

### What didn't change

- \`test/local.mjs\` — test fixtures that simulate multilingual user
  input use Latin-script examples. They verify the extract / trim /
  sanitize paths without embedding restricted-script characters in the
  codebase.
- \`CHANGELOG.md\` and release notes — real-session evidence is
  paraphrased in English so the repository remains restricted-script-free.

### Behavioral implications

The LLM-level classifier already handles multilingual input well
(verified across PR #43–#47 sessions today, all of which routed
correctly through the LLM tier). The keyword fast-path serves a small
optimization role; dropping its localized coverage shifts those queries
through the LLM tier on the cold path. Net spend impact:
indistinguishable from noise.

362/362 tests pass, including a tracked-text guard that fails on
restricted-script characters.

## 3.15.87 — PR #47: terminal returns immediately on exit; learning extraction is opt-in

External contribution from \`0xCheetah1\`. The \`runWithInkUI\` cleanup
path was awaiting two background tasks before the user's terminal
returned: \`extractLearnings\` + \`extractBrainEntities\` (up to 15s
combined) and \`disconnectMcpServers\` (variable). On a typical session,
exit blocked 5–15 seconds with no visible progress.

The PR fires MCP disconnect with \`.catch(() => {})\` instead of
awaiting, and gates the learning/brain extraction behind
\`FRANKLIN_EXTRACT_ON_EXIT=1\`. Default OFF — terminal returns
immediately.

### Behavior change to flag

Pre-fix: every session exit ran the extraction LLM calls, building
\`~/.blockrun/learnings.jsonl\` and the brain corpus across all
sessions automatically. Post-fix: extraction only runs when the user
explicitly sets \`FRANKLIN_EXTRACT_ON_EXIT=1\`.

Power users can re-enable in their shellrc:

\`\`\`bash
export FRANKLIN_EXTRACT_ON_EXIT=1
\`\`\`

Also closes a small unaudited-spend leak: per the open Stage 2 plan,
\`extractLearnings\` and \`extractBrainEntities\` are 4 of the 13
helper-call sites that bypass \`recordUsage\` — every session exit was
silently costing ~\$0.005–0.01 in extraction LLM calls invisible to
\`franklin stats\`. With the default off, this leak stops by default.

### Follow-up worth considering

A future change could keep extraction running by default but move it
to a forked detached process — terminal returns immediately AND
auto-learning resumes. Spec: \`child_process.fork()\` + a tiny
\`franklin _extract-runner\` subcommand. Out of scope for this PR; the
env-var kill-switch shipped here would stay as the disable mechanism.

\`runExitBackgroundTasks(sessionHistory, agentConfig)\` is now its own
named function, so the follow-up is a one-line wrapper around fork().

361/361 tests pass.

## 3.15.86 — PR #46: \`franklin --resume\` seeds the scrollback with prior context

External contribution from \`0xCheetah1\`. Pre-fix: running
\`franklin --resume <id>\` printed *"Resuming session X (N messages)"*
and dropped the user into a blank prompt — the prior conversation was
loaded into history (so the model had context) but invisible to the
user. People had to manually scroll a saved transcript or guess what
they'd been doing.

The PR seeds the Ink UI's \`committedResponses\` state with a
preview built from the saved transcript:
- First 4 messages (the opening context — what was originally asked)
- Last 6 messages if total > 10 (recent tail)
- A separator \`...\` between when truncating
- 180-char per-message cap so a single long paste doesn't dominate
  the scrollback

User-role lines reuse the gold \`❯\` styling from PR #43, so the
seeded context blends with live turns instead of looking like a
different rendering mode.

Implementation:
- New \`buildResumeTranscript(history)\` in \`src/commands/start.ts\`
  uses \`extractVisibleText\` to pull only \`text\` parts from each
  message's content array (skips tool_use / tool_result blocks
  that wouldn't render usefully).
- New optional \`initialTranscript\` prop on \`launchInkUI\` and
  \`RunCodeApp\`. If undefined, behavior is unchanged. Existing
  non-resume paths see no diff.

Risk surface: minimal. Pure additive prop. CI green; tests still
361/361 on integrated main.

## 3.15.85 — PR #45: Gemini Pro reasoning models use non-streaming /v1/messages

External contribution from \`0xCheetah1\`. Real failure mode: Gemini Pro
reasoning models (\`google/gemini-2.5-pro\`, \`google/gemini-3.1-pro\`) reject
requests with a missing or zero \`thinking.budget_tokens\`. The gateway's
streaming SSE path was dropping the \`thinking\` block, so every Gemini-Pro
request through Franklin was hitting the upstream "Budget 0 is invalid"
error.

The PR detects those two model IDs and forces the request through the
non-streaming \`/v1/messages\` endpoint where the gateway preserves the
\`thinking\` block. Budget defaults to \`min(max_tokens, 8192)\`.

To keep the rest of the agent loop unchanged, the new
\`parseNonStreamingMessage\` generator converts the JSON response back into
the same internal \`StreamChunk\` events the streaming parser produces:
\`message_start\` → per-block \`content_block_start\` / \`_delta\` /
\`_stop\` → \`message_delta\` (with \`usage\`) → \`message_stop\`. Tool-use
blocks emit \`input_json_delta\` with the full input as one chunk.
Thinking blocks emit \`thinking_delta\` + an optional \`signature_delta\`.

Trade-off: Gemini Pro users lose token-by-token streaming display. Get the
full response at once instead. Acceptable — the request was failing
entirely before; non-streaming success beats streaming failure.

Gating is tight: the new path only fires when
\`request.model.startsWith('google/gemini-3.1')\` or equals
\`'google/gemini-2.5-pro'\`. Zero impact on any other model.

Verified by Cheetah:
- \`node dist/index.js --model google/gemini-2.5-pro --prompt "say ok"\`
- \`node dist/index.js --model google/gemini-3.1-pro --prompt "say ok"\`
- \`--resume\` against an existing session works

361/361 tests pass on integrated main.

## 3.15.84 — Synthetic-label regex now accepts em dashes / colons / digits

Real audit slice 2026-05-07 from a third-party observer (Predexon side):
\`[GROUNDING CHECK FAILED — RETRY ROUND]\` slipped through the
3.15.71/76 audit-prompt sanitizer because the previous regex
\`[A-Z _-]\` didn't accept em dashes inside the bracket. Other common
extended-label shapes — \`[ESCALATION: stronger model]\`,
\`[CONTEXT WINDOW 200K]\` — would have leaked the same way.

Char class extended to \`[A-Z0-9 _\\-—–:]\`:
- A–Z, 0–9, space, underscore, hyphen (existing)
- em dash (\`—\`, U+2014), en dash (\`–\`, U+2013), colon (existing
  observed-in-the-wild punctuation)

Both the start-anchored skip path and the trailing-strip path use the
same regex, so labels like \`[GROUNDING CHECK FAILED — RETRY ROUND]\`
that *start* the message AND labels appended *after* a real prompt
both get cleaned.

Three new regression assertions inside the existing
\`extractLastUserPrompt strips TRAILING synthetic labels (3.15.76)\`
test cover em-dash-start, em-dash-trailing, and colon-label cases. Test
count stays at 361 (assertions added inside an existing test).

## 3.15.83 — PR #44: gateway-error-as-text no longer kills the session

External contribution from \`0xCheetah1\`. Real failure mode:
some upstream providers swallow rate-limit / quota errors and emit them
as a single bracketed text block on a 200 OK. Pre-3.15.83, that text-
shaped error was thrown into the outer error classifier, which often
mis-classified it as transient and triggered the auto-retry path —
which immediately hit the same wall, retried again, and eventually
exhausted \`recoveryAttempts\` after a long stall. Worst case the
session ended.

The PR converts the \`throw\` in \`looksLikeGatewayErrorAsText\`'s match
branch into a graceful turn-end:

\`\`\`ts
lastSessionActivity = Date.now();
persistSessionMeta();
onEvent({ kind: 'turn_done', reason: 'error', error: gatewayErr.message });
break;
\`\`\`

Same 4-step shape used in 4 other turn-error paths in \`loop.ts\` (timeout
retry skip, classified non-transient errors, etc.) — Cheetah followed the
established pattern, didn't invent a new one. The \`turn_done\` event
shape with \`reason: 'error'\` is already typed
(\`src/agent/types.ts:143\`) and already rendered by the UI
(\`src/ui/app.tsx:1190\`).

Effect: the user sees the gateway error message immediately and the
prompt is back. They can \`/retry\` if they think the upstream cleared,
\`/model\` to switch, or just rephrase.

Tradeoff acknowledged: rare cases where the gateway-text-error was
genuinely transient (a 200 OK body whose text content would have cleared
on auto-retry) lose automatic recovery. Manual \`/retry\` covers it.
Auto-retry on this specific pattern was almost always wrong.

361/361 tests pass.

## 3.15.82 — Bracketed-paste UX (PR #43) + stats gap-warning windowing

Bundles three changes that landed together: an external contributor's
terminal-paste/exit UX overhaul, a follow-up cleanup, and a real fix to
3.15.79's gap-warning false alarm.

### PR #43 — terminal paste and exit UX (merged from \`0xCheetah1\`)

- **Bracketed-paste protocol** — Franklin now emits the standard
  \`\\x1b[?2004h\` / \`\\x1b[?2004l\` enable/disable sequences. Large
  multiline pastes are captured atomically and rendered as a single
  \`[Pasted ~N lines]\` block instead of the raw N-line scroll that
  used to corrupt the prompt.
- **Cursor navigation around paste blocks** — Home/End jump to the
  prompt edges. Arrow keys treat each paste block as one logical
  character. Backspace/Delete remove the whole block atomically.
- **Double-Ctrl+C exit** — first press warns *"Press Ctrl+C again to
  exit"*; second press within 2 seconds actually exits. Standard
  Unix shell UX. Passes \`exitOnCtrlC: false\` to Ink's \`render()\`
  so Ink doesn't intercept the first press.
- **Idempotent cleanup** — \`cleanedUp\` flag prevents the double-
  teardown that used to leave terminals in a bad mode after edge-case
  exit paths.
- **Resume hint on graceful exit** — when the session has \`messageCount
  > 0\`, the goodbye footer prints \`franklin --resume <id>\` /
  \`franklin --continue\` lines. Empty sessions don't get the
  confusing "resume me" footer.

The session-id capture for the resume footer requires a new
\`onSessionStart?: (sessionId: string) => void\` field on \`AgentConfig\`
— wired in \`loop.ts\` once the session id is resolved.

### Follow-up: drop the dead \`shouldSummarizeInput\` helper

PR #43 included a \`shouldSummarizeInput(value)\` helper that was
defined but never called anywhere in the diff. Likely extracted from
an earlier draft. Removed in this release; the existing
\`renderInputValue\` + \`pasteSummary\` path covers the actual
rendering.

### Stats gap-warning is now scoped to the stats window

3.15.79 added the SDK-ledger reconciliation but compared
**all-time \`cost_log.jsonl\`** against **all-time \`franklin-stats.json\`**.
On a real machine where \`cost_log.jsonl\` had been rotated/truncated,
the all-time-vs-all-time comparison generated a false \"⚠ Gap\"
warning ("looks rotated or truncated") even when the recent slice
was perfectly aligned.

Fix: window the SDK ledger query by \`stats.resetAt ?? stats.firstRequest\`
so we compare ledger and stats over the SAME time window. New
\`resetAt: number\` field on the \`Stats\` interface, captured in
\`clearStats()\`. The gap warning now only fires when there's a real
discrepancy in the post-reset window.

\`stats.json\` and \`stats --json\` outputs gain \`sinceMs\` /
\`windowStartMs\` fields so callers can see exactly which window
the reconciliation ran against.

The \"empty stats\" early-return now checks BOTH
\`stats.totalRequests === 0\` AND \`sdkTotal === 0\` — so a brand-new
install where Franklin hasn't recorded anything yet but the SDK ledger
already has rows still surfaces the ledger summary.

361/361 tests pass.

## 3.15.81 — stalled-intent detector is English-only

Drops the localized regex branches added in 3.15.80. Franklin's source-level
detection logic stays English-only by policy — non-English locales
should not ship in agent code.

## 3.15.80 — stalled-intent recovery: switch model when a turn declares an action but emits no tool_use

**A Franklin session on \`nvidia/qwen3-coder-480b\` showed the assistant
say "First, I need to check if Node.js and npm are available. Let's
verify..." then \`end_turn\` without a single Bash call. The agent loop
treated the declared-but-unexecuted intent as the model's final answer
and the user saw "agent froze." Coder-tuned models (qwen3-coder-*) and
NIM-hosted Llama-4-Maverick routinely behave this way — they treat
declaring the next step as completing the turn.**

### What was wrong

Two existing guardrails missed this case:

- **Empty-response recovery** (line 1341) only fires when the turn has
  *zero* output — no text, no tools, no thinking. The stall has text.
- **Tiny-response counter** (line 1649) considers any text >3 chars as
  progress. The stall has ~200 chars of text.

So a stall slipped through both checks, the loop exited cleanly, and
the user got a polished plan and zero actions.

### What 3.15.80 does

New helper \`looksLikeStalledIntent(text)\` in \`src/agent/loop.ts\`:
detects action-intent markers ("Let me check…", "I'll start by…")
near the *tail* of a text-only turn. Long enough to look like a real
plan (≥24 chars), short-tail check (last 400 chars) so a normal answer
that mentions "check" mid-paragraph doesn't trigger.

New recovery branch in the agent loop (right after empty-response
recovery): when \`!hasTools && hasText && looksLikeStalledIntent(text)\`,
switch to a **tool-use-strong** fallback chain
(\`anthropic/claude-haiku-4.5\` → \`moonshot/kimi-k2\` →
\`openai/gpt-5\` → \`anthropic/claude-sonnet-4.6\`) and retry the same
prompt. Capped at 2 recoveries per turn, same as empty-response.

Re-prompting the *same* model is deterministic waste — the stall is a
training-data trait, not a transient hiccup. Switching to a model that
reliably emits \`tool_use\` blocks is the actual fix.

### Tests

- \`looksLikeStalledIntent: detects coder-model intent-without-tool_use stall\`
  exercises the screenshot's exact text, English variants, and confirms
  real completed answers ("Done.", concrete results) don't trigger recovery.

## 3.15.79 — \`franklin stats\` reads the SDK ledger (cost_log.jsonl) and surfaces the recorded-vs-wallet gap

**A user reported a session where Franklin showed \$0.0095 spent but the
wallet drained \$3.28 — ~345× discrepancy. Stage 1 of the fix:
\`franklin stats\` now reads the canonical SDK settlement ledger
(\`~/.blockrun/cost_log.jsonl\`) and shows it alongside Franklin's
recorded total, with a clear gap warning. Stage 2 (instrumenting the
13 helper LLM callsites that bypass \`recordUsage\`) ships next.**

### What was wrong

Three "agreeing" sources weren't actually independent:

| Source | Reality |
|---|---|
| \`franklin stats --json\` | reads \`~/.blockrun/franklin-stats.json\` |
| \`franklin insights\` | reads the same file |
| \`~/.blockrun/cost_log.jsonl\` | written by the \`@blockrun/llm\` SDK on every x402 settlement; **Franklin never read it** |

The first two are one source viewed twice. The third is the wire-truth
ledger of every paid call — but Franklin had zero code paths that read
it. So when helper LLM calls (analyzeTurn, prefetchForIntent,
compactHistory, checkGrounding, runVerification, MoA references,
subagent loops, learning extraction, brain extraction, etc.) settled
x402 payments through the SDK, those payments landed in
\`cost_log.jsonl\` but never bumped \`franklin-stats.json\`. The user's
recorded total drifted from wallet truth by ~345× in a session that
exercised heavy helper traffic.

### What 3.15.79 does

New module \`src/stats/cost-log.ts\` exports:
- \`loadSdkSettlements({path?, sinceMs?, untilMs?})\` — reads the
  SDK ledger, normalizes the SDK's snake_case keys (\`cost_usd\`,
  \`ts\` in unix seconds with subsecond precision, Python convention)
  to Franklin's camelCase + ms convention, skips malformed lines
  silently
- \`summarizeSdkSettlements({path?, sinceMs?, untilMs?})\` — totals +
  per-endpoint breakdown sorted by cost descending

\`franklin stats\` (both pretty and \`--json\` output) now shows three
numbers:

\`\`\`
Recorded Cost:  $0.0095   (franklin-stats.json — main loop + proxy + tools)
SDK Ledger:     $3.2800   (cost_log.jsonl — actual x402 settlements, 478 rows)
⚠ Gap:          $3.2705 (99.7%) ↑ — helper LLM calls (analyzeTurn /
   compaction / evaluator / verification / subagent / MoA / etc.)
   settled on-chain but bypassed recordUsage. SDK ledger is the wire truth.
\`\`\`

The arrow direction tells you which side is off:
- **↑** (SDK > recorded) — helper paths bypassing instrumentation. The
  ledger is wire truth; the recorded total is incomplete.
- **↓** (recorded > SDK) — \`cost_log.jsonl\` got rotated or truncated.
  The recorded total is more complete than the ledger here.

\`franklin stats --json\` output gains a \`reconciliation\` block with
\`{recordedUsd, sdkLedgerUsd, gapUsd, gapPct, significantGap}\` and an
\`sdkLedger\` block with the path, entry count, total, and top-10
endpoint breakdown — so dashboards / external tools can act on the
gap data.

A new "SDK Ledger (top endpoints)" section in pretty output surfaces
non-LLM endpoint spend (Modal, PM, x.com, exa, etc.) that flow through
tools and may not show up in the per-model breakdown.

### What's coming in 3.15.80 (Stage 2)

Instrument the 13 callsites where \`client.complete()\` fires a paid
LLM call but \`recordUsage()\` never runs. Add a shared
\`recordHelperCall({source, model, usage, costUsd})\` wrapper. The
biggest impact sites first:
- \`subagent.ts\` — recursive nested loop, currently completely
  unaudited
- \`compact.ts\` — \$0.01–0.05 per fire
- \`turn-analyzer.ts\`, \`intent-prefetch.ts\` — fire every user turn
- \`evaluator.ts\` (checkGrounding), \`verification.ts\` (runVerification)
- \`moa.ts\` — 5 references + 1 aggregator per invocation

After Stage 2, the gap should shrink to near-zero (only true SDK-
internal probes / retries remain unrecorded).

### Test coverage

- \`cost-log.jsonl reader handles SDK shape + windows + missing file\` —
  pins the snake-to-camel normalization, ts seconds-to-ms conversion,
  malformed-line skip, time-window filter, and missing-file empty
  return
- \`cost-log.jsonl reader returns empty when file missing\` — explicit
  cover for the no-ledger-yet case (first-paid-call hasn't happened)

357/357 tests pass.

### Why ship Stage 1 alone

The user's primary pain is *"my reported spend doesn't match my
wallet."* That's solved as soon as \`franklin stats\` shows the SDK
ledger total — the user can see their actual spend without waiting
for instrumentation of every helper. Stage 2 closes the per-source
breakdown so users can answer "which helper is the biggest spender"
— but that's analytics, not bookkeeping. Bookkeeping ships first.

## 3.15.78 — End-of-turn marker for question turns + dual-listing notice for tokenized equities

**Two UX-level fixes for issues that bit a real user session twice in one
hour today.**

### End-of-turn marker — silence after a question is no longer "death"

Real failure pattern: agent finishes a turn with *"Should I look up X?"*,
the terminal goes quiet, the user reads the silence as "Franklin died"
and pings to check the log. Twice in one hour today on the same
session. The Ink input box is already on screen but easy to miss after
a long output scroll.

Fix: when the model's last emitted text segment ends with a question
mark (ASCII \`?\` or fullwidth \`？\`), the agent loop appends a single
italic line before \`turn_done\`:

\`\`\`
*▸ awaiting your reply (or type a new message)*
\`\`\`

Trims trailing whitespace + closing punctuation (\`)\`, \`'\`, \`*\`, etc.)
before the question-mark check so questions wrapped in italics or
parentheses still match. Only fires on natural completion
(\`reason: 'completed'\`) — \`cap_exceeded\` / \`no_progress\` /
\`aborted\` paths already have their own user-facing copy explaining
what happened.

\`endedWithQuestion(parts)\` helper added next to the existing media-
size / wall-failure detectors in \`loop.ts\`.

### Dual-listing notice for tokenized equities (CRCL et al.)

The 2026-05-06 CRCL session: agent called \`TradingSignal\` for
\`CRCL\`, got back the tokenized/crypto leg ($0 price, $43K market cap),
correctly recovered ("ignore TradingSignal — pull live Pyth instead")
but burned a paid call + an extra confused turn before recovery.

The user's correction was important: the tokenized leg IS meaningful
data — it shows on-chain demand, DEX liquidity, basis to spot. The
fix isn't "prefer stock over crypto" — it's **return the crypto leg
with a clear label** so the agent knows it's the tokenized variant
and can also fetch the spot equity to compute the basis spread.

\`KNOWN_DUAL_LISTED_EQUITIES\` set in \`tools/trading.ts\` now flags 16
high-liquidity US equities with active tokenized listings:
\`CRCL, COIN, MSTR, PLTR, TSLA, AAPL, NVDA, MSFT, AMZN, GOOGL, META,
JPM, BRK, HOOD, SQ, PYPL\`. When TradingSignal is called with one of
these, the output prepends:

> ⚠ \`CRCL\` is also a US-listed equity. The data below is the
> **crypto / tokenized leg** (CoinGecko). For the spot equity
> (NYSE / NASDAQ) call \`TradingMarket\` with
> \`action: stockPrice, market: "us"\`. Run both in parallel to compute
> the basis spread (premium/discount of tokenized vs spot — that
> spread is the signal).

The TradingSignal tool description in the spec is updated accordingly,
so the model picks the dual-call pattern on its own without needing
the runtime warning.

Adding stock OHLCV to TradingSignal directly was scoped out — the
gateway has \`/v1/usstock/history/{symbol}\` but no provider/fetcher
plumbing on Franklin's side yet, ~1 day of work. The notice path
delivers most of the value (correct labeling + agent routing nudge)
in 30 LOC.

355/355 tests pass.

## 3.15.77 — Stream sanitizer: U+2502 / U+2500 → ASCII (broken tables fixed at the wire)

**3.15.76 added a system-prompt nudge asking models to use plain \`|\`
in markdown tables. opus-4.7 ignored it 2026-05-06 — emitted a CRCL
fundamentals analysis with \`│\` data rows and \`|\` separator. No
renderer parses the mix; the "table" displayed as run-on text again.**

Prompt-only fixes are unreliable by definition. This ships the next
escalation: a streaming-boundary sanitizer that swaps \`│\` (U+2502)
→ \`|\` and \`─\` (U+2500) → \`-\` on every assistant text delta. Works
regardless of model, route, or whether the model read the prompt rule.

### Where the swap happens

\`appendText\` in \`src/agent/llm.ts\` is the single chokepoint that all
streaming text passes through before reaching:
- the user's terminal (via \`onStreamDelta\`)
- the conversation history (collected → \`Dialogue.content\`)
- the audit log + session JSONL

Sanitizing at this entry point means every downstream surface gets the
corrected version. The model's NEXT turn sees its own corrected output
in the history, which reinforces the right pattern over time.

### Trade

Unconditional swap. The rare case where a user asks "what does U+2502
look like" and the model wants to emit a literal \`│\` loses fidelity.
Acceptable: that case has zero observed real-world frequency, and the
broken-tables case bites every few days.

If a future case justifies fence-aware sanitizing (preserving box-drawing
inside \`\`\`code blocks\`\`\`), the helper is exported and the call site is
one line — easy to upgrade.

### Test coverage

New unit test pins:
- broken table with \`│\` + ASCII separator → all \`│\` swapped to \`|\`
- horizontal \`─\` swapped to \`-\`
- pure-ASCII input unchanged
- empty / no-boxes input unchanged

355/355 tests pass.

## 3.15.76 — Audit prompts strip trailing synthetic labels + table-format nudge

### Trailing \`[SYSTEM NOTE]\` no longer pollutes audit prompts

3.15.71 added skip-logic for harness-injected user messages that
**start** with a SCREAMING-CASE bracket like \`[FRANKLIN HARNESS
PREFETCH]\`. Pollution still slipped through: the post-response
evaluator now appends \`[SYSTEM NOTE] The user is correcting you...\`
to the user's real text in the SAME role:"user" message. Audit prompt
ended up half-real, half-synthetic.

Fix: \`extractLastUserPrompt\` also matches a trailing \`\\s\\[A-Z…\\]\`
pattern and trims everything from there. The whitespace prefix gates
the match so legitimate input like \`see [my doc](url)\` (lowercase
inside the brackets) passes through untouched.

### System-prompt: ASCII pipes only in markdown tables

Real session 2026-05-06: the agent emitted a table where data rows
used the box-drawing character \`│\` (U+2502) but the separator row
used plain \`|\`. No markdown renderer parses that mixed shape — the
"table" displays as run-on text. Added a one-liner under the System
section directing models to use plain \`|\` and \`---\` and to fall
back to a bullet list rather than emitting a malformed table.

This is prompt-only — works on any model. Won't catch every case (the
model has to read the line) but it's the cheapest pre-emption for the
most common rendering bug.

### Test coverage

Four new assertions on \`extractLastUserPrompt\`:
- trailing \`[SYSTEM NOTE]\` is stripped from a real message
- cascading suffixes (\`...[GROUNDING] retry [SYSTEM] correcting\`)
  trim from the first synthetic onward
- markdown-link-shaped brackets (\`see [my doc](url)\`) pass through
- standalone-bracket message still returns undefined (start-anchor
  skip wins)

354/354 tests pass.

## 3.15.75 — Predexon nested-shape formatters (no more [object Object])

**The 3.15.74 ship "passed" e2e but only validated headers and absence of
HTTP errors. The actual rendered output was broken — every position row
read \`[object Object]\` and every P&L number read "n/a". Verified live
2026-05-06 in a real session: a user asked the agent to analyze a
Polymarket wallet, the agent successfully called \`walletPositions\`,
got back valid JSON, and the formatter rendered three rows of
\`[object Object] — P&L n/a\` instead of the actual market titles + P&L.
Agent then fell back to bash-curling \`data-api.polymarket.com\` to
get the real numbers.**

### Root cause: \`as string\` lied on nested objects

Predexon returns a richer, more structured response than the flat shape
the formatter assumed. Verified shapes (live 2026-05-06):

- **walletPositions** rows: \`{ market: {title, side_label, ...},
  position: {shares, avg_entry_price, total_cost_usd, ...},
  current: {price, value_usd},
  pnl: {unrealized_usd, unrealized_pct, realized_usd} }\`
- **walletProfile** body: \`{ user, metrics: {one_day, seven_day,
  thirty_day, all_time} }\` — every stat lives under \`metrics.<window>\`,
  none at top level.
- **walletPnl** body: \`{ granularity, start_time, end_time,
  wallet_address, realized_pnl, unrealized_pnl, total_pnl,
  fees_paid, fees_refunded, pnl_over_time: [{timestamp,
  pnl_to_date}] }\` — pre-3.15.75 looked for \`series\`/\`history\`/\`daily\`
  (don't exist) and \`total_value\`/\`equity\` (don't exist).

Pre-3.15.75 the formatter cast \`p.market\` as string and template-
interpolated it. JS coerces objects via \`Object.prototype.toString\`
which yields \`[object Object]\`. Numeric fields like \`p.size\`,
\`p.avg_price\`, \`p.cashPnl\` resolved to \`undefined\` and rendered
"P&L n/a" everywhere.

### Fix: \`pickString\` helper + per-action shape-aware formatters

\`pickString(...candidates)\` walks each candidate: returns it if it's
already a string, otherwise looks for common name-bearing keys
(\`title\`, \`question\`, \`slug\`, \`name\`, \`label\`, \`market_slug\`,
\`event_title\`) inside if it's an object. All call sites that used
\`(p.foo || p.bar) as string\` now go through this helper, so a nested
title like \`p.market.title\` resolves correctly instead of stringifying
the whole \`market\` object.

Per-action formatters rewritten to walk the actual nested shape:

- **walletPositions**: walks \`market\`, \`position\`, \`current\`, \`pnl\`
  sub-objects. Renders title (with \`market.side_label\`),
  \`position.shares\`, \`position.avg_entry_price\`,
  \`current.value_usd\`, and \`pnl.unrealized_usd\` / \`pnl.unrealized_pct\`.
  Falls back to flat fields if the shape ever flattens.
- **walletProfile**: walks \`metrics.all_time\` for headline stats
  (total_pnl, realized_pnl, volume, ROI, win_rate, trades,
  active_positions, wallet_age_days), plus a recent-window line with
  1d/7d/30d total_pnl and trade counts. Lets the agent judge momentum
  without a separate walletPnl call.
- **walletPnl**: uses \`total_pnl\`, \`realized_pnl\`, \`unrealized_pnl\`,
  \`fees_paid\` from the top level. Time series walks \`pnl_over_time\`
  (not the imagined \`series\`/\`history\`), filters zero-pnl warmup days,
  and treats timestamps as **unix seconds** (the pre-3.15.75 code
  parsed them as ISO strings or millis and rendered \`1970-01-01\`
  for half the points).

### E2E now asserts \`[object Object]\` is gone

The 3.15.74 e2e tests passed because they only checked for header
strings and absence of "422". A regression that turned every row to
\`[object Object]\` would have shipped silently. Added explicit
\`!/\\[object Object\\]/.test(result.output)\` assertion to all five
PredictionMarket paid e2e tests. Combined with the existing \`(422|Bad
Request|missing)\` check, the suite now catches both wire-format and
formatter regressions.

### Real before/after on the user's session

User asked: *"0xdfe3fedc... analyze this Polymarket address; can I copy this trader?"*

**Before (3.15.74):**
\`\`\`
1. **[object Object]** — P&L n/a
2. **[object Object]** — P&L n/a
3. **[object Object]** — P&L n/a
\`\`\`
→ agent ignored its own tool output and bash-curled Polymarket data-api directly.

**After (3.15.75):**
\`\`\`
1. **Zelenskyy out as Ukraine president by end of 2026?** — No · 203,111.96 shares · avg 61.6% · now $174.7K · P&L $49.6K (39.7%)
2. **Will the US acquire part of Greenland in 2026?** — No · 172,151.62 shares · avg 77.0% · now $149.3K · P&L $16.8K (12.6%)
3. **Russia x Ukraine ceasefire by end of 2026?** — No · 217,830.13 shares · avg 53.4% · now $148.1K · P&L $31.9K (27.4%)
\`\`\`

353/353 local + 14/14 free e2e + 5/5 paid e2e pass.

## 3.15.74 — Live e2e validates 5 PredictionMarket endpoints; two more wire-format bugs squashed

**Added paid e2e coverage for the new prediction-market actions and ran
them against the real Predexon gateway. Caught two more bugs that local
tests can't see.**

### \`searchAll\` query param: \`search\` → \`q\`

Same param-name guess pattern as the 3.15.70 walletProfile bug. The
\`/v1/pm/markets/search\` endpoint expects \`q\`, not \`search\`. Verified
2026-05-06 from a live 422:
\`{"detail":[{"type":"missing","loc":["query","q"]}]}\`. Fixed: rename on
the wire, public input field stays \`search\` for ergonomic consistency
with \`searchPolymarket\` / \`searchKalshi\`.

### \`walletPnl\` requires \`granularity\` from a fixed enum

The 3.15.73 ship sent no \`granularity\` param at all. Predexon rejects
the call:
\`{"detail":[{"type":"missing","loc":["query","granularity"]}]}\`. Default
\`day\`, not \`daily\` — the enum is singular: \`day | week | month | year |
all\` (a second 422 surfaced the valid set:
\`"Input should be 'day', 'week', 'month', 'year' or 'all'"\`).

Added a top-level \`granularity\` field to the tool input schema with
the enum so models can override (\`granularity="week"\` for a weekly
P&L series).

### Error truncation bumped 200 → 600 chars

The PredictionMarket error wrapper used to slice gateway errors at 200
chars — that cut off the enum-options hint right where it would have
been most useful. Lifted to 600. Future param-shape mismatches surface
the valid input set in the agent's tool result, so the model can
self-correct on the next call without us having to ship a fix.

### New paid e2e coverage (5 tests, ~\$0.025 per run)

All gated behind \`RUN_PAID_E2E=1\`:

- \`walletProfile (single): live /wallet/{addr} returns profile data\`
- \`walletPnl: live /wallet/pnl/{addr} returns P&L data\`
- \`walletPositions: live /wallet/positions/{addr} returns positions\`
- \`leaderboard: live /polymarket/leaderboard returns top wallets\`
- \`searchAll: live /markets/search returns multi-platform results\`

Each test calls the capability directly (skipping the agent loop) so
failures pinpoint to wire format. The 3.15.70→3.15.74 bug chain
(walletProfile 422, then searchAll 422, then walletPnl 422 twice in
sequence on different params) would have been caught instantly by these
tests if they had existed before. Now they do.

353/353 local + 14/14 free e2e + 5/5 paid e2e pass.

## 3.15.73 — Wallet-analysis triplet (walletProfile + walletPnl + walletPositions)

**Fix continued from 3.15.72. Single-wallet "analyze this trader"
questions now hit the right Predexon endpoints instead of the
batch one.**

### What was still wrong after 3.15.72

3.15.72 fixed the batch endpoint's param name (\`wallets\` →
\`addresses\`) so it stopped 422'ing. But the gateway team
clarified 2026-05-06 that "analyze this wallet / can I copy
this trader" questions don't want the batch endpoint at all —
they want one of three single-wallet endpoints (path-parameter,
not query-parameter):

| Intent | Endpoint |
|---|---|
| Full profile (labels, scores, stats) | \`GET /v1/pm/polymarket/wallet/{wallet}\` |
| P&L summary + time series | \`GET /v1/pm/polymarket/wallet/pnl/{wallet}\` |
| Positions (open + historical) | \`GET /v1/pm/polymarket/wallet/positions/{wallet}\` |

Verified 2026-05-06 in a real session: opus-4.7 picked
\`walletProfile\` correctly for "analyze 0xdfe3fedc... copy trade"
but only got the batch endpoint, which (a) wasn't the right
data shape for the question and (b) returned 422 because of the
param-name bug. Even after the param fix, the agent would still
have to bash-curl \`data-api.polymarket.com\` directly to get
P&L and positions detail — bypassing the paid-tool path Franklin
exists to provide.

### Three actions now, smart dispatch

- **\`walletProfile\`** (\$0.005) — full profile.
  - Single address (\`wallets="0xabc"\`) → \`/wallet/{addr}\`
  - Comma-list (\`wallets="0xabc,0xdef"\`) → batch
    \`/wallets/profiles?addresses=...\`
- **\`walletPnl\`** (\$0.005) — single-wallet P&L summary +
  realized-P&L time series. Path:
  \`/wallet/pnl/{wallet}\`. Multi-wallet input is rejected so agents
  run one paid call per wallet in parallel instead of silently dropping
  addresses.
- **\`walletPositions\`** (\$0.005) — single-wallet positions
  (open + historical) with per-position P&L breakdown. Path:
  \`/wallet/positions/{wallet}\`.

### Routing nudge for the trader-analysis pattern

\`context.ts\` system prompt and the tool description both now
direct: *"analyze this wallet / can I copy this trader / copy trade
/ show me their P&L AND positions"* → run \`walletProfile\` +
\`walletPnl\` + \`walletPositions\` **in parallel** with the same
address. Three \$0.005 calls = full picture for \$0.015. Explicitly
forbids \`Bash\`-curling \`data-api.polymarket.com\` — that's
bypassing the paid-tool architecture.

### Tool inventory still tight

PredictionMarket now has 10 actions. Comment at
\`prediction.ts:9\` warns about hallucinated tool names from
weak models with bloated inventories. Three new actions vs three
new tools: same surface area cost, distinct semantics. The
existing single-action dispatch keeps the model's view simple.

### Observed user behavior the fix is responding to

Real session 2026-05-06: opus-4.7 attempted walletProfile, got
422, then burned 6 Bash retries / \$0.32 against
\`data-api.polymarket.com\`. The user reported the agent
"doesn't go to predexon data on its own" — the diagnosis was
right; the model **did** route to the right tool, the tool was
returning errors and the model fell back to non-paid paths.
Both issues now closed.

353/353 tests pass.

## 3.15.72 — walletProfile param name fix (was 422'ing every call)

**Real shipped bug from 3.15.70's walletProfile addition.**

The action sent the query param as \`wallets\` based on the openapi
description ("Batch retrieve wallet profiles"). Predexon's actual
endpoint expects \`addresses\`. Result: every \`walletProfile\` call
returned HTTP 422 with
\`{"detail":[{"type":"missing","loc":["query","addresses"]}]}\` and
the agent fell back to direct Bash + curl against the Polymarket
API — bypassing the entire paid path the action exists to cover.

Verified live 2026-05-06 in a real user session: opus-4.7 received
the wallet question, called PredictionMarket walletProfile correctly
(model behavior was right), got a 422, then burned 6 Bash retry calls
and \$0.32 before the signature loop guard fired. The user's complaint
"feels like it doesn't go to predexon data on its own" was the
correct read — the model **did** go there, the tool was broken.

Fix: query param renamed from \`wallets\` → \`addresses\` on the wire.
Public input field stays \`wallets\` for ergonomics — agents pass
\`wallets="0xabc"\` exactly as the spec describes.

Other 3.15.70 actions (\`searchAll\`, \`leaderboard\`,
\`smartActivity\`) pass conventional param names (\`search\`,
\`limit\`, \`sort\`); no live evidence of similar mismatches yet.
If they surface, same fix shape: rename on the wire, keep the
public field stable.

352/352 tests pass.

## 3.15.71 — Tighter bloat-compaction trigger + audit prompts skip harness-injected text

**Two fixes from a fresh audit-log forensic pass.**

### Bloat-compaction threshold tightened (15 calls + \$0.03)

3.15.69 added a research-bloat compaction trigger at
\`turnToolCalls > 30 && turnCostUsd > 0.05\`. Verified 2026-05-06
against a real franklin-shorts edit session: 16 deepseek-v4-pro
calls cost \$0.055 and ended naturally before the trigger could
fire — even though by call #4 the per-call input was already
13K tokens. The session was paying input-replay tax on every
call but never crossed the threshold.

Tightened to \`turnToolCalls > 15 && turnCostUsd > 0.03\`.
Catches sessions where input-replay has clearly started biting.
Worst-case downside is one extra summary call (~\$0.005) for a
session that would have ended at exactly the boundary; the
fire-once-per-turn flag still bounds it.

### Audit \`prompt\` field stops capturing harness-injected text

\`extractLastUserPrompt\` walks the dialogue history backward
looking for the last message with \`role: "user"\`. Anthropic's
message format uses \`role: "user"\` for harness-injected context
too, so the audit was logging synthetic strings instead of the
real user prompt:

- 403 audit rows began with \`[FRANKLIN HARNESS PREFETCH]\`
  (the pre-turn live-data injection from \`intent-prefetch.ts\`).
- 18 rows began with \`[GROUNDING CHECK FAILED]\` (the
  grounding-retry feedback from the post-response evaluator).

421 of 4,983 audit entries (~8.5%) were unusable for cost
attribution because the prompt field showed harness chatter
instead of the user's question.

Fix: \`extractLastUserPrompt\` now skips messages whose first
non-whitespace content is a SCREAMING-CASE bracketed label
(\`[FRANKLIN HARNESS PREFETCH]\`, \`[GROUNDING CHECK FAILED]\`,
\`[ESCALATION]\`, \`[CONTEXT COMPACTION]\`, \`[SYSTEM]\`, etc.)
and walks back to the real user turn. If the history contains
only synthetic injections, returns \`undefined\` rather than
fabricating a prompt.

### Verified non-bugs from the same audit pass

- **NVIDIA models charging unexpected amounts** — actually
  aggregation artifact. Sessions like \`b12f3b0c\` showed
  qwen3-coder-480b "costing" \$3.64; turns out the session
  contained 5 sonnet-4.6 calls plus the qwen calls (which were
  free as expected). Per-(session, model) breakdown clears it.
- **Fallback flag rarely set** — 1/952 entries with explicit
  fallback. Genuinely low rate; not a measurement bug. The one
  \`fallback: true\` row in session \`efd5e412\` matches the
  surrounding fallback chain correctly.
- **\`routingTier\` missing on 80% of entries** — by design.
  Direct-selected models (zai/glm-5.1, etc.) bypass auto-routing.

352/352 tests pass.

## 3.15.70 — Predexon: 8 actions across 5 venues, wallet/leaderboard surfaces, panel telemetry

**Franklin's `PredictionMarket` tool went from 4 actions over 2 venues
(Polymarket + Kalshi) to 8 actions over 5 venues, plus wallet-tracking,
leaderboard, and smart-money discovery surfaces.**

### `smartMoney` is the per-market drill-down; `smartActivity` is discovery

The live BlockRun Predexon registry exposes both smart-money surfaces:

- `/v1/pm/polymarket/market/<conditionId>/smart-money` — per-market
  smart-money positioning.
- `/v1/pm/polymarket/markets/smart-activity` — discover markets where
  high-performing wallets are active.

Action surface change:
- **ADDED:** `smartActivity` — \$0.005 — markets where smart wallets
  are positioning right now.
- **ADDED:** `leaderboard` — \$0.001 — global top wallets by P&L.
- **KEPT:** `smartMoney` — \$0.005 — smart-money flow on a specific
  Polymarket `conditionId`.

### Three more actions for things Franklin couldn't do before

- **`searchAll`** — \$0.005 — single call across Polymarket+Kalshi+
  Limitless+Opinion+Predict.Fun. Today the agent only knew to query
  Polymarket+Kalshi separately and missed three venues entirely.
  This is the new default for "is there a market on X anywhere?".
- **`walletProfile`** — \$0.005 — batch P&L + position lookup for one
  or more Polymarket wallet addresses. Pass \`wallets="0xabc"\` for a
  single trader or \`wallets="0xabc,0xdef,0xghi"\` for a watchlist.
  Directly serves Franklin's "agent with a wallet" positioning —
  natural pairing with "is this trader profitable / should I follow
  them".

### Routing nudges in `context.ts`

The system prompt mapped only "what are the odds of X" → PredictionMarket.
It now routes:

- "is there a market on X anywhere?" → `searchAll`
- "who's profitable / top traders / who to follow on Polymarket"
  → `leaderboard`
- "how is wallet 0xabc doing / show this trader's P&L" → `walletProfile`
- "what are smart traders betting on right now" → `smartActivity`
- "show smart money for this condition_id" → `smartMoney`

Without these routing hints, even with the new actions wired, the
model wouldn't reach for them.

### Panel "Markets" tab now reflects prediction-market spend

Prediction-market calls go through the same BlockRun gateway as the
trading-data calls, but the path was bypassing the
`src/trading/providers/telemetry.ts` ring buffer that the Markets tab
reads from. So users running `/v1/pm/...` calls saw zero of that
spend in the panel.

`getWithPayment` in `src/tools/prediction.ts` now calls `recordFetch`
with `provider: 'blockrun'`, the endpoint path, latency, and the
per-action price (table-driven). Effect: every prediction-market
call shows up in the Markets tab's "Calls today / Spend today /
Recent paid calls" alongside trading calls. The endpoint path
(\`/v1/pm/polymarket/leaderboard\` etc.) is visible in the
recent-calls feed so users can see exactly which Predexon surface
the agent hit. The Markets tab tagline is updated:
*"How Franklin gets trading + prediction-market data — and what it
costs."*

### Cost-recording timing

`recordFetch` is called once per logical PredictionMarket action,
not twice. The 402 challenge response is excluded from cost (it's
free); only the post-payment-signature settlement is charged. Both
success and failure paths record latency + ok-flag for the panel's
"blockrun OK" health indicator.

### Test coverage

- `PredictionMarket spec exposes the eight x402-paid actions (3.15.70)`
  — pins the enum including `smartMoney` and the newer discovery surfaces.
- `PredictionMarket walletProfile without wallets fails fast (3.15.70)`
  — fast input validation (no network call, no wallet sign).
- `PredictionMarket smartMoney without conditionId fails fast (3.15.70)`
  — preserves per-market drill-down while avoiding accidental paid calls.

351/351 tests pass.

## 3.15.69 — Claude Code import + cost-control gaps from audit-log forensics

**Two batches surfaced from one debugging session: a broken import path
on fresh installs, and five cost-control gaps confirmed against a real
audit log.**

### `franklin migrate` — Claude Code current layout

`migrate.ts` was looking at the legacy paths `~/.claude/mcp.json`
and `~/.claude/history.jsonl` — files that haven't existed on a fresh
Claude Code install in years. New users running `franklin migrate`
saw zero items detected. Existing users with stale legacy files
(seeded by older agent CLIs) silently went down a different code
path that imported less than what's actually on disk.

Real Claude Code 2026 layout:
- MCP config: `~/.claude.json` (top-level, ~263KB on a typical
  machine), field `mcpServers`. Field is `type` not `transport`.
- Sessions: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
  — one file per conversation. 241 main sessions on the dev machine
  used to verify; 1,591 if you count subagent fragments (those are
  correctly excluded; only the depth-2 main session JSONLs import).

Fix:
- Detect `~/.claude.json` first; fall back to legacy `~/.claude/mcp.json`.
- Walk `~/.claude/projects/<slug>/<uuid>.jsonl`; fall back to legacy
  `~/.claude/history.jsonl`.
- Convert Claude Code line shape (`{type, message:{role,content},
  timestamp, sessionId, cwd}`) into Franklin's `Dialogue` (`{role,
  content}`). Preserves session boundaries instead of mashing every
  message into a daily blob.
- `migrateMcp` accepts both `type` (Claude Code) and `transport`
  (older agents) fields.

### Imports survive the next agent launch

`pruneOldSessions()` runs every time `franklin` starts and keeps
only the 20 newest sessions. Without protection, importing 200+
historical sessions would have 180+ silently deleted on the very
next launch. Verified path: agent loop → `pruneOldSessions(sessionId)`
at line 644.

Fix: new `imported?: true` flag on `SessionMeta`. The cap-prune and
the ghost-session sweep both skip imports. `updateSessionMeta`
preserves the flag like it preserves `chain` — once imported, always
imported, so resuming an imported session can't drop the flag on
its first turn.

### Audit-log output token undercount (model-agnostic estimator)

Real audit log forensics on `franklin-audit.jsonl`:

| Model | Calls | Tiny outputs (≤2 tokens) |
|---|---|---|
| `zai/glm-5.1` | 1,686 | ~89% |
| `nvidia/qwen3-coder-480b` | 176 | 57% |
| `google/gemini-2.5-flash` | 28 | 32% |
| `anthropic/claude-sonnet-4.6` | 302 | 1% |
| `deepseek/deepseek-v4-pro` | 297 | 0.3% |

Three model families behind the gateway send `message_start` with
the placeholder `output_tokens: 1` and never finalize via
`message_delta`. Audit logged 1 even when the model produced
17 distinct multi-line bash commands worth of `tool_use` content.
Anthropic and DeepSeek were already correct.

Fix in `src/agent/llm.ts`: at end of stream, if `usage.outputTokens
<= 1` but `collected[]` has real content, estimate from byte length
(~4 chars/token). Model-agnostic — only fires when the wire value is
implausibly small for the actual payload, so genuinely-tiny responses
stay tiny. Cost forensics work again.

### Cap-exceeded messages report real spend

The user-facing message used to say *"Bash called 3× with the same
input"* — but in the verified failure case, 47 other bash calls
preceded it. The user reasonably reads the message and thinks the
guard fired at call #3 when it actually fired at call #50.

Fix: cap-exceeded messages now show `N tool calls, $X spent this turn`.
New `turnCostUsd` accumulator next to the existing `turnToolCalls`,
bumped at the same site as `sessionCostUsd`. Both the HARD_TOOL_CAP
message and the signature-loop message use it.

### Failed-external-call hard stop (catches "thrashing against a wall")

The signature-based loop guard only catches exact-input repeats. It
misses the case where a model tries 17 structurally-distinct ways
to hit a dead endpoint — different headers, methods, auth schemes,
query params — and every one returns 4xx/5xx/WAF. Verified on a
real session: glm-5.1 burned 50 calls / $0.05 cycling auth variants
against Cloudflare-blocked `api.querit.ai` before the signature
guard finally fired on the first exact repeat.

New guard: 5 consecutive `Bash` or `WebFetch` calls whose output
matches `/(401|403|429|5xx|unauthorized|forbidden|WAF|cloudflare|fault filter|blocked|invalid (auth|api|token|key|bearer))/i`
→ break. Resets on any non-failed external call so legitimate
retry-then-succeed paths aren't punished.

### Research-bloat compaction

The window-based auto-compact only fires near 172K tokens for a
200K-context model. Research sessions burn money long before that.
Top-spend session in the audit log: $6.67 on `google/gemini-2.5-flash`
in 121 calls — never approached its 1M-token compaction threshold.
Same shape on glm-5.1: $0.18 / 177 calls / 3.17M cumulative input,
average per-call input grew to 17.9K because every tool result kept
replaying.

New trigger: when `turnToolCalls > 30` AND `turnCostUsd > 0.05` AND
not yet compacted this session, force-compact even though we're
nowhere near the context window. Surfaces a `🗜 Research-bloat compact:
N calls / $X this turn` line so the user sees why it fired. Fire-once
per session — avoids flapping once thresholds stay crossed; users can
still re-engage via `/compact`.

### System-prompt nudge for comparison questions

Added one line under "Tool Selection Patterns" in `context.ts`: for
"X vs Y, which is better" comparisons, prefer
WebSearch/ExaSearch/WebFetch on each vendor's docs+pricing pages
before curling the live API. Catches the same Querit-vs-Exa failure
mode at the planning stage instead of waiting for the loop guard
to break it.

### Plugin SDK doc reconciliation

`docs/plugin-sdk.md` and `CLAUDE.md` referenced `src/plugins-bundled/`
as if it shipped with the repo. The directory was retired in v3.2.0
when `social` became a native subsystem; nothing has shipped there
since. Updated:
- `CLAUDE.md` project tree replaces the dead `plugins-bundled/` row
  with the actually-present `trading/` and `content/`.
- `docs/plugin-sdk.md` removes the fake `plugins-bundled/social/`
  example tree, adds a note that no bundled plugins ship today and
  the inline example is canonical.
- `src/plugins/registry.ts` comments now describe the lookup path as
  forward-compat rather than as built from a non-existent source.

No runtime behavior changed by these doc fixes. The plugin
discovery path order, the `Workflow` SDK exports, and the `WorkflowStepContext.callModel`
signature are all stable. Hackathon participants importing from
`@blockrun/franklin/plugin-sdk` get the same SDK they had yesterday,
just with docs that match what's on disk.

## 3.15.68 — Reap pid-less queued tasks (5 min cutoff) + package-lock sync

**Two leftovers from the long fix loop, finally shipped.**

### Lost-detection: pid-less queued tasks

\`src/tasks/lost-detection.ts\` had this fix sitting uncommitted
across the entire 3.15.40 → 3.15.67 loop. Verified now: the
fix is correct and the test (\`lost-detection: stale queued
task without pid → reaped after timeout\`) was passing all
along.

The bug it covers: \`startDetachedTask\` creates a task with
\`status: queued\` and no \`pid\` field. The runner subprocess
is supposed to write its own pid on entry. If the runner
crashes during module import (wrong \`cliPath\`, syntax error
in \`dist\`, missing dependency on a corrupted node_modules),
the pid never gets written.

Pre-fix outcome: the task lives forever in
\`status: queued / pid: undefined\`. \`reconcileLostTasks\`
short-circuited on \`typeof t.pid !== 'number' continue\` —
nothing to ping, nothing to reap. Hygiene also didn't touch it
(not terminal). \`franklin task list\` showed permanent ghost
entries.

Fix: when a task is \`status: queued\` AND has no pid AND was
created \`> QUEUED_NO_PID_TIMEOUT_MS\` (5 min) ago, treat it as
runner-crashed-on-import and reap. 5 minutes leaves generous
headroom for slow networks / cold node_modules cache (legit
startup can take 30+ seconds).

### package-lock sync

\`package-lock.json\` still carried \`version: 3.15.39\`
(11 ships ago — it never gets re-synced when only
\`package.json\` is bumped). \`npm install --package-lock-only\`
reconciles to current.

Tests: 348/348 pass — the lost-detection fix already had test
coverage in \`test/local.mjs\` from when it was first written.

### Why this matters NOW

The user reported "there are a lot of system changes please
check" while running locally-installed
\`@blockrun/franklin@3.15.60\` — **7 versions behind npm
latest**. None of the consistency fixes from 3.15.61 onward
(latency tracking, payment-chain, real Solana wallet,
sane model names, task retention) are active on their
machine yet. They need:

\`\`\`
npm i -g @blockrun/franklin@latest
\`\`\`

… and a restart of any running franklin process. After that
the new task-list header, the brain hygiene, the wallet path
fixes, and this lost-detection improvement all kick in
together.

## 3.15.67 — Two follow-ups: \`task list\` header + hygiene log surfaces all counters

Two consistency tweaks discovered in the same scan that found
3.15.66's task-retention hole:

**1. \`franklin task list\` had no header row.** Verified
2026-05-05 — output looked like:

\`\`\`
t_mors8mba_f37c6c06  succeeded   14h19m  ETL SDK v2
t_mors6idr_57ff10f5  succeeded   14h21m  ETL SDK v1 - ADC auth
\`\`\`

vs \`franklin content list\` (shipped 3.15.58) which has:

\`\`\`
id        type      status      spent/cap      assets  title
…
\`\`\`

Same product, two list commands, different conventions. The
3.15.46 fix to "age" semantics (running = elapsed-since-start;
terminal = since-end) was real but **invisible without column
labels** — \`14h19m\` could mean either.

Fix: \`src/commands/task.ts\` \`list\` action prepends a header
row \`runId  status  age  label\`. Width auto-fits the longest
runId in the result set.

After the fix:

\`\`\`
runId                status        age  label
t_mors8mba_f37c6c06  succeeded   14h20m  ETL SDK v2
t_mors6idr_57ff10f5  succeeded   14h21m  ETL SDK v1 - ADC auth
\`\`\`

**2. Hygiene-startup log was missing the new counters.** When
3.15.44 added \`brainJunkEntitiesRemoved\` and 3.15.66 added
\`oldTasksRemoved\`, the \`logger.info\` line in
\`src/agent/loop.ts:657\` was never updated. Result: when
hygiene cleared 3 junk brain entities + 5 old tasks at startup,
the log printed:

\`\`\`
Data hygiene: 0 legacy, 0 data files, 0 cost_log rows, 0 orphan tool-results dirs cleaned
\`\`\`

— total of 0 even though 8 things were actually cleaned. The
\`totalCleaned > 0\` guard meant the line might not even fire.
Worse, even when it did fire, brain + task counters were
invisible.

Fix: \`totalCleaned\` now sums all six counters; the log line
includes all six fields:

\`\`\`
Data hygiene: 0 legacy, 0 data files, 0 cost_log rows, 0 orphan tool-results dirs, 3 junk brain entities, 5 expired tasks cleaned
\`\`\`

Tests: 348/348 pass — existing CLI tests for \`task list\` still
match (they assert content, not exact line layout).

## 3.15.66 — Hygiene now prunes terminal task records older than 7 days

Verified 2026-05-05 on a real machine: \`~/.franklin/tasks/\`
held 10 task directories, the oldest \`status: lost\` from
**53 hours ago** (2.2 days). Nothing in the hygiene path ever
removed them — \`pruneOldSessions\` covers \`~/.blockrun/sessions/\`,
but the tasks subsystem (added in v3.10) shipped without
retention.

Each task directory carries:

\`\`\`
meta.json       — small (~500 B)
events.jsonl    — small unless dense progress events
log.txt         — child process stdout/stderr; verified one
                  ETL job's log was 1.1 MB
\`\`\`

For a power user running daily detached jobs (the user
shipping this fix has done 10+ ETL passes in the last 24h),
disk fills slowly forever. Worse, \`franklin task list\`
output keeps growing — the screen-of-shame factor.

Fix: new \`pruneOldTaskRecords()\` helper in
\`src/storage/hygiene.ts\`, wired into the existing
\`runDataHygiene()\` pass that runs once at agent session start.

Retention rules (deliberately conservative):

- **Age cutoff: 7 days.** Keeps the previous week's history
  (covers most "what did I run last weekend?" lookups).
- **Status filter: terminal only.** \`running\` / \`queued\`
  are NEVER touched, regardless of age — a long ETL job that's
  been running for 8 days stays untouched. Same protection
  shape \`pruneOldSessions\` uses for the active session.
- **Floor: keep 5 most-recent.** Even if all 5 are 30 days
  old, they survive — users coming back from a long pause
  shouldn't find their history wiped.
- Walks both \`~/.blockrun/tasks/\` (canonical, post-3.15.42)
  and \`~/.franklin/tasks/\` (legacy fallback). Skips the
  legacy walk when \`FRANKLIN_HOME\` is set so test isolation
  stays clean.
- Best-effort: corrupt \`meta.json\` or unreadable dirs are
  skipped silently. Never deletes a dir we can't confirm is
  terminal.

\`HygieneReport\` gains \`oldTasksRemoved\` so the cleanup
surfaces in agent-startup logs (same shape as
\`brainJunkEntitiesRemoved\` in 3.15.44).

One regression test builds 8 fixture task dirs covering every
case — recent (5 different statuses including \`running\` and
\`lost\`), ancient running, ancient terminal, ancient lost —
runs hygiene against a fake \`FRANKLIN_HOME\`, asserts exactly
2 are pruned (the two ancient terminals outside the top-5)
and the other 6 survive (5 recent + ancient running).

Tests: 349/349 pass (was 345 before, +4 between this session
and the in-progress test additions).

Existing tasks on installed machines: hygiene runs at next
\`franklin\` start, so the cleanup happens automatically.
Power users can verify with \`franklin task list\` — entries
with terminal status older than 7 days will disappear after
the next start.

## 3.15.65 — Chat-completions example list uses real models (no fictional \`gpt-5.1\` / \`grok-5\`)

Verified 2026-05-05 by cross-checking the agent system prompt
against \`franklin-stats.json byModel\` (every model the user
has ever called):

\`\`\`
Prompt cited:           openai/gpt-5.1     xai/grok-5     anthropic/claude-sonnet-4.6
On the gateway today:   ❌ doesn't exist   ❌ doesn't exist   ✓ real
\`\`\`

If the agent reads "e.g. \`openai/gpt-5.1\`" and copies the name
verbatim into a \`/v1/chat/completions\` request, the gateway
returns 400. Same shape as the bug 3.15.53 fixed for VideoGen
(invented \`seedance/2.0-pro\`) — illustrative examples become
self-fulfilling tool calls.

Fix:

- \`src/agent/context.ts:207\` — replaced the fictional examples
  with frontier names that actually appear on the gateway:
  \`anthropic/claude-sonnet-4.6\`, \`anthropic/claude-opus-4.7\`,
  \`deepseek/deepseek-v4-pro\`, \`zai/glm-5.1\`,
  \`nvidia/qwen3-coder-480b\`, \`openai/gpt-5-nano\`. Marked "as
  of 2026-05" so the next ship round can re-evaluate.
- Added an explicit "Do NOT invent versions like
  \`openai/gpt-5.1\` or \`xai/grok-5\`" warning so the names
  surface as anti-patterns the agent should recognize and avoid
  if it sees them anywhere in the conversation history.
- Reinforces the existing "fetch \`GET /v1/models\` first when
  in doubt" instruction.

One regression test asserts the chat-completions paragraph (a)
contains all six real frontier names AND (b) contains the two
fictional names exactly once each (only in the "Do NOT invent"
warning, never as a positive example).

Tests: 345/345 pass (was 344 before, 1 new).

## 3.15.64 — Agent context reports the SDK-canonical Solana wallet (not a legacy ghost)

⚠ **Critical correctness fix**: pre-3.15.64, the agent's
runtime-wallet block was reporting the **wrong Solana address**
on machines that had both the canonical SDK file and a legacy
migration artifact.

Verified 2026-05-05 on the developer's machine:

\`\`\`
SDK getOrCreateSolanaWallet().address:   Fg57kHX9XzWG6WfisWdQ4zir4i1tJeW3Yo6KjE5AKaH   ← real wallet (.solana-session)
Legacy solana-wallet.json reports:        4DqmoTtvY2GvFRpaMeeEkQ3gt5b1er49R5KkbdwBFzJT   ← derived from .solana-session-key2
\`\`\`

The pre-fix \`readRuntimeWallet\` in \`src/agent/context.ts:690\`
parsed \`~/.blockrun/solana-wallet.json\` (a legacy SDK migration
artifact left over from an old version) and reported its
\`address\` field. But the SDK actually loads
\`~/.blockrun/.solana-session\` for every paid call. The two files
hold **different keys** on machines that went through the
migration mid-session (or that had the panel write a new key
without cleaning the old JSON).

Real consequence: when the user asked the agent
"what's my Solana wallet address" or "where do I send funds",
the agent confidently quoted \`4Dqm…\` (legacy) while the SDK
was signing payments with \`Fg57k…\` (canonical). Funding the
quoted address would have left the x402 path unable to see the
USDC.

Fix:

- \`src/agent/context.ts:readRuntimeWallet\` now reads
  \`~/.blockrun/.solana-session\` first (the SDK-canonical raw
  base58 secret key, mode 600), derives the public address with
  \`Keypair.fromSecretKey(bs58.decode(key))\` — same primitives
  \`tools/jupiter.ts:229\` uses for transaction signing — and
  returns that address. Only falls back to the legacy
  \`solana-wallet.json\` if the canonical file is missing
  (unmigrated installs).
- The prompt-text block (3.15.63's other fix) was already
  updated to name \`.solana-session\` as the private-key file;
  the read path now matches the prompt's claim.
- \`Keypair\` and \`bs58\` already shipped via
  \`@solana/web3.js\` and \`bs58\` deps; static-imported at the
  top of \`context.ts\`.

One regression test (added in 3.15.63's session) already pinned
the prompt text. New behavior verified by running
\`getOrCreateSolanaWallet()\` from a Node REPL against the
user's real \`.blockrun\` and confirming the derived address
matches.

Tests: 344/344 pass (was 343, +1 from the wallet-storage
regression test now passing the tighter assertion).

If you've previously funded a Solana wallet address that the
agent quoted, run \`franklin balance\` and compare to
\`getOrCreateSolanaWallet().address\` — the SDK-active address
is the one to fund. Legacy \`solana-wallet.json\` can be safely
moved to backup once you confirm the SDK is using
\`.solana-session\`.

## 3.15.63 — Chain reader prefers \`payment-chain\` (was reading legacy \`.chain\`)

Verified 2026-05-05 on a real machine: two chain files coexist
in \`~/.blockrun/\`:

\`\`\`
-rw-r--r--  5 Mar 14 20:00  .chain          ← legacy, last touched 2 months ago
-rw-------  5 May  4 17:41  payment-chain   ← canonical, current
\`\`\`

\`src/config.ts:CHAIN_FILE\` writes \`payment-chain\` (the
canonical path; everything else in the codebase reads from
this). But \`src/agent/context.ts:655 readRuntimeWallet()\` was
hardcoded to read the LEGACY \`.chain\`. Same value on this
machine ("base" in both), so the bug was silent — but the two
diverge any time the user runs \`franklin solana\` or flips
chains via the panel UI, both of which write only the
canonical file.

Effect when divergent: agent prompt context reports stale chain
("you're on Base") while the rest of Franklin (proxy,
wallet ops, payment signing) operates on the new chain. The
agent's mental model and the wallet's behavior contradict each
other, leading to confused user-facing messages.

Fix: \`readRuntimeWallet\` now reads \`payment-chain\` first;
falls back to legacy \`.chain\` only if the canonical file is
absent. Both kept readable so users with either file (mid-
migration or fresh install) see consistent behavior.

One regression test asserts the dist source contains both
references AND that \`payment-chain\` is checked before \`.chain\`
in the function body (string-index ordering check on the
compiled file). Future PRs that flip the precedence get
caught.

Tests: 343/343 pass (was 341 before, +2 between this and the
restored-from-HEAD state of test/local.mjs).

## 3.15.62 — Image / Video / Modal tools also measure latency (the other 5 callsites)

3.15.61 fixed the agent-loop \`recordUsage\` callsite. Sweeping
the rest of the codebase turned up **five more** callsites still
hardcoding \`latencyMs = 0\`:

\`\`\`
src/tools/imagegen.ts:453   recordUsage(imageModel, 0, 0, estCost, 0);
src/tools/videogen.ts:352   recordUsage(videoModel, 0, 0, estCost, 0);
src/tools/modal.ts:446      recordUsage(\`modal/\${tier}\`, 0, 0, price, 0);
src/tools/modal.ts:590      recordUsage('modal/exec', 0, 0, EXEC_PRICE_USD, 0);
src/tools/modal.ts:648      recordUsage('modal/status', 0, 0, STATUS_PRICE_USD, 0);
src/tools/modal.ts:708      recordUsage('modal/terminate', 0, 0, TERMINATE_PRICE_USD, 0);
\`\`\`

These are the high-variance paths where latency tracking matters
most:

- VideoGen calls have ranged **40 s to 420 s** in real sessions
  (10× spread). \`avgLat\` would tell the agent / user which
  models are consistently fast vs. slow.
- ImageGen calls range **30 s to 170 s** (Cloud-Run-side queueing).
- Modal sandbox-create can hit a \`90 s\` cold-start vs. \`5 s\`
  warm hit. Without latency, you can't tell.

Fix: same wall-clock pattern as 3.15.61. Each callsite captures
\`callStartedAt = Date.now()\` immediately before its paid HTTP
call, computes \`latencyMs = Date.now() - callStartedAt\` after
the response settles, passes the delta to \`recordUsage\`. For
modal's \`postWithPayment\` helper, the timing wraps the helper
call itself (it's the only network point per action).

After this ship, **every \`recordUsage\` callsite in the
production tree carries real measured latency**:

| File | Site | Status |
|------|------|--------|
| agent/loop.ts:1518 | LLM call | ✓ 3.15.61 |
| proxy/server.ts:658, :708 | Proxy mode | ✓ since v3 |
| tools/imagegen.ts | Image gen | ✓ 3.15.62 |
| tools/videogen.ts | Video gen | ✓ 3.15.62 |
| tools/modal.ts (×4) | Sandbox lifecycle | ✓ 3.15.62 |

One new regression test asserts the three rebuilt files contain
\`callStartedAt = Date.now()\` + \`latencyMs = Date.now() - callStartedAt\`
AND no \`recordUsage(... , 0)\` shape remains. Future PRs that
reintroduce a literal 0 get caught.

Tests: 341/341 pass (was 340 before, 1 new sweep-style test).

Pre-fix entries in \`stats.byModel.totalLatencyMs\` are \`0\` and
stay \`0\`. After upgrade + a few new requests, \`avgLatencyMs\`
will start reflecting the running mean (running mean recovers
slowly from a long tail of zeros — power users may want to
\`/clear-stats\` to wipe and rebuild from clean data).

## 3.15.61 — Agent-loop LLM calls now measure latency (\`avgLat=0.0s\` was lying)

Verified 2026-05-05 on a real machine: \`franklin-stats.json\`
\`byModel\` showed \`avgLat=0.0s\` for every model across **5,300+
requests**:

\`\`\`
anthropic/claude-sonnet-4.6   reqs= 285  $12.04  avgLat=0.0s  fb=0
anthropic/claude-opus-4.7     reqs=  68  $ 3.00  avgLat=0.0s  fb=0
zai/glm-5.1                   reqs=2743  $ 2.74  avgLat=0.0s  fb=0
zai/glm-5                     reqs= 213  $ 1.54  avgLat=0.0s  fb=0
\`\`\`

Same shape as the 3.15.43 fallback-flag bug: the agent-loop's
\`recordUsage\` callsite hardcoded the latency arg to 0, while
the proxy-path's \`recordUsage\` (\`src/proxy/server.ts:651\`)
already measured correctly. Two writers, only one passing the
real value.

\`\`\`ts
// agent/loop.ts (before)
recordUsage(resolvedModel, inputTokens, usage.outputTokens, costEstimate, 0, ...);
//                                                                       ^ latencyMs=0
\`\`\`

The 0 went into \`stats.byModel[m].totalLatencyMs\`,
\`avgLatencyMs = totalLatencyMs / requests\` collapsed to 0
across every model. \`franklin insights\` couldn't surface
"this model is consistently slow", "fallback was faster", or
"timeouts are clustering on a specific provider" — the load-
bearing signal for routing decisions was always zero.

Fix:

- \`src/agent/loop.ts\`: capture \`llmCallStartedAt = Date.now()\`
  immediately before \`client.complete(...)\`, compute
  \`llmLatencyMs = Date.now() - llmCallStartedAt\` after the
  response returns, pass to \`recordUsage\`. Same wall-clock
  shape the proxy path already uses.
- The literal-0 callsite is gone. Future regressions get caught
  by the new test (next bullet).

One new test asserts the \`dist/agent/loop.js\` source contains
\`llmCallStartedAt = Date.now()\`, computes the delta, passes it
to \`recordUsage\`, AND that the legacy
\`recordUsage(... , 0, ...)\` shape is NOT present anymore.

Tests: 340/340 pass (was 339 before, 1 new).

This composes with 3.15.43 (fallback flag also previously
dropped at the same callsite) — both signals now reach
\`franklin-stats.json\` correctly. Pre-fix request counts in
\`stats.history\` are unchanged (latency=0 entries stay), but
new requests after upgrade will start populating real averages
within a few sessions.

## 3.15.60 — Strip inline base64 image bytes from session jsonl (12 MB → small)

Verified 2026-05-05 on a real machine: \`du -h ~/.blockrun/sessions/\`
showed a single session jsonl at **12 MB**. Inspecting line 165
(\`851 KB\` for one message) revealed the cause:

\`\`\`
{"role":"user","content":[{"type":"tool_result","tool_use_id":"...",
 "content":[
   {"type":"text","text":"Image file: /tmp/mamba_hd_p9.png (.png, 622.9KB)..."},
   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo…"}}  // 830 KB
 ]
}]
\`\`\`

The agent loop wraps Read-of-PNG results in
\`tool_result.content = [text, image]\` so vision-capable models can
actually see the image during the live turn (loop.ts:1788). That's
correct for the model-side experience.

The bug: \`streaming-executor.ts:PERSIST_THRESHOLD\` (50 KB) only
checks \`result.output.length\`, never \`result.images\`. A 600 KB
PNG read produces:

- \`result.output\` ≈ 100 chars ("Image file: ... Rendered below…")
  → below threshold → not persisted
- \`result.images[0]\` ≈ 830 KB base64 → bypasses persist entirely
  → flows into \`tool_result.content\` via \`loop.ts:1787\` → lands
  in session jsonl

A 5-turn session with multiple PNG reads grew to 12 MB. \`/resume\`
on such a session reloads the entire jsonl, blowing context budget
and burning input tokens on bytes the model already processed.

Fix:

- New helper \`stripLargeImageData(message)\` in \`src/agent/loop.ts\`,
  exported for testability. Walks a Dialogue, finds
  \`tool_result.content\` blocks containing base64 images larger than
  \`SESSION_IMAGE_STRIP_THRESHOLD\` (50 KB, mirrors PERSIST_THRESHOLD),
  replaces each with a small text placeholder noting the original
  size and pointing the model at the source path.
- \`persistSessionMessage\` (loop.ts:556) now passes the message
  through \`stripLargeImageData\` before \`appendToSession\`.
  Critical: returns a CLONE — the in-memory \`history\` array still
  contains the full image bytes, so the model sees them during the
  rest of the current turn. Only the on-disk jsonl gets the
  placeholder.
- Threshold tuned to 50 KB so favicon-sized icons (~3 KB base64)
  round-trip intact through resume; only screenshots / generated
  artwork (typically 200+ KB base64) get path-stubbed.
- On resume, the placeholder is in the jsonl. If the model needs
  to see the image again it can re-Read from the source path
  (which is preserved in the accompanying text block).

3 new tests:

1. **Strip path**: 200 KB base64 image → out is a clone, original
   intact, output's image block replaced with a sized text
   placeholder.
2. **Threshold**: 3 KB image (favicon-sized) passes through
   unchanged.
3. **No-op shapes**: plain-string user message and tool_result
   without images both round-trip identically (same reference).

Tests: 339/339 pass (was 336 before, 3 new).

Effective immediately: new sessions stay slim. The existing 12 MB
session is unchanged — pre-fix data on disk doesn't retroactively
strip. Users who care can manually \`rm\` old session jsonls;
\`pruneOldSessions\` will clean the rest under its 20-session cap.

## 3.15.59 — VideoGen aspect_ratio + platform / moderation hints

Verified 2026-05-04 in a live session two friction points:

1. User: *"i cannot update to x.com because The aspect ratio of
   the video you tried to upload was too small"* — agent had to
   manually \`ffmpeg -vf scale=1280:720 …\` post-process. VideoGen
   had no aspect-ratio handle of any kind.
2. Earlier the same session, \`bytedance/seedance-2.0\` rejected
   the keyframe with \`InputImageSensitiveContentDetected.PrivacyInformation\`
   ("the input image may contain real person"), forcing a switch
   to \`xai/grok-imagine-video\`. Agent didn't know upfront which
   models have stricter moderation — discovered it by burning a
   submit round-trip.

Both are about the agent lacking advance knowledge to make the
right call the first time.

Fix:

- New optional \`aspect_ratio\` parameter on VideoGen. Passes
  through to the gateway body (models that don't support it
  ignore it; gateway 400 on unknown values surfaces via 3.15.45
  diagnostic).
- Tool description gains a **PLATFORM TARGETING** section:
  > when the user says they'll post to X / Twitter, set
  > aspect_ratio: '16:9' AND plan a follow-up
  > \`ffmpeg -vf scale=1280:720\` step — X rejects videos under
  > 720p with 'aspect ratio too small'. TikTok / Reels / Shorts:
  > '9:16'. Instagram Square: '1:1'.
- Tool description gains a **MODERATION** note:
  > bytedance/seedance-* refuses photorealistic human faces
  > (InputImageSensitiveContentDetected.PrivacyInformation);
  > when the seed image has a real-looking person, use
  > xai/grok-imagine-video instead, or regenerate the keyframe
  > in a more stylized style first.
- Per-parameter description for \`aspect_ratio\` lists common
  values + their target platforms.

Two new tests:

1. **Passthrough**: invoking \`videoGenCapability.execute\` with
   \`aspect_ratio: '16:9'\` and intercepting fetch asserts the
   request body's \`aspect_ratio\` field round-trips.
2. **Description content**: tool spec carries 16:9, 9:16, X /
   Twitter mention, and the seedance-moderation warning.

Tests: 336/336 pass (was 334 before, 2 new).

Note this is documentation-driven. The agent already does the
right things end-to-end (it figured out ffmpeg by itself, it
switched to grok after Seedance refused). The fix lets it skip
the discovery cost — get to the working answer on the first
attempt instead of the third, saving ~$0.42 + 60s per skipped
retry.

## 3.15.58 — \`franklin content list / show\` — agent stops estimating spend from memory

Verified 2026-05-04 in a live session: user asked "how much did I spend on this?"
after a creative-content burst (3 keyframes + 3 videos through
ImageGen + VideoGen). The agent's response:

\`\`\`
TU[Bash({"command": "franklin content list 2>/dev/null || echo \"no content subcommand\""})]
TR(err=False, "no content subcommand\n")
\`\`\`

Then the agent reconstructed the spend from memory:

> Two creative passes: v1 $0.46 + v2 $0.92 = $1.38 / $2.00 budget

The exact data was already on disk at \`~/.blockrun/content.json\`,
written by the \`ContentCreate\` and \`ContentAddAsset\` capabilities
during the session. The agent just had no CLI to query it without
parsing JSON by hand.

Fix: new \`src/commands/content.ts\` exposing two read-only
subcommands.

\`\`\`
$ franklin content list
id        type      status      spent/cap      assets  title
a83d382b  video     outline     $1.38/$2.00    6       Franklin & Claude Robot Scene
0575abb7  video     outline     $0.00/$2.00    1       Franklin-Claude Handoff (Pixar-Style Sh…
8baaf1b0  video     outline     $0.40/$3.00    1       ClawRouter 30s Promo

Total: $1.78 spent across 3 contents (cap $7.00).
\`\`\`

\`\`\`
$ franklin content show a83d382b
# Franklin & Claude Robot Scene
id:        a83d382b-17ee-42cc-a4a9-3302569fedd1
type:      video
status:    outline
spent:     $1.38 / $2.00 cap
created:   2026-05-04T23:45:44.776Z

## Assets (6)
- image    $0.04  openai/gpt-image-2
    /Users/vickyfu/Documents/blockrun-analytics/franklin-claude-keyframe.png
- video    $0.42  xai/grok-imagine-video
    /Users/vickyfu/Documents/blockrun-analytics/franklin-claude-video.mp4
…
\`\`\`

\`show\` accepts a full id, an id prefix (≥4 chars), or a
case-insensitive title substring. Ambiguous matches list the
candidates so the user can disambiguate without rerunning blind.
\`list\` prints a footer with the rolled-up total spend across all
records.

Implementation:

- \`src/commands/content.ts\` — new file. Imports \`loadLibrary\`
  from \`src/content/store.ts\`, walks \`lib.list()\`. Pure read,
  no mutation, no network. Reads from \`~/.blockrun/content.json\`
  (the path \`tools/index.ts\` already uses).
- \`src/index.ts\` — registers \`buildContentCommand()\` next to
  \`buildTaskCommand()\`.
- 2 new tests use \`spawnSync\` against \`dist/index.js\` with a
  fixture \`content.json\` in a temp \`HOME\`. \`list\` test
  asserts the summary row + total footer; \`show\` test asserts
  that an 8-char prefix resolves cleanly and the assets +
  distribution sections render.

Now when the agent sees a "how much did I spend" question, it
can shell out to the authoritative answer instead of summarizing
from conversation memory.

Tests: 334/334 pass (was 332 before, 2 new).

## 3.15.57 — Honor upstream \`Retry-After\` on 429 + actionable Tip when free fallback exhausted

Last of the four screenshot-driven fixes. Verified 2026-05-04
session ended with:

\`\`\`
[Error: API error: 429 {"status":429,"title":"Too Many Requests"}]
Session ended. Reopen the side bar to start again.
\`\`\`

Two distinct issues compounded:

**Issue A — Retry-After ignored.** When a 429 fired, the loop's
exponential backoff (~1.5 s for the first retry) was used even
when the upstream sent a \`Retry-After: 30\` header explicitly
asking for a longer wait. The retry hit 429 again, burned the
\`maxRetries: 1\` budget, and fell into the rate-limit-fallback
branch. The window the upstream actually gave us was wasted.

**Issue B — Unrecoverable Tip wasn't actionable.** When
\`pickFreeFallback\` returned null (every free model in
\`turnFailedModels\`), the unrecoverable error read just
\`[RateLimit] API error: 429 ...\` with the classifier's generic
"Try /model to switch" suggestion. The user had a funded wallet
($94.72 in the live session) and could absolutely afford a
paid model — but no signal pointed there.

Fix:

- \`src/agent/llm.ts:565\` — when \`response.status === 429\`,
  read the \`Retry-After\` header. If a positive integer ≤ 600 s,
  append \`[retry-after-ms=\${seconds * 1000}]\` to the error
  message string. (HTTP-date format is intentionally not
  honored — clock-skew between gateway and client makes it
  unreliable; integer-seconds Retry-After is what 99% of
  gateways send.)
- \`src/agent/error-classifier.ts\` —
  - \`AgentErrorInfo\` gains \`retryAfterMs?: number\`.
  - Classifier extracts the \`[retry-after-ms=N]\` tag with a
    regex; clamps to \`(0, 600000]\`; surfaces on rate_limit
    results.
- \`src/agent/loop.ts\` transient-retry block (line ~1284):
  when \`classified.retryAfterMs ≤ 30 s\`, use it as the
  backoff in place of \`getBackoffDelay()\`. Anything > 30 s
  falls through to the existing free-model fallback (the
  agent shouldn't feel frozen, and a long Retry-After is the
  upstream's way of saying "try someone else"). Log line
  appends \`(upstream Retry-After)\` so it's visible in
  \`franklin-debug.log\` why the wait was longer than usual.
- \`src/agent/loop.ts\` unrecoverable branch (line ~1372):
  when \`category === 'rate_limit'\` AND \`turnFailedModels\`
  is non-empty (we got here because we tried free models and
  exhausted them), the Tip is rewritten:

  > Tip: All free models tried this turn are rate-limited.
  > Switch to a paid model with /model anthropic/claude-sonnet-4.6
  > (or any other paid model) and retry — your wallet handles
  > it. Or wait ~60s and /retry the same turn.

  Concrete, actionable. Names a specific paid model + the slash
  command. Tells the user the wallet is the way out, not a dead
  end.

Note: the "Session ended. Reopen the side bar" message in the
screenshot is from the host UI (Claude Desktop side panel), not
Franklin. Out of scope. The Franklin-side fix here is to NOT
bubble up an unrecoverable error in the first place — most 429s
on Anthropic clear within 30s, and the new path waits them out.

Four new tests:

1. Classifier extracts \`retry-after-ms\` tag from rate_limit
   messages.
2. Classifier ignores absurd values (\`>10 min\` clamp test).
3. Rate-limit without the tag has \`retryAfterMs: undefined\`
   (regression guard for the legacy path).
4. \`streamCompletion\`: a 429 response with
   \`Retry-After: 12\` header round-trips the tag in the error
   payload (full integration through llm.ts).

Tests: 332/332 pass (was 328 before, 4 net new).

This closes the four-bug arc opened by the 2026-05-04 20:14
screenshot. Bug 1 (TON) → 3.15.54. Bug 4 (switch message) →
3.15.55. Bug 2 (payment_rejected) → 3.15.56. Bug 3 (429 +
actionable Tip) → 3.15.57.

## 3.15.56 — Distinguish \`Payment verification failed\` from \`payment required\`

Verified 2026-05-04 in a screenshot: ExaSearch returned

\`\`\`
(402): {"error":"Payment verification failed","details":"Ver…
\`\`\`

Same HTTP status as a routine 402 challenge ("please sign and
retry") but the remedy is opposite. The user's signed payment
was already accepted by the gateway socket — and then rejected
during cryptographic verification. Re-presenting the same
signature won't help. Common causes: clock skew (signature
timestamp out of acceptable window), wrong chain (signature on
Base for a Solana endpoint or vice versa), replay-nonce reuse,
or wallet/signature mismatch.

Pre-fix the classifier (\`src/agent/error-classifier.ts:39-50\`)
matched both phrases (\`payment\`, \`verification failed\`) into
the same \`'payment'\` category with a generic
"check funds + try /model free" suggestion. The agent had no
way to tell the user the actual remedy.

Fix:

- New category \`payment_rejected\` (label \`PaymentRejected\`)
  in \`AgentErrorCategory\`. Classified BEFORE the generic
  \`payment\` branch since the body usually contains both
  phrases.
- Trigger phrases: \`verification failed\`, \`payment verification\`,
  \`signature mismatch\`, \`invalid payment signature\`,
  \`invalid x-payment\`, \`nonce reuse\`, \`replay protection\`.
- Suggestion calls out the three actual fixes — clock skew,
  chain selection, stale nonce — and offers \`/model free\` as
  the escape hatch.
- \`maxRetries: 0\`. The whole point: a stale signature stays
  stale; auto-retrying the same x-payment header burns more
  rejections.
- \`src/agent/loop.ts:1305\` payment-fallback branch now
  triggers on either \`payment\` OR \`payment_rejected\`. Same
  free-model fallback flow; the user-facing suggestion text
  guides them to the right fix.

This composes with 3.15.55: the model-switch message now
reads:

\`\`\`
*blockrun/auto (anthropic/claude-sonnet-4.6) failed [PaymentRejected] — switching to nvidia/qwen3-coder-480b*
\`\`\`

— so the user sees the concrete model, the rejection reason,
and the next model in one line.

Two new tests + one updated:

- Updated existing classifier test to disambiguate
  \`'insufficient balance'\` (payment_required) from
  \`'Payment verification failed'\` (payment_rejected).
- New test pins the gateway-shape body → \`payment_rejected\`,
  \`maxRetries: 0\`, suggestion mentions clock skew + chain +
  /model free.
- New test covers four variant phrasings (signature mismatch,
  invalid x-payment, nonce reuse).

Tests: 328/328 pass (was 327 before, 1 net new).

## 3.15.55 — Model-switch messages now show the resolved model + reason

Verified 2026-05-04 from a screenshot:

\`\`\`
*Auto → anthropic/claude-sonnet-4.6*
…
*blockrun/auto failed — switching to nvidia/qwen3-coder-480b*
\`\`\`

The first line correctly resolved \`Auto\` → claude-sonnet-4.6.
Two messages later, the agent reported \`blockrun/auto failed\`
with no hint of which concrete model actually failed and no
hint of why (was it a payment rejection? a 5xx storm? a 429
quota cap?). The user couldn't form a mental model of what
went wrong; the agent itself lost the signal needed to choose
its next action.

Source: \`src/agent/loop.ts:1119, :1302, :1328\` built the
switching message as \`\${oldModel} <reason> — switching to \${nextModel}\`,
where \`oldModel = config.model\`. \`config.model\` is the
user-facing alias (\`blockrun/auto\`), not the concrete resolved
model (\`anthropic/claude-sonnet-4.6\`). Line 1254 already used
\`resolvedModel\` correctly; the other three sites didn't.
Reason labels were also free-form and inconsistent — "failed"
vs "rate-limited" vs "returned empty" — with no classifier
label attached.

Fix:

- New helper \`formatModelSwitch(alias, resolved, reason, newModel)\`
  in \`src/agent/loop.ts\`. When \`alias !== resolved\`, returns
  \`alias (resolved) reason — switching to newModel\`. When
  they match, returns the simple form. Single source of truth
  for the message shape; future call sites get consistency for
  free.
- All three sites that lacked the resolved model now route
  through the helper:
  - **Empty-response path** (\`*X returned empty*\`): now shows
    \`blockrun/auto (claude-sonnet-4.6) returned empty — switching to ...\`.
  - **Payment-failure path** (\`*X failed*\`): adds the classifier
    label, e.g. \`failed [payment_required]\` or
    \`failed [payment_rejected]\` — pairs nicely with the bug-2
    classifier extension shipping next.
  - **Rate-limit path** (\`*X rate-limited*\`): same enrichment.
- Line 1254 (5xx-streak path) was already correct (used
  \`resolvedModel\` directly); left unchanged.

After the fix the screenshot's second line reads:

\`\`\`
*blockrun/auto (anthropic/claude-sonnet-4.6) failed [payment_required] — switching to nvidia/qwen3-coder-480b*
\`\`\`

Tests: 327/327 pass (was 326 before, 1 new shape-check case
that asserts the helper definition + reason labels appear in
\`dist/agent/loop.js\`).

## 3.15.54 — TradingMarket finds TON (and any other unknown ticker via CoinGecko /search)

Verified 2026-05-04 in a live side-panel session: user asked
"analyze the TON token", TradingMarket returned:

\`\`\`
Error: No CoinGecko data for TON
\`\`\`

Root cause: \`src/trading/providers/coingecko/client.ts:19-27\`
declared a static \`TICKER_TO_ID\` map of ~30 tokens. TON was
missing, so \`resolveProviderId('TON')\` fell through to
\`'ton'\` — but CoinGecko's actual id is \`the-open-network\`.
\`/simple/price?ids=ton\` returned \`{}\`, \`transformData\` saw
no entry for the resolved id, and emitted "No CoinGecko data
for TON". Same hole exists for HYPE, TRX, TAO, WLD, ENA, BERA,
JUP, FET, ONDO, USDT, USDC, and dozens more whose symbol differs
from their slug.

Two-layer fix:

- **Static expansion** of \`TICKER_TO_ID\` with the top ~30
  currently-missing tokens (TON, HYPE, TRX, TAO, WLD, ENA, BERA,
  JUP, FET, ONDO, RNDR, USDT, USDC, DAI, BCH, ETC, XLM, XMR,
  IMX, GRT, SAND, MANA, AXS, KAS, ICP, HBAR, VET, ALGO, FTM,
  EGLD, CRV, LDO, SHIB, BONK, POPCAT, FLOKI, PNUT). Cheap,
  immediate.
- **Dynamic resolver** \`resolveProviderIdAsync\`: on a static-map
  miss, hits CoinGecko's \`/search?query=TICKER\` to find the
  canonical id, prefers an exact symbol match, falls back to
  the highest market-cap-ranked result. Caches resolved ids for
  7 days in a Map; sync \`resolveProviderId\` reads the same
  cache so \`transformData\` stays synchronous. \`/search\`
  failure falls through to the lowercase guess (no
  hard-failure).
- \`price.ts\` and \`ohlcv.ts\` \`fetchData\` now \`await
  resolveProviderIdAsync(ticker)\` to warm the cache before
  \`transformData\` does its sync read. Future tokens
  self-resolve without code edits.

Three new tests:

1. **Static path**: TON / HYPE / TRX / USDT resolve correctly
   from the static map alone.
2. **Dynamic path with cache**: unknown ticker triggers
   \`/search\`, picks exact symbol match, caches; second call
   hits cache (no second \`/search\` network request); sync
   \`resolveProviderId\` reads the cached id.
3. **Network-failure resilience**: \`/search\` returns 500 →
   resolver falls through to lowercase, doesn't block the
   request.

Tests: 326/326 pass (was 323 before, 3 new).

## 3.15.53 — VideoGen tool-spec lists known-valid model names (agent stops guessing)

Verified 2026-05-04 in a live session: agent referenced
\"Seedance Pro\" from the user's chat, then called VideoGen with
\`model: "seedance/2.0-pro"\` — a name that doesn't exist on the
gateway. Result:

\`\`\`
Video submit failed (400):
  Unknown video model: seedance/2.0-pro.
  Available models: xai/grok-imagine-video, bytedance/seedance-1.5-pro,
                    bytedance/seedance-2.0-fast, bytedance/seedance-2.0
\`\`\`

The agent then guessed \`bytedance/seedance-2.0\` (right name)
on the second try. Cost: one wasted submit round-trip plus
the user-visible failure. The gateway already includes the
canonical list in the 400 body — Franklin can just pre-advertise
it in the tool spec so the agent never has to fail-then-discover.

Source: \`src/tools/videogen.ts:558\` had only
\`description: 'Video model. Default: xai/grok-imagine-video'\`.
Nothing about which other names the gateway accepts. Agents that
heard a model name in plain English (\"Seedance Pro\", \"Grok
Imagine\") had no way to map it to the canonical id.

Fix:

- Tool description for \`model\` now enumerates the four known
  names with a phonetic-mapping hint:
  > Pick from this list; the gateway rejects unknown names with
  > HTTP 400 (no money charged on rejection). Speak \"Seedance
  > Pro\" → bytedance/seedance-2.0; speak \"Seedance fast\" →
  > bytedance/seedance-2.0-fast.
- Marked \"as of 2026-05\" so the next ship round can
  re-evaluate. The list won't go stale silently — if the gateway
  changes, the live 400 still surfaces the truth.
- New regression test asserts all four names are in the
  description string. Future edits can't silently drop one.

Why hardcode rather than \`getModelsByCategory('video')\` at boot:
the tool spec is built once, statically, before the agent starts
its first turn. A network fetch there couples cold-start to
gateway availability; a stale-by-a-week static list is a far
better tradeoff than \"no description because gateway timed out
during init\".

Tests: 323/323 pass (was 322 before, 1 new spec-coverage case).

## 3.15.52 — VideoGen accepts local file paths for \`image_url\` (auto-inlines as data URI)

Verified 2026-05-04 in a live session: the agent generated a
keyframe with ImageGen, saved it locally, then called VideoGen
with \`image_url: "/Users/.../franklin-claude-handoff-keyframe.png"\`.
Gateway returned:

\`\`\`
400 Invalid request body
{"code":"invalid_format","format":"url","path":["image_url"],"message":"Invalid URL"}
\`\`\`

The agent figured it out — *"Reference image needs to be a URL,
not a local path. Trying with prompt only"* — and burned a
follow-up generation that lost the keyframe entirely. The whole
chain (generate keyframe → use as seed for video) collapsed
because the two tools have different conventions: ImageGen's
\`image_url\` parameter goes through \`resolveReferenceImage\`
(local path → base64 data URI; http(s) → fetched + inlined;
data: URI → pass-through), but VideoGen passed the value
straight through to the gateway.

Fix:

- \`src/tools/videogen.ts\`: imports \`resolveReferenceImage\`
  from \`./imagegen.js\` and runs it on \`image_url\` before
  serializing the body. Same contract across both tools — local
  paths just work.
- Tool-spec description for \`image_url\` updated to advertise
  the supported formats explicitly: http(s) URL, \`data:\` URI,
  or local file path.
- On resolution failure (oversized file, bad MIME, missing
  path) the error is surfaced clearly *before* the gateway
  call, so the user/agent doesn't lose a paid retry to a
  resolvable client-side mistake.
- Added test in \`test/local.mjs\`: writes a 1×1 PNG to tmp,
  invokes \`videoGenCapability.execute\` with the local path as
  \`image_url\`, intercepts \`fetch\`, asserts the request body
  carries a \`data:image/png;base64,...\` URI rather than the
  raw filesystem path.

Tests: 322/322 pass (was 321 before, 1 new videogen case).

## 3.15.51 — Runtime retry for \`tool_choice\` rejection by gateway-aliased reasoner backends

3.15.36 added a static allowlist (\`MODELS_WITHOUT_TOOL_CHOICE_SUBSTR\`)
that strips \`tool_choice\` preemptively for models whose names
contain \`deepseek-reasoner\`, \`openai/o1\`, or \`openai/o3\` —
these models reject the field outright. That fixed the case
where the agent loop targets a known restricted model directly.

It missed the case where the BlockRun gateway internally aliases
a different model name to a reasoner backend. Verified 2026-05-04
in a live session: a request for \`deepseek/deepseek-v4-pro\`
returned:

\`\`\`
HTTP 400: Invalid request: 400 deepseek-reasoner does not support this tool_choice
\`\`\`

The gateway routed v4-pro to a deepseek-reasoner upstream;
Franklin's allowlist couldn't have known that since it checks
\`request.model\` literally. The static-name approach is
fundamentally limited — the gateway is free to re-alias any
model at any time without telling the client.

Effect: the grounding-retry path forces \`tool_choice: { type: 'any' }\`
to make the model call WebSearch instead of fabricating
citations. When the gateway then routes that retry to a
reasoner upstream, the whole turn fails with the 400 above and
the user sees the unhelpful tip \"Try /model to switch.\" Pure
client-side limitation; nothing the user can do.

Fix: runtime retry inside \`ModelClient.streamCompletion\`. When
the response is HTTP 400 and the error body contains both
\`tool_choice\` and one of \`not support\` / \`unsupported\` /
\`does not support\`, AND the request payload had \`tool_choice\`
set, the client deletes \`tool_choice\` from the payload and
re-fires once. Re-handles 402 if the gateway demands payment
again on the retry. Static allowlist still runs first as a
preemptive optimization (no wasted round-trip when we know the
model is restricted).

Two new tests in \`test/local.mjs\` use global-fetch interception
to verify:

1. **Positive:** request with \`tool_choice: { type: 'any' }\`
   gets the tool_choice 400, retries with no \`tool_choice\` in
   the second body.
2. **Negative:** request without \`tool_choice\` that hits a
   different 400 doesn't retry — only one fetch call, no
   infinite loop on unrelated errors.

Tests: 321/321 pass (was 319 before, 2 new streamCompletion
retry cases).

## 3.15.50 — Typing \"1\" to a numbered AskUser dialog no longer silently cancels

Live session 2026-05-04:

\`\`\`
Do you want:
1. Generate directly with my VideoGen tool (about \$0.42, 8 seconds), or
2. Take this image to Seedance Pro yourself?
❯ 1
...video generation was canceled (no charge).
❯ 1
...video generation was canceled again.
\`\`\`

Wallet had **\$94.72**. Content budget had **\$2.00 untouched**.
User clearly picked option 1 twice. Both VideoGen invocations
returned "Video generation cancelled. No USDC was spent" anyway.

Source: a contract mismatch between the two halves of the
AskUser flow.

- **TUI** (\`src/ui/app.tsx\`) renders option labels as a numbered
  list — \`{i + 1}. {opt}\` — which invites users to type the
  number.
- **Tool-side callers** (\`src/tools/videogen.ts:113\`,
  \`modal.ts:371\`, \`jupiter.ts:368\`, \`zerox-base.ts:453\`,
  \`zerox-gasless.ts:446\`) all do an exact-string match against
  the full label (e.g. \`options.find(o => o.label === answer)\`).
- \`"1"\` never matches \`"Use recommended (xai/grok-imagine-video, \$0.42)"\`,
  so the find returns undefined, the optional-chain
  \`?? { id: 'cancel' }\` fires, and the call returns the cancel
  branch — silently. No error, no warning, no "answer not
  recognized." Just a charge-free nop that looks identical to
  a deliberate user cancellation.

Five tools all hit this; videogen was the loudest because
video gen is the most expensive thing the agent ever asks
about.

Fix:

- **New helper** \`src/ui/ask-user-answer.ts\` exporting
  \`resolveAskUserAnswer(raw, options)\`. If the user types a
  bare digit \`N\` and \`1 ≤ N ≤ options.length\`, returns
  \`options[N-1]\` (the full label). Otherwise returns the trimmed
  input, preserving the existing \`"(no response)"\` empty-input
  fallback.
- **\`src/ui/app.tsx\`** AskUser \`onSubmit\` now delegates to the
  helper instead of passing the raw input through. All five
  tool-side onAskUser callers benefit transparently — no
  per-tool change needed.
- **4 new tests** in \`test/local.mjs\`: digit→label translation,
  out-of-range pass-through, empty-input fallback, free-form
  text and undefined/empty options pass-through. Pin the
  contract so a future TUI rewrite can't silently re-introduce
  the bug.

Tests: 319/319 pass (was 315 before, 4 new resolveAskUserAnswer
cases).

## 3.15.49 — Pin the 3.15.48 async-poll contract with real tests + correct 3.15.48's framing

3.15.48 added HTTP 202 polling to \`imagegen.ts\` based on
gateway-side Cloud Run logs that showed five \"failed\"
ImageGen calls had actually returned 202 queued. Gateway-side
follow-up by the operator the same evening corrected the
framing:

| Job       | Model       | GCS state                        | Duration |
|-----------|-------------|----------------------------------|----------|
| 3f16562e  | gpt-image-2 | ✅ completed (~2 MB image)       | 53 s     |
| b465733d  | gpt-image-1 | ✅ completed (~2 MB image)       | 41 s     |
| f872d2fb  | gpt-image-2 | ❌ Request timed out (180 s)     | 180 s    |
| 805e2a13  | gpt-image-1 | ✅ completed (~2 MB image)       | 56 s     |
| 18fc77f0  | gpt-image-1 | ✅ completed (~2 MB image)       | 43 s     |

So **4 of 5** jobs actually completed gateway-side; their image
files were sitting in GCS the whole time. Franklin's "5 fails"
report was a client-side misread of HTTP 202 — the gateway
itself was healthy. Only the gpt-image-2 high-res run hit a
real (upstream OpenAI 180 s) timeout.

The error string \`No image data returned from API\` is also
purely Franklin-side (\`src/tools/imagegen.ts:339\`); the
gateway has its own — \`No image data returned from OpenAI\` in
\`ai-providers.ts\` and \`No image URL in response\` in the
MCP wrapper. Earlier round mistakenly attributed the string to
gateway output.

3.15.49 doesn't change the 3.15.48 fix logic — it formalizes it:

- **Extracted helper:** \`pollImageJob(pollEndpoint, headers, signal, options?)\`
  exported from \`src/tools/imagegen.ts\`. The 202 branch in
  the main \`execute\` flow now delegates to this helper instead
  of an inline loop. Same contract — sleep + retry on 202 / 429 /
  5xx, surface \`failed\` upstream errors, return \`timed_out\`
  on deadline, return \`poll_http_error\` for non-transient 4xx.
- **5 new tests** in \`test/local.mjs\` that spin up a real
  \`http\` server and exercise: completes-after-queued, upstream
  fail, deadline timeout, transient 5xx recovery, non-transient
  4xx error surfacing. Critical async path now has zero-network
  unit coverage so future regressions get caught before they
  silently start dropping image jobs.

Tests: 315/315 pass (was 310 before, 5 new pollImageJob cases).

## 3.15.48 — ImageGen handles HTTP 202 (queued) — was burning paid retries on async jobs

Real diagnostic from gateway-side Cloud Run logs (verified
2026-05-04 by direct gateway probe): five back-to-back ImageGen
calls that Franklin reported as \"No image data returned from API\"
were actually **HTTP 202 (Accepted, queued)** responses. The
gateway settled payment when accepting each job and started the
upstream model asynchronously, because gpt-image-1 / gpt-image-2
routinely exceed the inline 30s budget for large images.

Effect: the user paid USDC for every "failed" attempt while the
images were still being generated server-side, and the agent —
seeing only "No image data returned" — tried again and again
with the same prompt, until \`signature-loop\` hard-stopped.
Whatever the gateway eventually produced was unreachable from
Franklin.

Source: \`src/tools/imagegen.ts\` was strictly inline. After the
402-payment retry it called \`response.json()\` and read
\`result.data?.[0]\`. For a 202 response, body shape is
\`{ poll_url, id, status: 'queued' }\` — no \`data\` field — so
the code emitted the misleading "No image data" string. Meanwhile
\`videogen.ts\` had full async polling support since v3 (line
399's \`pollUntilReady\`) — image-side just never grew the same
contract.

Fix:

- \`src/tools/imagegen.ts\`: lifted \`paymentHeaders\` out of the
  402 block so the polling path can re-present the same signed
  authorization on each poll (gateway settles on first completed
  poll — same contract as videogen).
- New 202 branch detects \`response.status === 202 && result.poll_url\`,
  resolves the poll URL (relative or absolute), and polls every
  3 s for up to 5 min. Replaces the original POST controller
  timeout because the inline 60s no longer applies once we're
  in async mode.
- Treats poll responses the same shape the gateway already uses
  for video (\`status: 'queued' | 'completed' | 'failed'\`,
  \`data: [...]\`, \`error: ...\`). On completion, falls through
  to the existing inline path that decodes b64_json / data: URI
  / remote URL — no duplicated save logic.
- On 5-min timeout: clear message that payment was settled when
  the gateway accepted (HTTP 202), so the user knows they paid
  even though no file landed locally. Recommends a smaller /
  faster model.
- Inline (200 + data) path is unchanged — the vast majority of
  text-to-image requests still complete within 30s and skip
  the polling branch entirely.

This also benefits 3.15.45's diagnostic-string fix: previously
the no-imageData branch surfaced \`error\` / \`message\` from the
body to help diagnose why a generation failed; now most of those
"failures" are actually completed jobs the agent can collect.

Tests: 310/310 pass.

## 3.15.47 — \`franklin task tail\` stops printing the same log twice (squashed)

Verified 2026-05-04 on a real failed ETL task: \`franklin task
tail t_morq82l7_0c9184a1\` printed the full log nicely (multiple
indented lines), then a status header \`--- failed ---\`, then
**the same log content all over again as one squashed line**:

\`\`\`
[17:43:40] resume state: ...
[17:43:40] manifest cached: ...
...
[17:59:57]   2026-02 batch 2 ...

--- failed ---
[17:43:40] resume state: ... [17:43:40] manifest cached: ... [17:43:40] 2026-02: 685349 files [17:51:36] 2026-02 batch 1 ...
\`\`\`

Source: \`src/tasks/runner.ts:42\` collapses the log tail with
\`replace(/\\s+/g, ' ')\` and stores it as the task's
\`terminalSummary\`. Then \`src/commands/task.ts:91\` printed
\`terminalSummary\` after the log — redundant content,
whitespace-collapsed, in a worse format than the log we just
showed.

The collapse-to-one-line is the right shape for the HTML panel
(\`src/panel/html.ts:1386\` renders it inside a single \`<span>\`,
where browsers collapse whitespace anyway). It's the wrong shape
for the CLI, which has just printed the full log directly above.

Fix:

- \`src/commands/task.ts\` \`tail\` action no longer prints
  \`terminalSummary\` after the log + status header. The log was
  already shown via \`printNew()\`. Print \`exitCode\` instead —
  the only useful field that the log doesn't record explicitly.
- HTML panel still uses \`terminalSummary\` exactly as before.
- \`task wait\` still uses \`terminalSummary\` (one-line outcome
  blurb is the right shape there since it's the only output).
- Updated the cli-tail test: it had been asserting the duplicate
  print as expected output. Now asserts the new contract
  (\`assert.doesNotMatch(out, /all good/)\`).

After the fix the same task shows:

\`\`\`
[17:43:40] resume state: ...
[17:43:40] manifest cached: ...
[17:43:40] 2026-02: 685349 files
[17:51:36]   2026-02 batch 1 ...
[17:59:57]   2026-02 batch 2 ...

--- failed ---
exitCode: 128
\`\`\`

Tests: 310/310 pass.

## 3.15.46 — \`franklin task list\` shows running tasks' real elapsed time, not \"0s\"

Verified 2026-05-04 on a real machine: \`franklin task list\` for
a running ETL job that had been chewing through 685k GCS files
for 13 minutes displayed:

\`\`\`
t_morrbsvn_667517d7  running        0s  ETL v3 - no capture_output
\`\`\`

\"0s\" was useless signal — the user couldn't tell whether the
task had just spawned or had been grinding for hours. Worse, it
made \"running\" look indistinguishable from \"already
finished, just confirmed\".

Source: \`src/commands/task.ts:41\` computed age as
\`now - (t.lastEventAt ?? t.createdAt)\`, but the runner emits a
heartbeat every 5s (\`tasks/runner.ts:86\`) that just refreshes
\`lastEventAt\` so observers see \"still going\". For a running
task that means \`lastEventAt ≈ now\` always, so age ≈ 0.

Two distinct semantics had been collapsed into one column:

- For a **running** task, \"age\" means \"how long has this been
  going\" → should reference \`startedAt\`.
- For a **terminal** task, \"age\" means \"how recently did this
  end\" → should reference \`endedAt\` (or \`lastEventAt\`, which
  finalize() sets to endedAt).

Fix:

- \`src/commands/task.ts\` \`list\` action now branches on
  \`isTerminalTaskStatus(t.status)\` to pick the right reference
  timestamp. Running → \`startedAt ?? createdAt\`. Terminal →
  \`endedAt ?? lastEventAt ?? createdAt\`. Same single \"age\"
  column, but each row now answers the question the column
  actually means for that row.

After the fix the same machine shows:

\`\`\`
t_morrbsvn_667517d7  running       14m  ETL v3 - no capture_output
t_morr21tl_6aa34dc3  failed        15m  ETL v2 - 500 files/batch
\`\`\`

Running task age now matches the user's intuition. Terminal
rows are unchanged.

Tests: 310/310 pass.

## 3.15.45 — ImageGen / VideoGen surface the actual reason a generation failed

Verified 2026-05-04 in a live session: the user asked the agent
to generate a video, the agent kicked off ImageGen for the
storyboard frame, and got back a single sentence:

\`\`\`
No image data returned from API
\`\`\`

The agent then guessed: *"gpt-image-2 is forced to 1024x1024
per the tool docs. Retrying with that size."* — and burned a
retry on a size hypothesis that wasn't the real cause. The
gateway response body almost certainly contained an \`error\` or
\`message\` field (gateways return 200 with such fields for
moderation, quota, or upstream-model failures rather than an
HTTP error code), but \`tools/imagegen.ts\` was throwing the
body away and emitting a hardcoded string.

Effect: every ImageGen / VideoGen failure mode looked the
same to the agent, so it would either retry blindly or give
up. Each retry costs USDC. \`No image data returned\` told the
user / agent nothing about whether to lower resolution, reword
the prompt, or top up the wallet.

Fix:

- \`src/tools/imagegen.ts:337\` — \`result.data?.[0]\` falsy
  branch now extracts \`error\`, \`message\`, and an empty-data
  hint into the error string. Caps each at 240 chars to keep
  the agent's tool result readable.
- \`src/tools/videogen.ts:239\` — same pattern for the
  \`poll_url\`-missing branch (extends the inline submitResult
  type with \`error?: unknown; message?: unknown\`).
- \`src/tools/videogen.ts:269\` — same pattern for the
  \`videoUrl\`-missing branch on the poll-completion path.

Now a moderation reject reads like:

\`\`\`
No image data returned from API — error={"code":"content_policy_violation","message":"..."}
\`\`\`

instead of the original blank "API returned nothing." The agent
can act on that string directly: stop retrying, surface the
upstream message to the user, or rewrite the prompt.

Tests: 310/310 pass.

## 3.15.44 — Brain stops extracting tool patterns / URIs / task IDs as "entities"

Verified 2026-05-04 on a real machine: \`~/.blockrun/brain/entities.jsonl\`
contained 7 of 44 entries (16%) that were obvious junk:

- \`Bash(git commit:*)\` — a tool-permission shape, type=concept
- \`gs://blockrun-prod-2026-logs/logs/2026/02/**\` — GCS URI + glob
- \`gs://blockrun-prod-2026-logs/logs/2026/05/**\` — same
- \`t_morkaf83_f03a0b10\` — Franklin task runId, tagged as type=project
- \`r/LangChain\`, \`r/LocalLLaMA\`, \`r/AI_Agents\` — Reddit subreddit
  names with vacuous observations like "Has 50-60k members"

Each accumulated 1–3 vacuous observations like \"This is a task ID for an
ETL process.\" or \"Used to save the state of a process.\" — tautological
restatements rather than facts a future session could act on. Worse, the
brain re-loads them as context on the next session, so the noise
compounds across days.

Source: \`src/brain/extract.ts\` only filtered by name length and a
4-element \`VALID_TYPES\` set. The model emits whatever string was
syntactically prominent in the transcript; the prompt's "do NOT extract
generic concepts" guidance wasn't load-bearing without a code-side
backstop.

Fix:

- \`src/brain/store.ts\`: new \`isJunkEntityName(name)\` predicate +
  \`pruneJunkBrainEntries()\` cleanup. Patterns flag the cases observed
  in the wild: tool-permission shape (\`Bash(...)\`, \`Edit(...)\`),
  object URIs (\`gs://\`, \`s3://\`, \`file://\`, \`http(s)://\`), glob
  paths, Franklin task runIds (\`t_<...>_<hex>\`), session ids, and
  bare hex hashes ≥16 chars. Conservative — anything that looks
  programmatic rather than nameable.
- \`src/brain/extract.ts\`: \`parseExtraction()\` filter now drops
  entities whose names match the junk patterns. Tightened the
  \`BRAIN_PROMPT\` with explicit "do NOT extract … tool permission
  patterns, object URIs, glob patterns, task IDs, session IDs, or
  hashes/UUIDs" + an explicit anti-tautology rule on observations.
- \`src/storage/hygiene.ts\`: \`runDataHygiene()\` now also calls
  \`pruneJunkBrainEntries()\` once per session start, so any junk that
  predates the filter (or escapes the regex through new model behavior)
  gets cleared. Drops the entities + their observations + their
  relations atomically.
- \`HygieneReport\` gains \`brainJunkEntitiesRemoved\` so the cleanup
  surfaces in agent-startup logs instead of silently churning disk.

Subreddits like \`r/LangChain\` are NOT filtered — they're real entities
the user might want to remember (e.g. as audience targets for a
marketing wedge). The patterns target programmatic strings only.

Tests: 310/310 pass.

## 3.15.43 — Fallback stats no longer report 0% across all real requests

Verified 2026-05-04 on a real dev machine after 5150 lifetime
requests: \`franklin-stats.json\` showed
\`totalFallbacks: 0\` and every per-model \`fallbackCount: 0\` —
even though \`franklin-debug.log\` clearly recorded multiple
successful fallbacks (\`↺ Fallback successful: using
deepseek/deepseek-chat\` etc.). The audit log
(\`franklin-audit.jsonl\`) also showed only 1 entry with
\`fallback:true\` across the same period.

Source: agent loop's \`recordUsage(...)\` call at
\`src/agent/loop.ts:1369\` was a 5-arg invocation —
\`(model, in, out, cost, latencyMs=0)\` — with no \`fallback\`
argument. Defaulting to \`false\` meant stats never registered an
agent-path fallback, even when the audit-log call right below at
line 1425 correctly set \`fallback: turnFailedModels.size > 0\`
for the SAME turn. Two writers, one variable, one was always
silent.

Effect on the user: \`franklin insights\` and \`franklin stats\`
under-counted fallback frequency to \"never happens\". On a
machine where the routing chain is occasionally hot, that's the
exact signal you'd want to see — and it was masked.

Fix:

- \`src/agent/loop.ts:1369\` now passes
  \`turnFailedModels.size > 0\` as the 6th arg to \`recordUsage\`,
  mirroring the audit-log predicate three lines down.
  Single-source-of-truth for fallback detection within the turn.

Note: the proxy-path \`recordUsage\` calls at
\`src/proxy/server.ts:658\` and \`:708\` were already correct —
they pass \`usedFallback\` from the fallback-chain runner. Only
the agent-loop call site was missing the flag.

Tests: 310/310 pass.

## 3.15.42 — Tasks subsystem now stores under \`~/.blockrun/\` (with legacy fallback)

Verified 2026-05-04 on a real machine running an active ETL task:
\`du -sh ~/.blockrun ~/.franklin\` returned \`309M\` and \`72K\` —
two parallel home dirs on the user's machine, with everything
EXCEPT the tasks subsystem under \`~/.blockrun/\`. The split is
real:

\`\`\`
~/.blockrun/    sessions, audit, stats, brain, cache, skills, ...
~/.franklin/    only tasks/<runId>/{meta.json,events.jsonl,log.txt}
\`\`\`

Source: \`src/tasks/paths.ts\`'s \`franklinHome()\` defaulted to
\`os.homedir() + '/.franklin'\` while every other persistent
state (\`config.ts:BLOCKRUN_DIR\`) used \`~/.blockrun\`. Functionally
both paths worked, but it meant \`rm -rf ~/.blockrun\` left task
state stranded, \`du -sh ~/.blockrun\` under-reported Franklin's
real footprint, and the inconsistency violated the
"everything-under-BLOCKRUN_DIR" convention everywhere else in the
codebase.

Fix:

- \`src/tasks/paths.ts\`: \`franklinHome()\` now defaults to
  \`BLOCKRUN_DIR\`. The \`FRANKLIN_HOME\` env var keeps working as
  an explicit override (test/local.mjs:5014 relies on this for
  isolated task-path tests). Added \`getLegacyTasksDir()\`
  exporting the old \`~/.franklin/tasks/\` location.
- \`getTaskDir(runId)\`: lazy fallback. Returns the primary
  location if it exists; otherwise (only when \`FRANKLIN_HOME\` is
  unset, so tests stay deterministic) checks the legacy dir;
  otherwise returns primary so \`ensureTaskDir()\` creates it
  there for new tasks. Reads find the right location; writes go
  wherever the task already lives.
- \`src/tasks/store.ts\`: \`listTasks()\` walks both primary +
  legacy dirs with first-wins dedupe. Verified locally on a
  machine with all 6 tasks in legacy: \`listTasks()\` returns
  all 6 including the live runner at PID 59095.

Why a lazy fallback instead of a startup migration: a long-running
task runner (\`franklin _task-runner <runId>\`) captures its task
dir path in memory at spawn and continues writing to it for the
duration. Verified 2026-05-04: an in-flight ETL task at PID 59095
had been writing to \`~/.franklin/tasks/\` for 4 minutes, with
hours of progress remaining. Renaming or moving the directory
mid-flight would orphan its writes; a lazy read-fallback lets new
CLI commands keep reading legacy state without disturbing the
live runner. New tasks land in \`~/.blockrun/tasks/\`. Once all
legacy task dirs are in terminal status, the user can
\`rm -rf ~/.franklin/\` manually — no migration script needed.

Tests: 310/310 pass. The existing
\`task paths: getTasksDir + ensureTaskDir + per-task paths\` test
sets \`FRANKLIN_HOME\` explicitly so the contract there is
unchanged.

## 3.15.41 — \`npm test\` (local suite) also stops leaving ghost session metas

3.15.40 plugged the e2e leak; verifying it on a real machine
surfaced a sibling leak in \`test/local.mjs\`. Running plain
\`npm test\` (no e2e) was leaving 3 ghost \`.meta.json\` files in
\`~/.blockrun/sessions/\` on every invocation — confirmed twice
during the 3.15.40 ship cycle (timestamps 21:23:01-03 and
21:26:51-53), six total ghosts from two test runs.

Source: the \`runCli()\` helper at \`test/local.mjs:36\` spawns
the real franklin binary with \`--model zai/glm-5.1\` (a real
gateway model, not a fixture name) and inherits the parent's
\`HOME\`. The file-level \`process.env.FRANKLIN_NO_AUDIT = '1'\`
on line 24 keeps audit + stats clean — exactly as
\`test/local.mjs\` expects, since its resume tests need session
writes to keep working — but session writes still landed in
the user's prod \`~/.blockrun/sessions/\` because there was no
\`FRANKLIN_NO_PERSIST\` set anywhere. The CLI tests in question
(banner, \`--prompt\`, \`--exit\`, etc.) don't care about session
state at all, they just care about stdout / exit code, so
disabling persistence inside \`runCli\` is harmless to them.

Tests in the same file that DO need session writes (resume,
findLatestSessionForDir, /session-search) call
\`interactiveSession()\` in-process or use their own
subprocess spawns with explicit \`HOME: fakeHome\` overrides —
those paths bypass \`runCli\` and remain unaffected.

Fix:

- \`test/local.mjs\` \`runCli()\`: prepend
  \`FRANKLIN_NO_PERSIST: '1'\` into the spawned env, behind the
  \`...process.env\` spread so an explicit \`env: { FRANKLIN_NO_PERSIST: '' }\`
  argument can still override per-test (the same escape-hatch
  pattern the rest of the file uses for \`FRANKLIN_NO_AUDIT\`).
- Re-ran \`npm test\` and verified zero new ghost metas land in
  \`~/.blockrun/sessions/\` after 310 tests pass.

This finishes the cleanup. Both \`npm test\` and
\`npm run test:e2e\` now run without leaving session
artefacts behind. Real user sessions written during the
test window are unaffected.

## 3.15.40 — \`npm run test:e2e\` no longer pollutes the user's audit log

Verified 2026-05-04 on a real developer machine: \`grep -c
"private/var/folders" ~/.blockrun/franklin-audit.jsonl\` returned
**409 entries** spanning 13 days, totalling **\$0.258** in
test-fixture costs that quietly mixed into the user's lifetime
spend stats. Three orphan session-meta files (\`zai/glm-5.1\`,
\`nvidia/qwen3-coder-480b\`) had also leaked into
\`~/.blockrun/sessions/\` from the most recent run.

Root cause: \`isTestFixtureModel()\` filters by name prefix
(\`local/test\`, \`slow/\`, \`mock/\`, \`test/\`). E2E tests deliberately
spawn the real CLI with **real** model names — \`zai/glm-5.1\` (the
default), \`nvidia/qwen3-coder-480b\` (a coverage case), so the
prefix gate doesn't fire and every audit/stats/session write
lands in the developer's home dir.

There was already a \`FRANKLIN_NO_AUDIT=1\` env-var escape hatch
(audit.ts:62, tracker.ts:214) for exactly this — added in 3.15.16
when 3.15.17's fixture-rename made test fixtures look real. But
two pieces were missing:

1. \`src/session/storage.ts\` had no equivalent guard — so
   \`appendToSession\` and \`updateSessionMeta\` kept writing
   \`.jsonl\` + \`.meta.json\` files to the user's prod sessions dir
   even when tests had explicitly opted out of side effects.
2. \`test/e2e.mjs\` never set any opt-out env var, so neither
   audit/stats nor session writes were skipped during
   \`npm run test:e2e\`.

Fix:

- \`src/session/storage.ts\`: \`isSessionPersistenceDisabled()\`
  now returns \`persistenceDisabled || process.env.FRANKLIN_NO_PERSIST === '1'\`,
  and \`appendToSession\` / \`updateSessionMeta\` switched from
  the bare flag to the function. Closes the home-dir leak even
  when child code doesn't call \`setSessionPersistenceDisabled()\`.
- \`test/e2e.mjs\`: \`process.env.FRANKLIN_NO_AUDIT = '1'\` and
  \`process.env.FRANKLIN_NO_PERSIST = '1'\` set at the top of the
  module, before any imports / spawns. Inherited by spawned
  children via the existing \`env: { ...process.env }\` passthrough
  on line ~37.

Why a separate env var instead of extending \`FRANKLIN_NO_AUDIT\`:
\`test/local.mjs\` sets \`FRANKLIN_NO_AUDIT=1\` at file level
expecting session writes to keep working so resume tests can
verify \`.jsonl\` contents on disk — that contract is load-bearing
for ten test cases that were verified to break under the broader
semantic. Two vars, two concerns: \`FRANKLIN_NO_AUDIT\` blocks
audit + stats; \`FRANKLIN_NO_PERSIST\` blocks session writes.
Tests that want both set both. Tests that want only audit-off
set only that.

Existing 409 audit entries are left in place. Append-only audit
logs are forensic records; the \$0.258 of test cost is small
enough to disclose as "this was test traffic before the leak was
plugged" rather than risk deleting interleaved real entries.

## 3.15.39 — Bash tool actually runs bash (not the user's \`\$SHELL\`)

Real session 2026-05-04: agent ran \`rm -f
data/etl_out/shard-*.ndjson\` and got:

\`\`\`
zsh:1: no matches found: data/etl_out/shard-*.ndjson
\`\`\`

The user's \`\$SHELL\` is \`/bin/zsh\` (macOS default since 2019),
and the Bash tool was using \`process.env.SHELL || '/bin/bash'\` —
so the agent's bash-shaped commands ran in zsh. zsh's default
\`NOMATCH\` mode treats unmatched globs as fatal errors (a deliberate
typo-protection feature), while bash silently passes the pattern
through. The agent had learned bash semantics from training; the tool
silently routed to a different shell.

Other zsh-vs-bash divergences that would silently bite agents:

- Process substitution syntax (\`<(cmd)\` works in both but escaping rules differ)
- \`[[ \$var ]]\` empty-string check edge cases
- Parameter expansion (\`\${var:offset:length}\` with negative offsets)
- Array indexing (zsh is 1-based, bash is 0-based)
- \`echo -e\` flag handling

Each is a latent foot-gun. Agents that "know bash" hit them
unpredictably depending on which user's machine the tool runs on.

Fix:

- \`tools/bash.ts\`: \`const shell = fs.existsSync('/bin/bash') ?
  '/bin/bash' : (process.env.SHELL || '/bin/sh');\` — force the
  POSIX-standard bash, fall through to user shell only if bash is
  missing (NixOS-style stores, exotic Docker).
- The tool's name and documented contract finally match runtime.
- Tradeoff: any zsh-only aliases / functions in
  \`~/.zshrc\` are no longer available to agent commands. Almost
  always overlapping with bash equivalents in practice; add explicit
  \`source\` calls if you need them.

Independent of which login shell the user prefers — \`franklin\`'s
own status bar, history, and completions still use \`\$SHELL\`. Only
agent tool execution is pinned.

## 3.15.38 — \`--resume\` preserves running cost / token totals (don't lose history)

Real session 2026-05-04 caught this. Reading the latest log entries
turned up two new \`[INFO] Slow tool: Bash error after 200s\` rows
from my 3.15.32 fix firing — good. While checking session metas for
context I noticed:

\`\`\`
session efd5e412
  costUsd: 0
  inputTokens: 0
  outputTokens: 0
  toolCallCounts: { Bash: 36, Read: 5, Write: 7, Edit: 4, Detach: 1 }
\`\`\`

That session had run \$2.65 + 350K input tokens an hour earlier — I
saw the meta with the right numbers myself. Now zero. Tool counts
preserved, monetary state lost.

Cause: \`agent/loop.ts\` initialized \`sessionInputTokens\`,
\`sessionOutputTokens\`, \`sessionCostUsd\`, \`sessionSavedVsOpus\` to
\`0\` at the start of every \`interactiveSession\` invocation, including
when resuming. Each turn accumulated, but the seed was always 0. Then
\`updateSessionMeta\` wrote those (smaller) numbers back, overwriting
the historical values. Effectively: every resume reset the visible
session cost.

Tool counts survived because they live in a separate
\`sessionToolCounts\` map that updates with \`Object.fromEntries(...)\`
and gets merged via the \`toolCallCounts !== undefined\` guard in
\`updateSessionMeta\`.

- \`agent/loop\`: on resume, capture \`meta.inputTokens / outputTokens /
  costUsd / savedVsOpusUsd\` and use them as the initial values for
  the running counters. Subsequent turns accumulate on top — true
  session total across every restart.
- No interface change; no test changes needed.

\`franklin insights\`, the status bar's session-cost annotation
(\`-\$X.XXXX\`), and any external scripts reading
\`~/.blockrun/sessions/\*.meta.json\` now report cumulative state
correctly. Pre-3.15.38 sessions where the values were already
zeroed stay zeroed (no migration); future activity adds on top of
whatever's there now.

## 3.15.37 — Detach: stop telling agents to use \`--follow\` from Bash (it always times out)

Real session 2026-05-04 14:52: agent ran a Detach for an ETL job
(\`t_morkaf83_f03a0b10\`), then to check on it copied the output's
recommendation verbatim:

\`\`\`
Bash({
  command: "franklin task tail t_morkaf83_f03a0b10 --follow 2>&1 | head -30",
  timeout: 10000
})
→ "command killed — timeout after 10s"
\`\`\`

\`--follow\` blocks until the task reaches a terminal state — for an
ETL on 200K+ files, hours. The Bash tool's default 2-minute timeout
(or whatever the model passes) will always kill it first. The agent
just copy-pasted what we told it to.

The Detach output's \`Inspect with:\` block said
\`franklin task tail X --follow\`, and the tool description echoed
the same line. Both fixed:

- \`tools/detach\` output: leads with the **non-blocking** snapshot
  command (\`franklin task tail X\`) as the safe default. The next
  line is \`franklin task wait X --timeout-s 600\` for "block until
  done" with explicit timeout. A WARNING block underneath spells out
  why \`--follow\` from Bash is wrong.
- \`tools/detach\` description: same precedence — non-blocking tail
  recommended; explicit warning that \`--follow\` from Bash will
  trip the timeout. Long-blocking belongs in \`task wait\` with
  matching Bash \`timeout\` param.

Existing \`franklin task tail --follow\` from a real terminal still
works fine — the change is purely about what we suggest to the
model. The fix kicks in next turn after the agent reads the new
description.

## 3.15.36 — Strip \`tool_choice\` for reasoning models that reject it (deepseek-reasoner, o1, o3)

Real session 2026-05-04 14:58: user's screenshot showed a fatal
schema error mid-turn:

\`\`\`
Request failed
• Type: Schema
• Message: HTTP 400: Invalid request: 400 deepseek-reasoner does not support this tool_choice
\`\`\`

The grounding evaluator had detected ungrounded claims and pinned a
\`tool_choice\` for the next round (forcing the model to call a
specific tool). The next request landed on
\`deepseek/deepseek-reasoner\` — a reasoning-only model that rejects
\`tool_choice\` outright. \`agent/llm.ts\` already strips
\`tool_choice\` when \`tools\` is empty (3.x) but had no notion of
"this model doesn't support the field at all".

Fix:

- \`agent/llm.ts\`: new \`MODELS_WITHOUT_TOOL_CHOICE_SUBSTR\` allowlist
  + \`modelDoesNotSupportToolChoice(model)\` helper. Substring match
  keeps it resilient to model-version suffixes (\`o1-mini\`,
  \`o3-2026-04\`, etc.). Initial entries: \`deepseek-reasoner\`,
  \`openai/o1\`, \`openai/o3\`.
- Same strip site as the existing tools[]-empty guard: silently drop
  \`tool_choice\` before the request goes out. The grounding-retry
  contract already tolerates it disappearing (the agent re-evaluates
  on the next turn). No user-visible change beyond not seeing the
  400 anymore.

Allowlist not guess-list: only add models whose 400 errors are
verified in real session logs.

## 3.15.35 — \`franklin --resume\` restores the session's chain (no more silent chain swap)

User filed this from a real flow on 2026-05-04: started a session
on Base, ran a debug command (\`franklin solana wallet\` — chain
shortcut that persists to \`~/.blockrun/.chain\`), then
\`franklin --resume <id>\`. Wallet quietly switched from
\`0xCC8c…5EF8\` (Base, funded) to \`Fg57kHX9…AKaH\` (Solana,
\$0.01). Conversation, audit, and tool results all belong to Base
— resuming on Solana means the agent is talking to a different
wallet entirely.

Root cause: \`SessionMeta\` had no chain field, so
\`commands/start.ts\` always called \`loadChain()\` (which reads
the \`.chain\` file). Any \`franklin <chain>\` invocation between
sessions overrode it. Sessions are wallet-bound by conversation
context — they should restore their original chain.

Fixes:

- \`session/storage\` \`SessionMeta\`: new \`chain?: 'base' | 'solana'\`
  field. \`updateSessionMeta\` treats it as **sticky** — once a
  session has a chain recorded, no later update can clear it back
  to undefined. New sessions persist the field on every meta write.
- \`agent/loop\`: \`persistSessionMeta\` passes \`chain: config.chain\`
  on every update. Captured at session start and on every turn.
- \`commands/start\`: when \`--resume <id>\` (or \`--continue\`)
  resolves to a session with a recorded chain, use that chain
  instead of the persisted default. Logs a \`Restoring session's
  chain: X\` line when they differ so the user sees the
  precedence. Pre-3.15.35 sessions without the field fall back to
  the persisted default (same as pre-3.15.35 behavior).

\`franklin <chain>\` shortcut behavior is unchanged for new
sessions — it still persists \`.chain\` for invocations without
\`--resume\`. The fix is specifically for the resume path.

## 3.15.34 — Low-balance warning in the status bar (don't make users guess)

Real session 2026-05-04 14:50: user looked at the status bar
showing \`$0.08 USDC\` (dim text alongside model name) and asked
"is that I really don't have money? or i need switch to base
chain". On-chain check: actually \$0.0775 left after a \$2.92
Opus session. Real out-of-funds, but the UI gave them no signal
that it was urgent.

- \`ui/app\`: status bar now color-codes the balance:
  - **Red bold + ⚠ "low — fund wallet or /model free"** when
    balance < \$0.50 (≈ 3–5 Opus calls left at typical \$0.10/turn).
  - **Yellow** when balance < \$1.00 (≈ 10 calls left).
  - Plain dim otherwise — current behavior.
- The hint names both options the user actually has (top up the
  wallet or switch to a free model with \`/model free\`), so they
  don't need to ask.
- Existing live-balance computation unchanged — this is purely a
  rendering tweak to the same number.

The Base wallet shown in the screenshot was on the right chain;
the user just genuinely needed to fund it. The new rendering would
have made that obvious without a roundtrip to the assistant.

## 3.15.33 — Fix Detach child crash with MODULE_NOT_FOUND on dev-mode Franklin

Real session 2026-05-04 14:35 caught this. User running Franklin in
dev mode (\`node dist/index.js\` from the brcc source tree) used the
\`Detach\` tool to start an ETL job with \`workingDir=blockrun-analytics\`.
The detached runner failed immediately:

\`\`\`
node:internal/modules/cjs/loader:1228
  throw err;
  ^
Error: Cannot find module '/Users/vickyfu/Documents/blockrun-analytics/dist/index.js'
\`\`\`

Cause in \`src/tasks/spawn.ts\`: \`resolveCliPath()\` returned
\`process.argv[1]\` verbatim. In dev mode that's the relative path
\`dist/index.js\`. The child \`spawn(node, [cliPath, '_task-runner',
runId], { cwd: input.workingDir })\` then tried to load
\`<workingDir>/dist/index.js\` — wrong directory, fails. npm global
installs are unaffected because their entry script is an absolute
symlink path; only \`node dist/index.js\` triggers it.

Fix:

- \`src/tasks/spawn.ts\`: capture \`STARTUP_CLI_PATH = path.resolve(
  process.argv[1])\` at module load. Use that in \`resolveCliPath()\`.
  Resolving at module load (not call time) is intentional — by the
  time \`startDetachedTask\` runs, we may be many seconds in and
  any code path could have called \`process.chdir()\` (none does
  today, but the absolute path is the safer default).
- \`FRANKLIN_CLI_PATH\` env override is still preferred when set —
  matches the existing test escape hatch.

Existing global-install users see no behavioral change. Dev users
(and anyone hitting the same MODULE_NOT_FOUND) get a working
Detach.

## 3.15.32 — Slow-tool + thrown-error logging in streaming executor

A real session 2026-05-04 13:13 surfaced this gap: user's screenshot
showed \`✗ Bash 337.6s\` with a "Error while reading table" message
in the UI tool block. Five-and-a-half minutes of Bash that errored,
zero entries in \`franklin-debug.log\`. Post-hoc you can't ask
"what was that long Bash that failed yesterday" — the only forensic
trail was the session jsonl, which is per-session and not
greppable across history.

Two new log lines from \`agent/streaming-executor\`:

- \`[INFO] Slow tool: ${name} ${status} after Xs — ${preview}\` when
  a tool execution crosses 30s, regardless of outcome. Threshold is
  conservative — \`Read\` / \`Glob\` / \`Grep\` finish in <1s; only
  network calls (gsutil/bq, WebFetch on slow servers) and shell
  builds cross. Includes the input preview (Bash command, file path,
  search pattern) so the trail is actionable.
- \`[WARN] Tool error: ${name} threw "${msg}" — ${preview}\` when a
  tool throws an exception (caught at the executor layer). Pre-3.15.32
  these only went to \`failures.jsonl\`, which most users never look
  at. Tool errors now sit alongside everything else
  \`franklin logs\` shows.

Both leverage the existing \`inputPreview()\` helper on the
\`StreamingExecutor\` class — no extra serialization cost. Fast,
successful tools still leave the log silent (the contract since
3.15.11).

## 3.15.31 — Data hygiene reports what it cleaned (no more silent runs)

Verified 2026-05-04 reading franklin-debug.log mid-session: hygiene
was running at every session start (since 3.15.15) but never wrote
anything to the log. The only way to verify it was alive — and what
it had cleaned — was to manually \`ls\` directories before/after.
That's the kind of thing the unified logger exists to fix.

- \`storage/hygiene\`: \`runDataHygiene()\` now returns a
  \`HygieneReport\` (\`{ legacyFilesRemoved, dataFilesTrimmed,
  costLogRowsTrimmed, orphanToolResultsRemoved }\`) instead of void.
  Each subroutine returns its own count; the report adds them up.
- \`agent/loop\`: at session start, after hygiene runs, log one
  \`[INFO]\` line if any total is non-zero:
  \`Data hygiene: 4 legacy, 12 data files, 273 cost_log rows, 5
  orphan tool-results dirs cleaned\`. Skip the log when nothing was
  touched (most healthy sessions) so the line stays meaningful.
- \`+1 test\` pinning the report contract — \`legacyFilesRemoved=1\`
  when one legacy file is seeded, zero on the other counts.

Tested: 310 passing (up from 309). The gap between hygiene running
and being verifiable is now closed.

## 3.15.30 — Loop detector now matches input signatures, not just call counts (don't kill exploration)

Reading the same Opus session minutes after shipping 3.15.28's
count-based hard stop revealed an over-correction. The session was at
\`Bash\` call **#15**, making distinct \`gsutil\` / \`bq\` queries
against the BlockRun GCS log bucket — each call producing genuinely
new information ("February files are pretty-printed JSON, not NDJSON",
"BQ NDJSON parser cannot read that directly"...). 3.15.28 would have killed it at
call 6, mistaking legitimate exploration for a search loop.

The actual failure mode 3.15.28 was meant to catch is the model
retrying the **exact same call** hoping for a different result.
3.15.30 detects that directly:

- \`agent/loop\`: track \`turnSignatureCounts: Map<sig, count>\` per
  turn, where \`sig = toolCallSignature(name, input)\` (already
  exported by \`planner.ts\`). Increment on each tool invocation.
- New \`SAME_SIGNATURE_HARD_STOP = 3\`: when ONE \`(tool, input)\`
  pair fires 3× in one turn, log a \`[ERROR]\`, emit
  \`turn_done reason=cap_exceeded\`, break. The user sees:
  "\`Bash\` called 3× with the same input this turn — that's a
  real loop, not exploration. Ending turn."
- Removed 3.15.28's \`SAME_TOOL_HARD_STOP\` count-based break — too
  blunt. The total hard cap (50 calls) remains as a safety net for
  truly runaway turns.

Five-layer runaway protection now:

| Layer | Trigger | Behavior |
|-------|---------|----------|
| Soft warn | Same tool ≥ 3 in turn (any input) | Inject \`[SYSTEM]\` once |
| Cap warn | Total tools ≥ 25 in turn | Inject + log warn once |
| **Signature loop stop** | **Same (tool, input) ≥ 3 in turn** | **Break turn** |
| Total hard cap | Total tools ≥ 50 in turn | Break turn |
| (Existing) No-progress | 2 consecutive empty responses | Break turn |

This preserves the protection from 3.15.28 against actual loops
while letting Opus / GPT-5.5 do legitimate complex multi-step work.

## 3.15.29 — Populate audit \`toolCalls\` (interface had it since 3.15.11, code never did)

Reading franklin-audit.jsonl mid-session showed every recent Opus row
with \`toolCalls\` either missing or empty. Cross-checked the session
jsonl: tool_use blocks were definitely there (Bash, Read calls
firing). The audit just wasn't recording the names.

\`AuditEntry.toolCalls?: string[]\` has been in the interface since
3.15.11; the \`appendAudit({ ... })\` call site at \`agent/loop.ts:1354\`
never populated it. Loss of forensic data — "what tools fired most
across last week" wasn't answerable from \`~/.blockrun/franklin-audit.jsonl\`
even though the field was reserved for exactly that.

- \`agent/loop\`: walk \`responseParts\`, pull tool names off
  \`tool_use\` blocks, pass them as \`toolCalls\` to \`appendAudit\`.
  Set \`undefined\` when the turn had no tools so the audit row
  doesn't grow with empty arrays.

Going forward, \`franklin insights\` and any external tooling that
reads the audit can answer tool-usage questions correctly. Existing
rows stay as-is (no migration); the field gradually fills as new
calls happen.

## 3.15.28 — Same-tool-warn warn-once + hard stop (Opus search-loop survivor)

Real session 2026-05-04 caught this: user restarted Franklin on Opus-4.7
to retry an analytics task that had hit the runaway hard cap on
zai/glm-5.1. Opus did the same thing, just more politely.

Reading the session jsonl:

\`\`\`
[SYSTEM] You have called Bash 3 times this turn. Stop and present...
[assistant] [text: "two issues..."] [tool_use: Bash(gsutil ls...)]
[SYSTEM] STOP. You have now called Bash 4 times — more searching...
[assistant] [tool_use: Bash(gsutil ls.../2026/...)]
[SYSTEM] STOP. You have now called Bash 5 times — more searching...
[assistant] [tool_use: Bash(...)]
\`\`\`

Two bugs in one. The same shape as 3.15.24's tool-cap-spam fix, just
in a sibling guardrail:

- **Same-tool warn fires every call past threshold.** \`if (count >=
  SAME_TOOL_WARN_THRESHOLD) inject\` — every Bash call past 3 pushed
  another \`[SYSTEM] STOP\` tool_result into the model's context. Same
  redundancy that 3.15.24 fixed for the total-call cap.
- **No hard stop.** The soft \`[SYSTEM] STOP\` is just text the model
  can ignore. Strong models (Opus, GPT-5.5) read it, briefly
  acknowledge, and call the same tool again. Nothing actually
  constrained behavior.

Fixes:

- \`agent/loop\`: track \`sameToolWarned: Set<string>\` per turn. Inject
  the warn exactly once when count first reaches the threshold.
- New \`SAME_TOOL_HARD_STOP = SAME_TOOL_WARN_THRESHOLD * 2\` (= 6
  calls of the same tool in one turn). When hit: \`logger.error\`,
  emit \`turn_done\` with reason \`cap_exceeded\`, break the turn.
  Mirrors what \`HARD_TOOL_CAP\` already does for total tool calls.
- User-facing message names the tool: \`"Bash called 6× in one turn —
  that's a search loop. Ending turn so you don't burn through
  credits."\`

This is the third runaway-prevention layer:

| Layer | Trigger | Behavior |
|-------|---------|----------|
| Soft warn (3.15.x) | Same tool ≥ 3 in a turn | Inject \`[SYSTEM]\` once |
| Cap warn (3.15.24) | Total tools ≥ 25 in a turn | Inject + log warn once |
| Same-tool hard stop (3.15.28) | One tool ≥ 6 in a turn | Break turn |
| Total hard cap (3.15.24) | Total tools ≥ 50 in a turn | Break turn |

Search loops now die at 6 calls of one tool, regardless of model.
The previous Opus session would have ended at the 6th Bash call
instead of running until the 50-call total hard cap fired.

## 3.15.27 — Permission dialog UX: docked, prominent, audible, can't be missed

A real screenshot from 2026-05-04 showed the failure mode plainly:
the user had a multi-step Franklin session running, the agent paused
to ask for Bash approval, and the dialog rendered as a small yellow
box high in the scrollback. Right below it: completed-tool checkmarks,
agent's response text, and the input box still cheerfully spinning
with placeholder "Working...". The user thought Franklin was busy and
walked away — Franklin was actually waiting on them.

Five changes:

- \`ui/app\`: dialog renders are no longer competing for attention.
  When a permission or AskUser dialog is up, the active-tools list,
  thinking spinner, waiting spinner, and stream-text preview all hide.
  The dialog is the only live element above the input box, so the
  user's eye can't slide past it.
- \`ui/app\`: dialogs now lead with a bright header
  (\`━━━━━━━━━━ ⚠  ACTION REQUIRED  ⚠ ━━━━━━━━━━\` red for
  permission, \`ANSWER REQUIRED\` magenta for AskUser) so they don't
  visually rhyme with the yellow tool-block borders that surround
  them.
- \`ui/app\` InputBox: when a dialog is up, the placeholder swaps
  from \`Working...\` to \`⚠  Approval needed — press [y]/[a]/[n] in
  the prompt above\` (or \`Question above — type your answer\` for
  AskUser), the spinner becomes a static \`⚠\` glyph, and the box
  border goes bright yellow. No way to read the input field as
  "agent is busy" while it's waiting on you.
- \`ui/app\`: terminal bell (\`\\x07\`) rings exactly once on dialog
  appearance — opt out with \`FRANKLIN_NO_BELL=1\` if your terminal
  is in a quiet space. Catches the case where Franklin is in a
  background tab.
- All previous behavior is preserved when no dialog is active —
  the regular spinner, streaming text, response preview, and tool
  blocks render normally. The change is strictly additive on the
  attention-grabbing path.

## 3.15.26 — Proxy success-after-fallback log checks the original model too

Reading the log post-3.15.25 surfaced a small but real leak:
\`franklin-debug.log\` had 10 entries reading
\`↺ Fallback successful: using deepseek/deepseek-chat\` with no
matching failure log preceding them. Cause: 3.15.24's proxy fixture
gate filtered the failure log when \`failedModel\` was a fixture
(\`slow/model\`), but the success log only checked \`finalModel\` —
the model that finally succeeded was \`deepseek/deepseek-chat\`,
not a fixture, so it logged. The chain started in a test fixture but
ended on a real model name, slipping past the gate.

Fix:

- \`proxy/server\`: the \`usedFallback\` success log now checks the
  full \`result.failedModels\` array. If any failed model in the
  chain is a fixture, the entire fallback was test-driven; skip
  the success log.

Brief detour worth recording: tried extending \`FRANKLIN_NO_AUDIT\`
to also gate session storage (sessions had 19 test fixtures of 22
metas — \`zai/glm-5.1\` and \`nvidia/qwen3-coder-480b\` model
names slipping past the model-fixture gate). Reverted: 10+ tests
needed env overrides and session pollution is already bounded by
\`MAX_SESSIONS=20\` LRU eviction. Audit/stats has higher ROI for
env-var gating because retention is 10k entries, much wider window
to pollute.



Reading the audit log surfaced what 3.15.17 had already broken:
when in-process resume tests were renamed from \`local/test-model\`
to \`zai/glm-5.1\` to keep verifying session persistence,
\`isTestFixtureModel\` (which only matches \`local/test*\`) lost
the ability to filter their audit + stats writes. Verified on a
real machine: **310 of 370 recent \`zai/glm-5.1\` audit entries
had \`output_tokens < 10\`** — clearly mock-server responses
mascarading as the real \`zai\` model. 62% of the user's recent
audit window was test fixtures.

The model-name gate is whack-a-mole; every fixture rename breaks
it again. Replacing it with an env-var control:

- \`stats/audit\`: \`appendAudit\` short-circuits when
  \`process.env.FRANKLIN_NO_AUDIT === '1'\`, alongside the existing
  fixture-model check.
- \`stats/tracker\`: \`recordUsage\` mirrors the same gate so
  \`franklin-stats.json\` stops accumulating mock responses.
- \`test/local\`: sets \`FRANKLIN_NO_AUDIT=1\` once at file scope,
  next to the existing \`FRANKLIN_NO_PREFETCH\` / \`FRANKLIN_NO_EVAL\`
  / \`FRANKLIN_NO_ANALYZER\` toggles. The three tests that
  specifically exercise the audit + tracker disk-write paths
  override it back to empty in their subprocess env so they still
  verify the write contract.

Existing pollution (310 mock entries in audit, ~84 in stats
history) will wash out via the 10k-audit + 1000-stats retention
caps shipped in 3.15.11 and 3.15.16. No manual cleanup needed.

## 3.15.24 — Reading the new logs surfaced two real bugs

\`tail ~/.blockrun/franklin-debug.log\` post-3.15.23 showed:

1. **Tool call cap fires once per call past the cap.** One turn
   produced 76 sequential \`Tool call cap hit: N calls this turn\`
   warnings (25→100). The cap was warning + injecting a stop-signal
   tool_result, but neither was tracked as already-fired, so the
   model context filled with redundant nags AND the warning spammed
   the log. Worse: nothing actually broke the loop, so a runaway
   model could keep billing tools indefinitely.
2. **\`slow/model\` polluting the user's log.** The proxy timeout
   test (test/local.mjs:380) uses \`modelOverride: 'slow/model'\` —
   a fixture name not caught by 3.15.16's \`isTestFixtureModel\`,
   which only matched \`local/test*\`. Each \`npm test\` run
   appended 3 entries to the user's real log.

Fixes:

- \`agent/loop\`: the cap warning + system tool_result inject are
  now gated on a per-turn \`toolCapWarned\` boolean — fire once.
  Hard cap added at \`MAX_TOOL_CALLS_PER_TURN * 2\` (50): if the
  model ignores the soft stop and keeps calling tools, the loop
  emits a \`turn_done\` with new reason \`'cap_exceeded'\` and breaks.
  The user sees a one-line ⚠️ message; runaway billing stops.
- \`stats/test-fixture\`: extended prefix list to \`slow/\`,
  \`mock/\`, \`test/\`, plus exact-match \`test\`. Each pattern was
  observed in test/local.mjs as a fixture model name.
- \`proxy/server\`: three model-aware log calls now check
  \`isTestFixtureModel\` first — the fallback-on-failure callback
  (\`failedModel\`/\`nextModel\`), the success-after-fallback info
  line (\`finalModel\`), and the network-error warning in
  \`fetchWithFallback\` (\`model\`). Real production failures still
  log; test-fixture noise gets dropped at the source.
- \`agent/types\`: \`StreamTurnDone.reason\` extended with
  \`'cap_exceeded'\`.
- +1 test pins the new fixture-prefix contract; existing 307 tests
  unchanged.

## 3.15.23 — Last \`console.error\` holdouts migrated to unified logger (paid tools + MCP)

The 3.15.21 sweep got proxy + fallback but missed 7 more
\`console.error\` call sites that should persist to
\`franklin-debug.log\` and don't:

- Six paid tools (\`modal\`, \`defillama\`, \`exa\`, \`videogen\`,
  \`musicgen\`, \`imagegen\`) had \`console.error('[franklin] X
  payment error: ...')\` inside the x402 catch block. Payment
  failures are exactly the kind of forensic event \`franklin logs\`
  is for; they were going to stderr only and getting swallowed by
  the Ink UI on most invocations.
- One transient surface in \`zerox-gasless\` (\`gasless status poll
  error\`) had the same problem.
- \`mcp/client\` still gated diagnostics on \`if (debug)
  console.error(...)\` — the original 3.15.11 audit pattern that
  agent/loop already moved off. Server connection failures now go
  to \`logger.warn\` so they survive the session; the one
  user-facing line at boot stays as \`console.error\` so the user
  sees it before the agent takes over the terminal.

Net: every diagnostic event in the codebase that should reach
\`franklin-debug.log\` now does. UI rendering paths
(\`ui/terminal\`, \`ui/model-picker\`, \`ui/session-picker\`,
\`tools/askuser\`) intentionally remain on \`console.error\` —
those are interactive UI output, not log entries.

## 3.15.22 — Fix PredictionMarket double-/api 404; cap brain observations + relations

Self-audit caught a real production bug in 3.15.14:

**\`PredictionMarket\` was 404'ing on every call.** The tool used paths
like \`/api/v1/pm/polymarket/markets\` but \`API_URLS.base\` already
ends in \`/api\` (\`https://blockrun.ai/api\`) — so the assembled URL
was \`https://blockrun.ai/api/api/v1/pm/...\` and every endpoint
returned 404. The bug went unnoticed for a week because the unit
tests only exercised the spec contract and error-paths; no test made
an actual network request.

- \`tools/prediction\`: replaced all 4 \`/api/v1/pm/...\` paths with
  \`/v1/pm/...\` to match the existing pattern in \`tools/defillama\`
  and \`tools/exa\`.
- \`test/local\`: regression guard reads the compiled
  \`dist/tools/prediction.js\` and asserts no path string starts with
  \`/api/v1/pm/\`. The check would have caught the original bug at
  build time if I'd written it earlier.

Plus a defensive growth bound on the brain subsystem:

- \`brain/store\`: caps \`MAX_OBSERVATIONS=2000\` and
  \`MAX_RELATIONS=500\`. \`addObservation\` evicts oldest entries when
  the cap is hit (younger observations tend to be more relevant and
  more confident); \`upsertRelation\` evicts by lowest count + oldest
  last_seen so often-reinforced relations stick around.
- \`extract.ts\` runs at every session end (commands/start.ts:515)
  so without this the files grew linearly forever — 200+ obs/month
  at typical use, GB-scale within a few years.

## 3.15.21 — Migrate proxy + fallback to the unified logger (last duplicates removed)

The original 3.15.11 logger audit flagged "three independent logging
implementations" — agent/loop migrated then, but \`proxy/server.ts\`
and \`proxy/fallback.ts\` kept their own \`debug()\` / \`log()\` /
\`appendLog()\` helpers, with subtly-different ANSI-strip regexes and
no \`[LEVEL]\` tag on writes. This release retires the duplicates so
every Franklin log line goes through one writer with one format.

- \`proxy/server\`: deleted the local \`debug()\` / \`log()\` /
  \`stripAnsi()\` / \`LOG_FILE\` definitions. 16 call sites moved to
  \`logger.debug\` / \`logger.info\` / \`logger.warn\` / \`logger.error\`
  based on severity (⚠️ → warn, ❌ → error, ↺ success → info).
  \`createProxy\` now calls \`setDebugMode(!!options.debug)\` once at
  start so stderr mirroring matches the proxy's debug flag.
- \`proxy/fallback\`: deleted \`appendLog()\`, the duplicate
  \`LOG_FILE\` const, and the bespoke \`ANSI_RE\` (which was missing
  the \`\\r\` carve the agent loop's regex covered — a real
  cross-implementation drift). Migrated to \`logger.warn\`.
- \`proxy/server\` imports cleaned up (\`fs\` / \`path\` / \`os\` now
  unused; logger handles all that internally).

Side effects users will notice:

- Proxy log entries now carry \`[INFO]\` / \`[WARN]\` / \`[ERROR]\`
  tags so \`grep '\\[ERROR\\]' ~/.blockrun/franklin-debug.log\`
  catches proxy errors too.
- The 10 MB self-rotation shipped in 3.15.20 now applies to proxy
  output as well — every writer is the same writer.
- Debug-mode stderr mirroring extends to proxy as a free side
  benefit; previously the local \`debug()\` only ever wrote to file,
  even with \`--debug\`.

## 3.15.20 — Logger self-rotates non-destructively; \`franklin logs\` reads across the rotation

\`franklin-debug.log\` had two related bugs that the 3.15.11 logger
didn't address:

- **No self-rotation.** The logger appended forever; the only rotation
  lived inside the \`franklin logs\` command and only fired when the
  user actually opened the log. A user who never ran \`franklin logs\`
  would accumulate gigabytes silently.
- **Destructive rotation.** When \`franklin logs\` did rotate, it
  read the file, sliced off the first half, and overwrote the
  original. Half the history vanished forever. No archive.

Fixes:

- \`logger\`: every \`writeFile()\` increments a probe counter; every
  1000 writes (~80 KB worth — entries average ~80 bytes) the logger
  stats the file and, if it crosses 10 MB, renames it to
  \`franklin-debug.log.1\` (overwriting any previous archive) and
  starts the live log fresh. One full archive of the most recent 10
  MB is always retained, so post-rotation history isn't lost.
  Best-effort: rename failures fall through to a delete-and-retry
  on Windows-style EEXIST, then give up rather than leaving the live
  log in a half-rotated state. Probe is amortized so the per-write
  overhead is a counter increment.
- \`commands/logs\`: the destructive in-place "slice off the first
  half" rotation is gone — self-rotation in the logger makes it
  redundant. \`printLastLines\` now stitches the archive + live log
  on read so \`franklin logs --lines N\` correctly spans the
  rotation boundary. \`--clear\` deletes both files.
- +1 test seeds an 11 MB pre-rotation file, fires 1001 writes to
  cross the probe boundary, and asserts the archive holds the bulk
  + the live log holds the post-rotation entries.

## 3.15.19 — Plug two leaky in-process tests; CHANGELOG re-aligned

3.15.18 shipped \`sweepOrphanToolResults()\` but the published npm
artifact didn't include the test-cleanup follow-up — version bump
puts the published version back in sync with what the CHANGELOG
section below describes.

## 3.15.18 — Sweep orphan tool-results directories + plug two leaky in-process tests

Round-3 audit, after sweeping orphan session jsonl + legacy files in
3.15.15 and gating session writes in 3.15.17: two more pollution paths
left to address.

**(a) \`~/.blockrun/tool-results/\` accumulates per-session subdirs.**
The \`streaming-executor\` writes large tool outputs to
\`tool-results/<sessionId>/<toolUseId>.txt\` for replay; when
\`pruneOldSessions\` removes the meta + jsonl, the tool-results dir is
left dangling. Verified: 5 dirs on a real machine, oldest from
2026-04-14 — 3 weeks past the MAX_SESSIONS=20 LRU cutoff.

- \`storage/hygiene\`: \`sweepOrphanToolResults()\` runs as part of
  \`runDataHygiene()\`. Lists \`tool-results/\`, intersects with the
  \`.meta.json\` set in \`sessions/\`, and recursively removes the
  difference. Active session is implicitly protected because its meta
  exists by the time the agent loop fires hygiene. Best-effort: every
  per-dir failure is swallowed so a single permission glitch can't
  abort the sweep, and an unreadable \`sessions/\` dir bails out
  entirely (we never delete based on a partial knownSessionIds set).

**(b) Two in-process tests were leaking session files into the user's
real \`~/.blockrun/sessions/\` on every \`npm test\` run.** Verified
on a real machine: 16 test-pollution metas in the most recent test
session. The 3.15.17 fixture-model gate caught \`local/test*\` writes
but I'd already renamed those tests to \`zai/glm-5.1\` to keep the
persistence-for-resume tests verifying the write path — sidestepping
my own gate.

- \`test/local\`: the dynamic-tool-visibility test (3615) and the
  intent-prefetch test (4141) both run \`interactiveSession()\`
  in-process and pre-3.15.18 left their \`<sessionId>.jsonl\` +
  \`.meta.json\` in the user's home. Snapshot \`listSessions()\` at
  test start, in \`finally\` delete any new session that wasn't
  there before — same pattern the resume tests at 489/609 already
  use.
- +1 hygiene test covers the live-survives / orphan-dies invariant
  for tool-results.

\`runCli\`-based banner / CLI-flow tests still create empty sessions
(\`tc=0\` \`mc=0\`) but those are caught by \`pruneOldSessions\`'s
existing ghost-cleanup (\`messageCount === 0\` + \`createdAt > 5min\`),
so they don't need an explicit cleanup pass.

## 3.15.17 — Session storage stops persisting test fixtures; recordOutcome defensive gate

Round-2 audit of the same user's \`~/.blockrun/\` after 3.15.16
shipped found a third pollution path that the audit/stats gate didn't
cover: \`~/.blockrun/sessions/\`. 19 of 33 \`.meta.json\` files
(57.6%) belonged to \`local/test-model\` — the same in-process
tests that were polluting audit, but writing through a different
persister (\`appendToSession\` + \`updateSessionMeta\`).

This is smaller-impact than audit because \`MAX_SESSIONS=20\` already
bounds it and the 3.15.15 orphan sweeper cleans up dangling jsonl,
but the active session writes were still evicting real user sessions
from the LRU faster than they should.

- \`session/storage\`: new \`setSessionPersistenceDisabled(bool)\` /
  \`isSessionPersistenceDisabled()\` API. \`appendToSession\` and
  \`updateSessionMeta\` early-return when disabled. Reads are still
  allowed so tests can pre-seed and inspect.
- \`agent/loop\`: at session start, \`setSessionPersistenceDisabled(
  isTestFixtureModel(config.model))\` — same fixture detector as the
  audit/stats gates.
- \`router/local-elo\`: \`recordOutcome\` also gated on
  \`isTestFixtureModel(model)\`. router-history is currently clean
  (\`lastRoutedCategory\` is empty for tests so the call site already
  no-ops), but a future change to category detection would
  immediately leak. Belt-and-braces.
- \`test/local\`: 4 in-process tests that exercise session
  persistence-for-resume were using \`local/test-model\` as a label
  and got correctly silenced by the new gate. Switched to
  \`zai/glm-5.1\` (no actual API call — mock server backs them) so
  they continue to verify the write path. +2 new tests cover the
  setSessionPersistenceDisabled toggle and recordOutcome short-circuit.

## 3.15.16 — Test fixtures stop polluting telemetry; fallback flag actually recorded

Audit of a real \`~/.blockrun/franklin-audit.jsonl\` turned up two
observability bugs that had been silently corrupting the data Franklin
uses to learn from:

- **58.6% of audit entries were test fixtures.** 2326 of 3969 audit
  rows had \`model="local/test-model"\` or \`local/test\`. Tests in
  \`test/local.mjs\` run \`interactiveSession()\` in-process; the agent
  loop persisted every successful turn to the user's real audit log,
  stats history, and (until now) router-history. Stats were 8.4%
  polluted (84 of 1000 rows) for the same reason.
- **Fallback flag was 0% across 4k entries.** \`AuditEntry\` defines
  \`fallback?: boolean\` but the agent loop never set it — the field
  was wired into the type but not into the call site at \`loop.ts:1322\`.
  Made it impossible to answer "how often is the routing chain
  thrashing through fallbacks?" from telemetry.

Fixes:

- new \`stats/test-fixture\`: \`isTestFixtureModel(model)\` returns true
  for \`local/test*\` only — real local-LLM users (\`local/llamafile\`,
  \`local/ollama\`, \`local/lmstudio\`) are deliberately untouched.
- \`stats/audit\` + \`stats/tracker\`: short-circuit before any disk
  write when the entry's model is a test fixture. Same pattern as the
  existing 10k-entry retention guard.
- \`agent/loop\`: \`appendAudit\` now passes \`fallback:
  turnFailedModels.size > 0\`. Any payment / rate-limit / empty-response
  / server-streak swap during the turn means the model that finally
  answered was a fallback; future audit rows surface that.
- \`test/local\`: pre-existing \`stats tracker falls back to temp dir\`
  test was using \`local/test\` and got correctly silenced by the new
  guard; switched it to \`zai/glm-5.1\` so it still exercises the
  disk-write + tempdir path it was meant to verify. +3 new tests
  cover the matcher, audit short-circuit, and tracker short-circuit.

Existing pollution will gradually wash out via the 10k audit retention
and 1000-entry stats history cap (both shipped earlier this week);
no manual cleanup needed.

## 3.15.15 — Data hygiene: orphan sessions, ~/.blockrun/data trim, cost_log cap, legacy file removal

Audit of a real user's \`~/.blockrun/\` directory turned up four
unbounded-growth paths that no version of Franklin had pruned:

- **121 session jsonl files but only 21 metas** — 100 orphans (~1 MB)
  from a session-id format change in earlier releases. \`pruneOldSessions\`
  enumerated \`.meta.json\` files only, so orphan jsonl never got deleted.
- **\`~/.blockrun/data/\` at 5.7 MB** with files dating back 2 months. The
  \`@blockrun/llm\` SDK writes a JSON blob for every paid call here as a
  forensic archive but ships no retention. Linear growth → ~30 MB by
  year-end on light use, slows \`franklin insights\` pulls.
- **\`~/.blockrun/cost_log.jsonl\` at 38 KB / 474 entries** — same SDK,
  also append-only with no cap.
- **Legacy files** \`brcc-debug.log\`, \`brcc-stats.json\`,
  \`0xcode-stats.json\`, \`runcode-debug.log\` lingering from older product
  names. Not written by any current code path.

Fixes:

- \`session/storage\`: \`pruneOldSessions\` now also sweeps orphan jsonl
  files (no \`.meta.json\` partner) on every session start. Active
  session is always protected. Verified on the affected machine: 100
  orphan files cleaned, ~1 MB recovered.
- new \`storage/hygiene\`: \`runDataHygiene()\` runs alongside session
  prune at agent boot. Three jobs:
  - **data dir**: 30-day age cutoff + 2000-file hard cap (oldest-first
    eviction). Trim is best-effort; per-entry stat() failures are
    skipped so a single permission glitch can't take down boot.
  - **cost log**: 5000-entry cap with a cheap size probe (40 bytes/entry)
    so a small file doesn't trigger the read+rewrite. Pattern matches
    the existing audit-log retention shipped in 3.15.11.
  - **legacy files**: unconditional unlink for the four known leftover
    names. Only Franklin writes to BLOCKRUN_DIR so this is safe.
- \`agent/loop\`: \`runDataHygiene()\` wired in next to
  \`pruneOldSessions(sessionId)\` at session start. Self-throwing —
  startup never blocks on disk.

These are local-disk fixes only; the SDK's write-side will be patched
in a separate \`@blockrun/llm\` release. Until then Franklin handles
retention itself, which is the right place for it anyway since
Franklin owns the directory.

## 3.15.14 — PredictionMarket tool: Polymarket + Kalshi + cross-platform + smart money

BlockRun gateway shipped a Predexon-backed prediction-market surface
(\`/api/v1/pm/*\`) covering Polymarket, Kalshi, dFlow, Binance, Limitless,
Opinion, and Predict.Fun. Franklin's agent saw it only as an undocumented
"passthrough" line in the system prompt — useless without a tool. This
release adds the tool.

- new \`tools/prediction\`: \`PredictionMarket\` capability with four
  actions, dispatched off an \`action\` parameter (same shape as
  \`TradingMarket\`):
  - \`searchPolymarket\` (\$0.001) — keyword search Polymarket markets,
    surfaces YES/NO implied probabilities, volume, liquidity, end date,
    and the \`condition_id\` so the agent can drill into smartMoney later.
  - \`searchKalshi\` (\$0.001) — keyword search Kalshi markets with the
    yes-side bid/ask in cents, volume, OI, close time, and ticker.
  - \`crossPlatform\` (\$0.005) — pre-matched market pairs across
    Polymarket and Kalshi for arbitrage / divergence signals. Unique to
    the BlockRun gateway; not reachable via either platform's own API.
  - \`smartMoney\` (\$0.005) — top wallet flow on a Polymarket
    \`condition_id\`, with net YES/NO size and the top 5 buyers/sellers.
- output is filtered + capped at 20 rows by default (50 hard cap) so a
  single call never blows the context window. Each row fits one
  markdown line; cost is footer-stamped on every result.
- \`tools/index\`: registered alongside the existing trading + DefiLlama
  hero surface.
- \`tool-categories\`: added to \`CORE_TOOL_NAMES\` — election / odds
  questions are exactly the kind of "the agent with a wallet can answer
  this, and a stateless coding agent fundamentally cannot" use case
  Franklin's positioning is built on.
- \`agent/context\`: new "Prediction markets" section — when to call
  which action, the parallel-search-then-compare pattern for
  cross-venue divergence, and an explicit ban on answering odds
  questions from training-data memory.
- \`test/local\`: +5 unit tests covering the spec contract (action enum,
  pricing in description), no-network early failures (unknown action,
  missing action, missing conditionId for smartMoney), and registration
  in both \`allCapabilities\` and \`CORE_TOOL_NAMES\`.

## 3.15.13 — TradingSignal: 90d default, real verdict, no more "wait and see"

Same BTC report from 2026-05-03 had a second-order bug. After the
agent landed on a model that could read the tool output, TradingSignal
returned `MACD: 1822.73 / Signal: NaN / Histogram: NaN — neutral`
because default lookback was 30 closes — MACD needs slow EMA (26) +
signal EMA (9) = 35 minimum. Agent translated the partial signal into
"wait and see", the exact wishy-washy default the user
had flagged before. Three fixes, one report:

- `tools/trading`: \`TradingSignal\` default \`days\` 30 → 90. Added a
  **Verdict** section to the output (\`Direction\` + \`Bull signals\`
  + \`Bear signals\`) so the agent can echo a real call instead of
  re-deriving one from raw indicators. NaN indicators no longer
  contribute to the bull/bear tally — confidence is now \`max(bulls,
  bears) / votingIndicators\` so a single broken indicator can't dilute
  the call. MACD line says "insufficient data" explicitly when below
  threshold; tool description warns models to surface that path
  rather than translating it to "neutral". When closes < 35, output
  includes a **Data Notes** section with the exact gap and a
  re-run hint.
- `agent/context`: new "Trading verdicts" rule alongside the
  forbidden-phrases section. Forbids "wait and see" /
  "hold for clearer signals" as a default — only acceptable when the
  Verdict is genuinely \`neutral\` AND both bull/bear signal lists are
  empty (or 1-of-each tie). Otherwise the agent must commit to the
  direction the tool already gave it.
- `test/local`: +4 tests — MACD-30 leaves signal NaN (regression
  guard), MACD-60 produces finite signal/histogram, TradingSignal
  spec advertises new default + threshold, context.ts contains the
  Trading verdicts section.

Note: the VS Code extension renders tool output in a separate repo;
the truncated `### Technical` heading in the user's screenshot was
likely a panel-side collapse, not a CLI bug. Not addressed here.

## 3.15.12 — Category-aware free fallback (no more coder model on a BTC question)

User asked Franklin "What is BTC looking like today" on Auto. Routed to
claude-sonnet-4.6, which 402'd, and the agent then auto-switched to
`nvidia/qwen3-coder-480b` — a coder model — to do technical analysis.
Cause: both the payment-failure and rate-limit branches in `agent/loop`
hardcoded `['nvidia/qwen3-coder-480b', 'nvidia/llama-4-maverick',
'nvidia/glm-4.7']` with the coder first, regardless of question domain.

- `router`: new `pickFreeFallback(category, alreadyFailed)` exported from
  `src/router/index.ts`. Picks from per-category free chains —
  `coding` keeps qwen3-coder first, but `trading` / `research` /
  `chat` / `reasoning` / `creative` lead with `glm-4.7` or
  `llama-4-maverick` (general-purpose free models). Returns `undefined`
  when the candidate set is exhausted so callers can surface a real
  error instead of looping.
- `agent/loop`: replaced both hardcoded `FREE_MODELS` arrays (payment
  402 branch + rate-limit branch) with calls to `pickFreeFallback`
  threaded through `lastRoutedCategory`, which is already tracked for
  local-Elo recording.
- `getFallbackChain(tier, 'free')` now returns the general free chain
  instead of a single-element `[qwen3-coder]` — the old behavior just
  re-tried the same model forever after a failure.
- `test/local`: +6 tests covering coding-prefers-coder, trading-skips-
  coder, alreadyFailed exclusion, unknown-category default, exhaustion;
  existing free-routing-profile test relaxed from exact-list match to
  membership in the free-gateway set.

## 3.15.11 — Logging system: persistent diagnostics + bounded audit log

`franklin logs` was effectively empty for normal users. Eleven critical
agent events (auto-compaction, model fallback, media-stripping, prompt-
too-long recovery, server-error retries, max-tokens escalation, tool-call
cap, gateway error responses, etc.) were emitted via
`if (config.debug) console.error(...)` — so they hit stderr only when
`--debug` was set, and never reached the log file at all. Combined with a
`franklin-audit.jsonl` that grew without bound (verified: 3.6k entries on
a single dev machine after light use, GB-scale on a months-old install),
the post-incident "what happened?" answer was usually "nothing on disk".

- `logger`: new `src/logger.ts` module with `debug` / `info` / `warn` /
  `error` levels. Every level always persists to
  `~/.blockrun/franklin-debug.log` with an ISO timestamp and `[LEVEL]`
  tag (so you can `grep '\[ERROR\]'`). Stderr mirroring stays gated on
  debug mode, preserving the quiet UI behavior. ANSI escapes and `\r`
  are stripped before writing. Write failures are swallowed — the agent
  loop must never die because the disk is full or `~` is read-only.
- `agent/loop`: replaced all 11 `if (config.debug) console.error(...)`
  blocks with `logger.warn` / `logger.info` / `logger.error`. Wired
  `setDebugMode(config.debug)` once at session start. Diagnostics now
  show up in `franklin logs` regardless of debug flag.
- `stats/audit`: added 10k-entry retention to `franklin-audit.jsonl`.
  Trim is amortized — checked every 200 appends, gated on a cheap
  size probe (skip rescan when file < 2 MB) before re-reading. Exported
  `enforceRetention()` so admin tooling and tests can force a
  compaction. Pattern matches the existing 500-record cap on
  `failures.jsonl` and 1000-history cap on `franklin-stats.json`.

## 3.15.10 — Detect and stash secrets pasted into chat

User pasted a real GitHub PAT (`ghp_…`) into chat as a way to give
Franklin authenticated GitHub access. The model correctly refused to
use the raw value, but by then the token had already entered the LLM
request body, the persisted session file on disk, and any later
compaction summary. Refusing to *use* a secret isn't the same as
protecting it; the value still leaked.

- `secret-redact`: new module with conservative regex patterns for
  GitHub PAT / OAuth / app / fine-grained, Anthropic API, OpenAI
  project + legacy keys, AWS access key ID, Google API key, Slack
  bot/user/app, Stripe live + test, Twilio account SID, PEM private
  keys, and Ethereum-style private keys (when prefixed by
  `private_key:`-style label). Each pattern has a unique prefix +
  length so false positives stay rare — pasting a hex hash or a
  random base64 blob won't trigger.
- `loop`: at the user-input boundary, before the message reaches
  history / persistence / the model, run `redactSecrets` and replace
  matches with `[REDACTED:label]`. Detected values are stashed on
  `process.env` under predictable names (GITHUB_TOKEN,
  ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID, etc.) so subsequent Bash and
  WebFetch tool calls can still reference them via `$GITHUB_TOKEN`.
  The user keeps the convenience of "remember this credential"
  without the chat-history exposure.
- `loop`: emit a prominent warning when redaction fires —
  description + 4-char preview (never the value), the env var to
  reference, and rotation guidance. Existing exports in the user's
  shell are preserved (no silent clobber).

## 3.15.9 — Grounding-retry tool domain validation; reasoning_content classifier

User report: a real-estate "can I lowball 20%" turn was correctly
flagged as ungrounded (it cited specific $/sqft figures), but the
grounding evaluator's tool suggestion came back as `TradingMarket` (a
crypto-only tool). Franklin then announced "forcing tool use
(TradingMarket) and retrying..." — useless on a housing question.
Cause: the cheap evaluator model defaults to the first tool listed in
the prompt; TradingMarket was first.

- `evaluator`: rewrote the tool-picking section. WebSearch is now the
  named default for any factual claim; specialized tools (Trading*,
  DefiLlama*, SearchX, ExaAnswer) get explicit "ONLY when domain
  matches" rules and concrete anti-pattern examples (real-estate →
  WebSearch, NOT TradingMarket; stock ticker → WebSearch, NOT
  TradingMarket; etc).
- `loop`: domain validation gate before pinning a forced tool. The
  retry path now only pins a specialized tool when the user prompt
  contains domain keywords (BTC/ETH/swap for trading tools, @handle/
  twitter for SearchX, image/video/music for gen tools); otherwise
  falls back to "any" tool and lets the smart generator pick from
  available tool descriptions.
- `error-classifier`: new bucket for `reasoning_content` /
  `thinking mode must` / `message format incompatible` errors from
  the BlockRun gateway. These are NOT transient — they signal that
  the conversation history's thinking-block shape is incompatible
  with the current model. Suggestion now points users at /clear (the
  actual fix: drop polluted history) instead of /model. Pairs with
  the gateway's classifyAnthropicError fix that started returning
  proper 400s for this class of error.

## 3.15.8 — WebFetch: short-circuit known anti-bot domains

Reported: a "what's the Austin housing market doing" turn climbed to
step 12 because the agent kept retrying Zillow URLs (every variant
returns 403), burning step budget and user money on requests that
were never going to succeed.

- `WebFetch`: pre-flight block list. Hostname matched against a curated
  table of domains that systematically reject scripted GETs (zillow,
  redfin, realtor, linkedin, instagram, facebook, x.com, twitter,
  tiktok, reuters, bloomberg, wsj). Match returns one actionable error
  naming the right alternative tool (WebSearch, or SearchX for X.com)
  instead of fetching at all. The model sees a hard "don't retry,
  switch tools" signal in one step.
- `WebFetch`: post-flight 403/429/503 hint. For domains not on the
  static list, surface "X likely blocks automated fetch — try
  WebSearch" alongside the HTTP status so the model has the same
  course-correction prompt without us needing perfect prior knowledge
  of every blocked surface.

## 3.15.7 — Visible retry detail; auto-switch on persistent 5xx

When the gateway 5xx'd, users saw four identical "Retrying (X/5) after
Server error" lines and no idea which model was failing or what the
upstream actually said. Then Franklin gave up after 30+ seconds of
exponential backoff on the same dead provider.

- `loop`: retry message now includes the model name and a 100-char
  slice of the actual upstream error.
  `*Retrying 1/5 on anthropic/claude-opus-4.7 — Server: HTTP 503 Service
  Unavailable*` instead of `*Retrying (1/5) after Server error...*`.
- `loop`: server-error streak guard. When the same model 5xx's twice
  in a row on a routed request (Auto profile), break out of the retry
  loop and switch to the next model in the routing fallback chain
  instead of burning all 5 backoffs on the same upstream incident.
  Mirrors the existing payment-failure auto-fallback. Skipped when the
  user picked a concrete model — explicit choice isn't second-guessed.

## 3.15.6 — DeepSeek V4 catalog refresh; Auto-only routing

Tracks the BlockRun gateway's 2026-05-03 DeepSeek V4 launch (V4 Pro paid +
V4 Flash free) and collapses three routing profiles into one. Three
indecisive profiles (Auto / Eco / Premium) implied "we couldn't pick"; V4
Pro on launch promo makes Auto cheap and capable enough to span both ends.

- `pricing`: added `deepseek/deepseek-v4-pro` (75% launch promo $0.50 in /
  $1.00 out per 1M tokens through 2026-05-31, list $2.00/$4.00 after).
  Re-priced `deepseek/deepseek-chat` and `deepseek/deepseek-reasoner` to
  $0.20/$0.40 (down from $0.28/$0.42) and bumped their context window
  from 64K → 1M to match the gateway's V4 Flash re-aliasing.
- `picker`: surfaced V4 Pro under 🔬 Reasoning (highlighted with "promo"
  tag), V4 Flash (free) under 🆓 Free as the new default, relabeled
  "DeepSeek V3" → "DeepSeek V4 Flash Chat" and "DeepSeek R1" → "DeepSeek
  V4 Flash Reasoner". Hid Minimax M2.7 from the picker (shortcut still
  works) to keep the list under 24 entries.
- `router`: AUTO now uses V4 Pro as the SIMPLE + MEDIUM primary, with
  Sonnet / GPT-5.5 / Gemini 3.1 Pro as paid fallbacks. Opus stays the
  COMPLEX + REASONING primary. V4 Pro slots into REASONING fallback for
  cost-sensitive deep-reasoning paths.
- `router`: retired the `blockrun/eco` and `blockrun/premium` routing
  profiles. Auto already spans cost+quality. `parseRoutingProfile()` now
  maps both legacy strings to `'auto'` so old configs and saved sessions
  keep working — no breaking change for existing callers.
- `picker`: 🧠 Smart routing category now contains only Auto. `eco` /
  `premium` / `smart` shortcuts still resolve through to Auto.

## 3.15.5 — Quieter agent voice; YouTube transcripts; visible auto-compaction

UX polish driven by a real session log: the model narrated every step
("Let me check X...", "Now I have...", "Okay, now I..."), another-language phrases leaked
into a localized reply, three pasted YouTube URLs returned 32 tokens of
"can't access YouTube", and a 215K→9K context drop between turns had
no explanation.

- `system-prompt`: removed an internal contradiction. The Output
  Efficiency section said "do not narrate" while Tone & Style said
  "use a period not a colon" with the same example — models followed
  the latter and narrated freely. New rule explicitly bans pre-tool
  phrases ("Let me read...", "Let me first...", "Okay, now I...") and adds a
  language-consistency rule so private reasoning in another language
  ("d'accord", "OK now") doesn't leak into user-facing text.
- `WebFetch`: detects YouTube URLs (`youtube.com/watch`, `youtu.be`,
  `youtube.com/shorts`) and fetches the auto-caption transcript
  directly via `ytInitialPlayerResponse`. No external dependencies, no
  yt-dlp shellout. Replaces the old failure mode where YouTube URLs
  returned a JS bundle and the model gave up.
- `router`: YouTube and X/Twitter URLs now count as agentic-URL
  signals, so prompts like "summarize these three videos" no longer
  drop to a SIMPLE-tier text-only model that can't fetch.
- `loop`: auto-compaction now emits a visible
  `🗜 Auto-compacted: ~215K → ~9K tokens (saved 96%)` line. Previously
  it ran silently and made the next turn's footer look like a metric
  bug.

## 3.15.4 — Better routing for fact questions; richer turn footer

UX/quality fixes from a real session where Franklin sent a "best
subreddit?" question to a SIMPLE-tier model with no web tool, the
model fabricated a subscriber count, and the post-hoc grounding check
had to flag it.

- `router`: new `RESEARCH` signal (`+0.30` score). Detects fact-lookup
  intent — `who is`, `when was`, `best`, `top`, `compare`, `latest`,
  `current`, `members`, `price of`, plus localized equivalents. Pushes
  these prompts to a tier with WebSearch in its toolset instead of
  letting a cheap text-only model guess. Removed `who is` / `when was`
  / `capital of` / `how old` from `SIMPLE_KEYWORDS` for the same reason.
- `evaluator`: rewrote the post-hoc grounding warning. Old wording
  ("re-run with the suggested tools, or disable with `FRANKLIN_NO_EVAL=1`")
  put the burden on the user and exposed the quality gate's escape
  hatch. New wording names the gap ("Unverified answer") and offers a
  concrete next action ("Reply 'verify'"); env-var opt-outs no longer
  appear in user-facing text.
- `ui`: turn footer now shows `· ctx 23%` (yellow at 50%, red at 80%)
  so users can see context growth between turns. Footer also renders
  `[direct]` when `tier` is undefined — disambiguates "user picked a
  concrete model" from "metadata bug".

## 3.15.3 — Preserve terminal scrollback; dock dialogs to bottom

Bug fix: Ink's `clearTerminal` escape (`\x1b[3J`) wipes the entire
terminal scrollback buffer, and Ink fires it whenever the dynamic
region exceeds the terminal height. Franklin's streaming response and
model picker routinely tripped that threshold, so users could only
scroll up through the most recent slice of session history.

- `ui`: cap streamText render to the last `(rows - 12)` lines with an
  "↑ N earlier lines" indicator. Full text is still committed to
  `<Static>` at turn end, so scrollback retains every word once the
  turn finishes.
- `ui`: window the model picker around `pickerIdx` to a viewport of
  `(rows - 12)` rows with "↑/↓ N more" markers — same overflow pattern
  was nuking history when the picker opened on a small terminal.
- `ui`: hide `expandableTool`, `responsePreview`, and `InputBox` while
  a permission/askUser dialog is active. The dialog now docks to the
  bottom of the screen instead of stranding stale UI below it.

## 3.15.2 — Block foreground Bash poll-loops; route to Detach

Bug fix: a single Bash call with `sleep N` inside a for/while/until
loop blocks the agent for the full poll duration and looks frozen to
the user — the same status line repeats with no way to course-correct
short of Ctrl+C. This was the antipattern behind the "Franklin got
stuck on Apify polling" report.

- `tool-guard`: detect `for|while|until` + `sleep [1-9]` in foreground
  Bash and reject with concrete guidance (use `Detach`, the upstream
  sync endpoint, or per-poll discrete calls). `run_in_background:true`
  bypasses the block.
- `Bash` description: explicit "do not write sleep+loop in foreground"
  rule with the three correct alternatives.
- `Detach` description: call out polling external async jobs (Apify,
  video gen, deploys) as a primary use case.

## 3.15.1 — Don't kill WebFetch on agent-input errors

Bug fix: the per-tool kill-switch in `SessionToolGuard` counted any
`isError: true` toward the disable threshold, including HTTP 4xx
responses. So three guessed URLs (e.g. 3× HTTP 404 on a hallucinated
ToS path) would permanently disable WebFetch for the rest of the
session — even though the tool worked correctly each time.

Switched to circuit-breaker semantics:
- Only tool-class failures (network, timeout, parse) count toward
  the disable threshold.
- HTTP 4xx/5xx, invalid URLs, and user aborts are agent-input
  errors and no longer trip the breaker.
- A successful call resets the counter.

Tests cover the 4xx path, the network-failure regression, and
reset-on-success.

## 3.15.0 — Base0xGaslessSwap (user pays NO ETH for gas)

New tool: **\`Base0xGaslessSwap\`** — Base swaps where the user signs only
EIP-712 typed data (offline, no on-chain action), and 0x's relayer
broadcasts the trade and pays gas. **The user holds zero ETH.** Major
UX win for Base users who only have USDC.

Flow:
1. \`GET /v1/zerox/gasless/quote\` — returns \`trade.eip712\` + optional \`approval.eip712\`
2. User signs the trade typed-data locally with viem.
3. If approval is required AND the input token supports Permit (USDC,
   DAI), user signs the approval typed-data too. If the token doesn't
   support Permit (USDT etc.), the tool errors with "use Base0xSwap
   instead" rather than silently falling back to a paid on-chain
   approve.
4. \`POST /v1/zerox/gasless/submit\` — submit signed objects.
5. \`GET /v1/zerox/gasless/status/{tradeHash}\` — poll until confirmed
   (60-second hard ceiling); returns BaseScan link.

Limitations (gracefully surfaced when hit):
- Sell token must support Permit (USDC and DAI on Base; not USDT).
- ETH-input is native — use \`Base0xSwap\` for that.
- 0x relayer reserves the right to throttle / reject under congestion;
  poll loop returns "still pending after 60s" message in that case.

Three Base swap tools now coexist (the agent picks based on user's
wallet state):
- \`Base0xQuote\` — read-only price check.
- \`Base0xSwap\` — Permit2 path; user pays ETH gas; supports any token.
- **\`Base0xGaslessSwap\`** — gasless path; zero ETH needed; Permit
  tokens only.

Companion gateway commit: \`blockrun:7c53aa5 feat(zerox)\` adds the
gasless endpoints to the gateway.

Updated \`src/agent/context.ts\` trading playbook with a "pick the right
tool" guide so the agent routes the user correctly. Symbol shortcuts
unchanged across all three tools (ETH, WETH, USDC, USDT, CBBTC, CBETH,
AERO, DAI).

263/263 vitest, build clean.

## 3.14.1 — drop x402 fee on /v1/zerox; rely purely on on-chain affiliate

Per user direction: simpler revenue model. The per-call $0.001 USDC
gateway fee added in v3.14.0 is removed. \`/v1/zerox/{price,quote}\`
becomes a free public passthrough; revenue is only the on-chain 20 bps
affiliate (still force-set server-side). Cleaner UX (no x402 round
trip on every quote), simpler accounting, lower friction for casual
swap exploration.

Trade-off: quote calls are now free for anyone hitting the gateway.
The "value capture" is purely at swap-execution time via the affiliate
fee — same as Phantom Wallet's economics. Lookers (people who quote
without swapping) cost us nothing to serve and spend nothing on us.

Companion gateway commit: blockrun's \`/v1/zerox/[...path]/route.ts\`
now skips x402 verify/settle, just proxies to 0x with our key.

In Franklin: \`gatewayGet()\` replaces \`gatewayGetWithPayment()\` in
\`src/tools/zerox-base.ts\` — straight \`fetch\` call, no payment
signing. The Solana / Base wallet imports for x402 signing dropped.

## 3.14.0 — Base 0x routes through BlockRun gateway (no user signup)

v3.13.x required each Franklin user to register at dashboard.0x.org
and supply their own \`ZERO_EX_API_KEY\`. v3.14.0 routes \`Base0xQuote\` /
\`Base0xSwap\` through BlockRun gateway's new \`/v1/zerox/{price,quote}\`
endpoints — the 0x API key lives server-side as gateway env, never
reaches users.

User experience: zero setup. Run \`franklin\`, ask "swap 0.001 ETH for
USDC on Base", confirm — done.

Two revenue layers per swap (both flow to BlockRun treasury
\`0xe9030014F5DAe217d0A152f02A043567b16c1aBf\`):
1. Per-call gateway fee — $0.001 USDC via x402 (settled to treasury at
   every quote/swap call)
2. On-chain affiliate fee — 20 bps of \`sellAmount\` via 0x's
   \`swapFeeRecipient\` mechanism (settled at swap execution)

The gateway force-overrides \`swapFeeRecipient\` / \`swapFeeBps\` /
\`swapFeeToken\` server-side, so every gateway-routed swap pays the
on-chain affiliate to BlockRun regardless of caller-supplied
parameters.

**ToS posture (Phantom Wallet model):** 0x's "Monetize Your App" guide
treats this as the intended app-developer integration pattern. BlockRun
is the registered 0x App; Franklin users are end users of that App.
This is the same model Phantom and Coinbase Wallet use. We will pursue
an explicit distributor agreement with 0x once volume crosses the free
tier ceiling (10 req/s).

The legacy user-supplied-key path (\`ZERO_EX_API_KEY\` env or
\`zerox-api-key\` config from v3.13.1) is no longer wired; v3.14.0 strictly
goes through the gateway. If the gateway \`/v1/zerox/*\` returns 503 (key
not configured server-side), the swap tools surface that clearly so
the operator can fix the gateway env, not the user.

Companion gateway commit: \`84333cf feat(zerox)\` adds the
\`/v1/zerox/{price,quote}\` endpoints + force-affiliate proxy.

263/263 vitest, build clean.

## 3.13.1 — persist 0x API key in franklin config (no env var needed)

v3.13.0 required users to set \`ZERO_EX_API_KEY\` as an env var per
session. v3.13.1 lets it live in \`~/.blockrun/franklin-config.json\`
once, persisted across launches:

\`\`\`bash
franklin config set zerox-api-key zx_...
franklin   # no env var needed; Base swaps just work
\`\`\`

Lookup precedence: \`ZERO_EX_API_KEY\` env var → \`zerox-api-key\` config
→ undefined (clear setup-instruction error).

Same change for \`base-rpc-url\` (override default public Base RPC) —
\`franklin config set base-rpc-url https://...\`.

The error message users see when no key is set has been updated to
mention both options (config + env), so the agent can surface either
path depending on the user's preference.

No behavior change for users who already had \`ZERO_EX_API_KEY\` env;
config takes effect for users who run the new \`config set\` command.

## 3.13.0 — Base trading via 0x V2 (Permit2 + on-chain affiliate fee)

Franklin can now swap on **Base** the same way it swaps on Solana: a
local tool call, a user-signed transaction, on-chain affiliate fee
routing to BlockRun. Same posture as JupiterSwap (v3.12.1) — different
chain, different aggregator.

**Two new tools:**

- **\`Base0xQuote\`** — read-only price quote for a Base DEX swap via
  0x V2. Returns sell/buy amounts, rate, minimum-received, route, and
  the affiliate fee that would apply. Free.
- **\`Base0xSwap\`** — full quote → AskUser confirm → Permit2 sign →
  submit raw tx → BaseScan link. 20 bps affiliate fee on the sell
  token routes to BlockRun's existing Base wallet on-chain.

**Pre-mapped symbols:** ETH (native), WETH, USDC, USDT, CBBTC, CBETH,
AERO, DAI. Raw \`0x…\` addresses pass through.

**Architecture (per official 0x V2 Permit2 example):**

1. Tool reads the user's existing Base keypair via \`@blockrun/llm\`'s
   \`getOrCreateWallet()\`.
2. Calls \`https://api.0x.org/swap/permit2/{price,quote}\` with
   \`swapFeeRecipient=BLOCKRUN_BASE_AFFILIATE\`,
   \`swapFeeBps=20\`, \`swapFeeToken=<sell token>\`.
3. For ERC-20 sell tokens, ensures Permit2 has an allowance (one-time
   per token; auto-approves \`maxUint256\`). Native ETH skips this.
4. Signs the \`permit2.eip712\` typed data with viem's
   \`signTypedData\`.
5. Appends \`<sigLen-32B-BE><signature>\` to \`transaction.data\` per
   the canonical 0x recipe.
6. ERC-20 path: \`signTransaction\` + \`sendRawTransaction\`. Native
   ETH path: \`sendTransaction\` with \`value\`.
7. Returns BaseScan link.

**Setup the user does (one-time):**

\`\`\`bash
# Each Franklin user gets their own free 0x key (10 req/s, no credit card):
# 1. Sign up at https://dashboard.0x.org
# 2. Copy the API key from the Demo App
# 3. Add to shell config or run inline:
ZERO_EX_API_KEY=zx_... franklin
\`\`\`

**Why each user supplies their own key**: 0x's affiliate program
routes the basis-point fee to whatever address the swap-call specifies
(\`swapFeeRecipient\`), independent of which API key is making the
call. So users register their own free 0x account; BlockRun gets the
20 bps regardless. This is the pattern Phantom Wallet, Coinbase
Wallet, and other consumer wallets use — official 0x integrator
mechanism, not a workaround.

**Reuses v3.12.3 trading-hardening:** live-swap session cap,
large-swap warning, wallet-address-in-AskUser, insufficient-balance
error reframing — all carry over to Base unchanged.

**Optional env vars:**
- \`ZERO_EX_API_KEY\` — required. User-provided. Free at dashboard.0x.org.
- \`BASE_RPC_URL\` — optional. Defaults to \`https://mainnet.base.org\` (public).
- \`FRANKLIN_LIVE_SWAP_CAP\` / \`FRANKLIN_LIVE_SWAP_WARN_USD\` — same as v3.12.3.

263/263 vitest, build clean.

## 3.12.3 — trading v1 hardening (playbook prompt + wallet UX + safety cap)

Three pre-launch fixes to take Franklin's trading from "code shipped"
to "production-ready v1." None of them change the JupiterSwap or
DefiLlama integrations themselves — they're all guardrails and UX.

**1. Trading playbook in the system prompt.**
New \`getTradingPlaybookSection()\` block in \`src/agent/context.ts\` tells
the agent how to use the trading tools correctly: quote-before-swap
pattern, reject \`priceImpactPct\` > 5 % unless explicit, large-swap
warning over $20 USD equivalent, no session-wide auto-approve, surface
the Solscan link, distinguish paper from live state, match the right
DeFiLlama tool to the question, etc. Mirrors the depth of the
existing X / Marketing playbook so trading isn't the underspecified
vertical anymore.

**2. Live-swap session safety cap.**
Defaults to 10 live swaps per Franklin process. Blocks the \`agent
buggy-loops a swap 50 times\` failure mode that the v3.11.0 turn-spend
removal opened up for trading specifically. Override via
\`FRANKLIN_LIVE_SWAP_CAP=20 franklin\` (or 0 to disable). Resets on
restart. Is *not* a per-turn $-cap — that's still gone — it's a hard
counter on irreversible on-chain events.

**3. Better wallet UX in JupiterSwap.**
- The "no wallet" error now reframes as a setup-action recommendation,
  not a stack-trace dump.
- The AskUser confirm prompt now includes a "⚠ Large swap warning"
  line above the configurable threshold (default $20, override via
  \`FRANKLIN_LIVE_SWAP_WARN_USD\`) when the input is a stablecoin we
  can price-check; falls back to "I cannot price-check the input in
  USD before signing" when it's not.
- The AskUser prompt also surfaces the wallet address up-front (so
  the user knows where to top up if they cancel for balance reasons)
  and the running session-swap counter (so they see the cap proximity
  in real time).
- After execution, "insufficient balance / lamports / TokenAccountNotFound"
  errors from \`/execute\` are detected and reframed: tells the user
  exactly which token to send, to which address, instead of dumping
  a Solana program error code.

## 3.12.2 — DefiLlama built-in tools (auto x402-paid, response-filtered)

v3.12.0 told the agent the gateway has \`/v1/defillama/*\` endpoints, but
didn't ship a way to actually call them with x402 payment headers
attached — \`Bash + curl\` would just hit the 402 wall. v3.12.2 closes
that gap with five built-in tools that handle the x402 dance the same
way \`ExaSearch\` / \`ExaAnswer\` already do.

Critically, the tools also **filter the response** before returning to
agent context. DefiLlama's raw payloads are 5–10 MB (3000+ protocols,
10000+ yield pools); dumping that wastes the entire context window.
Each tool takes filter / limit params and returns a ranked, formatted
summary instead.

New tools:

- **\`DeFiLlamaProtocols\`** \$0.005 — top-N protocols by TVL, filterable
  by category / chain / min TVL.
- **\`DeFiLlamaProtocol\`** \$0.005 — full TVL + chain breakdown for a
  single protocol slug.
- **\`DeFiLlamaChains\`** \$0.005 — TVL ranked by chain.
- **\`DeFiLlamaYields\`** \$0.005 — yield pools, filterable by symbol /
  chain / project / TVL / APY / stablecoin-only. Defaults to top-10 by
  APY with TVL > \$1M.
- **\`DeFiLlamaPrice\`** \$0.001 — batch token price lookup (DefiLlama
  syntax: \`coingecko:bitcoin\`, \`ethereum:0x...\`, \`solana:mint\`).

Each tool calls \`/v1/defillama/*\` on the BlockRun gateway, which is the
revenue surface — every \`DeFiLlama*\` call from any Franklin user
becomes a paid USDC transaction settled on-chain.

Updated \`getBlockRunApiSection\` prompt block to point the agent at the
five tools instead of the gateway URLs (and explicitly tell it NOT to
try \`Bash + curl\` against the gateway, which won't sign payments).

## 3.12.1 — Jupiter swap via Ultra + on-chain referral fee (ToU-clean redo)

v3.12.0 told the agent to call `/v1/jupiter/{quote,swap}` on the
BlockRun gateway. Re-reading Jupiter's Terms of Use revealed those
gateway routes were non-compliant — Jupiter's general ToU forbids
"permit any third party to access or use the Interface" at every
tier (free `lite-api.jup.ag` included), and the paid SDK License
Agreement is even stricter ("solely for Licensee's internal
development efforts"; explicit ban on key disclosure). Many Solana
wrappers in the wild ignore this; BlockRun's "trustworthy gateway"
positioning doesn't get to.

The legally-clean redo uses Jupiter's **own** monetization mechanism:
Jupiter Ultra Referral. The agent calls `lite-api.jup.ag/ultra/v1`
**directly from this Franklin process** (the user is the first-party
caller, not redistributing to third parties), embedding BlockRun's
referral identity (`DUGyfGMTAvyHtrvCa2qPE2KJd3qtGBe4ra7u6URne4xQ`) and
a 20 bps platform fee in every order. At settlement, Jupiter's
on-chain router transfers 0.2% of the swap output to BlockRun's
referral wallet. Same pattern Phantom + every legit Solana wallet
uses; explicitly endorsed by Jupiter Labs.

Two new tools:

- **`JupiterQuote`** — read-only price quote (free; no signing)
- **`JupiterSwap`** — quote → AskUser confirm → sign locally → submit
  via Ultra `/execute`. Returns Solscan tx link.

Symbol shortcuts pre-mapped: SOL, USDC, USDT, JUP, BONK, WIF, TRUMP,
PUMP. Raw mint addresses pass through.

Companion BlockRun gateway commit: `b0fbac2 revert(jupiter)` removes
the gateway proxy that violated Jupiter's ToU. Other Layer-1 wraps
(DefiLlama, Solana RPC) are unaffected and continue to serve x402
traffic — those upstreams have ToS-compliant redistribution
(DefiLlama is Apache 2.0; Solana mainnet-beta is public infra).

Updated `src/agent/context.ts:getBlockRunApiSection` to drop the
`/v1/jupiter/*` lines and point at the local `JupiterSwap` /
`JupiterQuote` tools instead.

## 3.12.0 — surface BlockRun gateway's new Trading & DeFi endpoints

BlockRun gateway just shipped Layer 1 of the trading-API marketplace —
five new paid endpoints across three legally-clean providers (open data
or public infrastructure, no resale-ToS violations):

- \`GET  /v1/jupiter/quote\`           \$0.001 — Solana DEX-aggregator price quote
- \`POST /v1/jupiter/swap\`            \$0.001 — build unsigned Solana swap tx (caller signs locally)
- \`GET  /v1/defillama/protocols\`     \$0.005 — every DeFi protocol with TVL
- \`GET  /v1/defillama/protocol/{slug}\` \$0.005 — single protocol details
- \`GET  /v1/defillama/chains\`        \$0.005 — TVL by chain
- \`GET  /v1/defillama/yields\`        \$0.005 — every yield pool (APY/TVL)
- \`GET  /v1/defillama/prices/{coins}\` \$0.001 — token price lookup
- \`POST /v1/solana/rpc\`              \$0.0005 — JSON-RPC passthrough to mainnet-beta

This release teaches Franklin's system prompt about all of them so the
agent routes traffic through the gateway instead of WebSearch / scraping
when a user asks "what's pumping on Solana", "swap X for Y on Jupiter",
"what's the APY on Aave USDC", "what's the SOL balance of address …".

No code changes — just a prompt-section update in
\`src/agent/context.ts:getBlockRunApiSection\`. Ship-first-light usage
funnel for the gateway's new revenue surface.

## 3.11.0 — remove per-turn spend cap (match Claude Code's wallet-trust default)

The `MAX_TURN_SPEND_USD` per-turn cap and the `max-turn-spend-usd`
config key are removed. v3.10.6 patched the cap's confusing
limit-reached message; this release removes the underlying feature.

The cap was originally introduced as a runaway-loop guard at $0.25
per turn (commit 562e1f0). It has only ever been **raised** since —
never lowered after a real incident:

- $0.25 → $1.00 (v3.8.42) because legitimate dashboard scaffolds
  routinely tripped it.
- $1.00 → $2.00 (v3.9.1) because COMPLEX-tier sonnet/opus planning
  passes regularly cross $1 in their first call.

Even at $2 it kept firing mid-task on real work and confusing users,
who were then nudged toward draining their wallet through the very
mechanism designed to prevent it. Anthropic's own Claude Code has no
equivalent ceiling and works fine, because the runtime catches
runaway loops with structural guards instead of an opaque $-cap. The
wallet itself is the ultimate ceiling — Franklin can never spend
more than the user funded.

The structural guards remain in place:

- \`MAX_TOOL_CALLS_PER_TURN = 25\` — hard \`break\` after 25 tool
  calls in one turn (\`src/agent/loop.ts:598\`).
- \`MAX_TINY_RESPONSES = 2\` — hard \`break\` after 2 consecutive
  responses with no tool_use and no meaningful text
  (\`src/agent/loop.ts:603\`).
- \`SAME_TOOL_WARN_THRESHOLD = 3\` — warn when the same tool is
  called 3+ times in a turn.
- \`readFileCache\` — dedupe Reads of the same path within a turn.
- Session-level \`config.maxSpendUsd\` — unchanged; batch/scripted
  callers can still pass it to bound a single run.

**Migration**

- Existing users with \`max-turn-spend-usd\` in
  \`~/.blockrun/franklin-config.json\`: the value is silently ignored.
  \`franklin config set max-turn-spend-usd <n>\` is now an error
  (unknown config key). Remove it with \`franklin config unset\` if
  you want a clean config — but leaving it does no harm.
- Skill authors: the \`{{per_turn_cap}}\`, \`{{spent_this_turn}}\`,
  and \`{{turn_budget_remaining}}\` placeholders are no longer
  substituted. Skills that reference them will render the literal
  placeholder text. The bundled \`budget-grill\` skill was rewritten
  to drop these placeholders and frame cost discipline against the
  wallet balance instead.

## 3.10.6 — turn-spend-limit message no longer reads as a UI prompt

The limit-reached message was confusing users into draining their
wallet. Old text:

> Raise the cap with \`franklin config set max-turn-spend-usd 4.0\`
> (or \`0\` to disable), then \`/retry\`.

The "(or \`0\` to disable)" parenthetical sits next to \`/retry\` and
reads like a single-keystroke choice. A user who hit the limit typed
\`0\` thinking it would disable the cap. \`0\` was sent as a new user
message, a fresh turn started (with the cap reset to its default
\$2), the agent kept its tool-loop going, and the wallet kept
draining.

New message lays out three labelled options on their own lines, with
an explicit warning that typing a bare number becomes a new prompt:

\`\`\`
⚠️ Turn spend limit reached (\$2.064 > \$2.00). Stopping to protect your wallet.

What to do next — pick ONE (do NOT just type a number, that becomes a new prompt):
  • Continue this turn:    /retry
  • Raise cap to \$4:       franklin config set max-turn-spend-usd 4
  • Disable cap entirely:  franklin config set max-turn-spend-usd 0   (then /retry)
\`\`\`

Also displays \`∞\` instead of \`Infinity\` when the cap is disabled.

## 3.10.5 — teach Franklin the BlockRun gateway API surface

Symptom: when asked to "test all BlockRun APIs", the agent guessed
endpoints from memory. It tried \`POST /v1/image/generate\` (singular,
404), claimed \`GET /v1/spending\` returned 200 (route doesn't
exist), and listed \`/v1/x/*\` routes that aren't on the gateway.

Root cause: Franklin's system prompt taught the agent how to use its
own *tools* (TradingMarket, ExaAnswer, etc.) but never taught it the
real gateway HTTP surface. With nothing to ground against, the agent
fell back to plausible-looking OpenAI-style guesses.

Fix: a new \`BlockRun Gateway API\` section in the system prompt
(\`src/agent/context.ts\`). It enumerates the actual routes —
\`/v1/chat/completions\`, \`/v1/messages\`, \`/v1/images/generations\`,
\`/v1/images/image2image\`, \`/v1/videos/generations\` (+ \`/{id}\` poll),
\`/v1/audio/generations\`, \`/v1/search\`, \`/v1/exa/...\`, the markets
endpoints (\`crypto/fx/commodity/usstock/stocks/{market}\`),
\`/v1/balance\`, \`/v1/models\`, \`/v1/health/*\`, \`/v1/modal/...\`,
\`/v1/pm/...\` — with request shapes, free-vs-paid annotation, and the
x402 auth flow. It also calls out three specific hallucinations to
avoid (\`/v1/image/generate\`, \`/v1/spending\`, \`/v1/x/*\`) and points
at the canonical discovery contracts (\`GET /openapi.json\`, \`GET
/.well-known/x402\`) as the source of truth when in doubt.

The agent now stops inventing routes — and a bare 402 on a POST is
correctly read as a working endpoint, not a bug.

## 3.10.4 — UI: kill ghost border lines on terminal resize

After a window resize, Franklin's input box would leave stacked
`╭────` fragments behind. Root cause: the terminal reflowed the long
border into multiple lines, but Ink only erased its previously
rendered row count, so the extra reflowed rows survived as ghost
output.

Fix: disable terminal autowrap (DECAWM, `\x1b[?7l`) when the Ink UI
mounts and restore it (`\x1b[?7h`) on unmount and on `process.exit`.
With autowrap off, layout stays fully under Ink's control — no
terminal-side reflow, no ghost rows. TTY-gated so non-interactive
runs are unaffected.

## 3.10.3 — gateway rate-limit unmasking + Solana ESM fix

Two independent bug fixes that surfaced in the same session.

### Gateway rate-limit errors leaking as 200-OK text

Some upstream providers (Anthropic in particular) returned per-day
TPM exhaustion as a single bracketed `[Error: Too many tokens per
day, please wait before trying again.]` text content block on a 200
OK response — not as an HTTP 429. Three things cascaded:

1. The loop persisted that text as the assistant's reply, poisoning
   history.
2. The grounding evaluator read it as a "tool-use refusal", forced a
   retry, hit the same wall, and showed a misleading "Grounding check
   failed" follow-up to the user.
3. `error-classifier` didn't match the wording, so even when the
   error did surface as an exception it fell through to Unknown and
   nothing recovered.

Fix: a new `looksLikeGatewayErrorAsText` detector in `loop.ts` —
when the entire assistant payload is a lone `[Error: ...]` text
block with no tool_use, throw it into the existing classifier path
instead of persisting and grounding-checking. `error-classifier`
gained the Anthropic-specific patterns ("too many tokens", "tokens
per day", "please wait before trying", "quota exceeded") and capped
rate-limit retries at 1 (a per-day quota won't clear in this
session). On rate_limit the loop now mirrors the payment-failure
fallback — mark the model failed for this turn and switch to the
next free non-Anthropic model (qwen / llama / glm) instead of
thrashing on the exhausted provider. `local-elo` learned a new
`'rate_limit'` outcome with a -K×1.2 penalty so the router
remembers to avoid the failing provider.

### `franklin setup solana` no longer throws under Node ESM

`franklin setup solana` was failing immediately with
`Dynamic require of "@solana/web3.js" is not supported`. Root cause
was upstream: `@blockrun/llm@1.6.2`'s ESM build wrapped a
CJS-style lazy `require()` inside `createSolanaWallet()` in
esbuild's `__require` shim, which throws on call. Fixed in
`@blockrun/llm@1.13.0` (now uses `await import()` for the optional
`@solana/web3.js` and `bs58` deps, matching the pattern already used
by `solanaPublicKey` and `solanaKeyToBytes`). Bumped the dep floor
to `^1.13.0`.

## 3.10.2 — UI gutter alignment

All assistant-side output now aligns to a single column-2 left edge.
Previously, tool results, the token footer, the input box's status row,
and the Permission/AskUser dialogs each used a different `marginLeft`
value (0, 1, 2, or 3), so the eye had to keep refinding the left edge
as the agent worked. The Permission/AskUser dialogs also had an
off-by-one between the rounded border (drawn via hardcoded leading
spaces inside the text) and the button row (drawn via `marginLeft`
prop), which put `[y][a][n]` one column inside the border instead of
flush with content.

Fix: agent output, dialog borders, dialog content, streaming preview,
and the input box's status row all share the same left gutter. The
input box itself stays full-width (column 0) — that's intentional, it's
the most prominent UI element. Pure visual change, no behavioral
impact.

## 3.10.1 — Tasks tab in the panel + CHANGELOG correction

### Tasks tab

`franklin panel` now has a "Tasks" tab next to Sessions / Wallet /
Insights. List view shows newest-first task rows with status badges
(succeeded green, running blue, queued gray, failed/lost red,
cancelled yellow), age, and a Cancel button on still-active rows.
Click a row → detail view with the full TaskRecord, last 10 events,
and a live log tail.

Polling is intentionally restrained — Task is a long-running concept,
and pushing real-time SSE for state that genuinely changes every 5+
seconds would burn cycles for no perceived benefit:

- **List view:** 10-second poll while the tab is visible. Pauses on
  Page Visibility API hidden / tab switch. Manual Refresh button.
- **Detail view log tail:** 2-second poll using `Range: bytes=N-`
  incremental fetches against `GET /api/tasks/:runId/log`. Stops as
  soon as the task hits a terminal status.

5 new endpoints under `/api/tasks/...` (list / get / log with Range /
events / cancel). Cancel is loopback-only.

### CHANGELOG correction

The v3.10.0 entry called the new agent tool the "Task tool" — but the
shipped tool is named `Detach` (the existing in-session task tracker
kept the `Task` name unchanged). Corrected references in the v3.10.0
entry to point at `Detach`. The CLI surface (`franklin task list /
tail / wait / cancel`) is unchanged.

## 3.10.0 — Detached background tasks (Detach tool + `franklin task` CLI)

The agent's job is to design and orchestrate. The for-loop is somebody
else's problem. v3.10 adds that somebody.

### What's new

- New **Detach** agent tool: `{ label, command }` → detached Bash child
  process spawned via `franklin _task-runner <runId>`. Returns a
  `runId` immediately. Survives the parent Franklin process — close
  your terminal, the work continues.
- New **`franklin task`** CLI surface:
  - `task list` — newest first, with status + age
  - `task tail <runId> [--follow]` — print log + final status
  - `task wait <runId> [--timeout ms]` — block until terminal
  - `task cancel <runId>` — SIGTERM the runner
- Persistence under `~/.franklin/tasks/<runId>/` (no new dependencies):
  `meta.json` (TaskRecord), `events.jsonl` (append-only event log),
  `log.txt` (child stdout/stderr).
- Lazy lost-task detection — `task list` checks `process.kill(pid, 0)`
  on still-`running` tasks and marks them `lost` if the backing pid
  is gone.
- System prompt updated to point long-task guidance at the new tool.

### Why

Franklin used to drag the LLM through every iteration of long work
(40k stargazer enrichment, large refactors, multi-page scrapes), one
tool call per item. That burned turns, hit TTFB walls (v3.9.6 raised
those defaults to 180s as a bandaid), and tied the work's life to the
foreground session.

The Detach tool inverts that: the LLM writes a script, hands it to
`Detach`, gets a runId, and is free. The script does the iteration with
a checkpoint file. Franklin restarts have no effect on the work.

### Out of scope (deliberate)

- `acp` / cron / multi-runtime — only `detached-bash` for now.
  Detached *agent loop* in subprocess is v3.11.
- sqlite migration — flat JSONL/JSON mirrors `src/session/storage.ts`,
  good enough for thousands of tasks. Switch if `task list` ever
  takes >100ms.
- Notification policy / multi-channel delivery — CLI-first single-user
  product polls. Add when we wire up Telegram/Discord adapters.

Reference: openclaw/openclaw `src/tasks/`. We took the persistence +
lifecycle skeleton, dropped channel/delivery and multi-runtime.

## 3.9.6 — Reasoning-model TTFB defaults + long-task guidance

A bandaid for the bigger problem (long agent loops on slow-TTFB models).
A real task subsystem comes in v3.10 — see the Tier-1 plan.

### Default request timeout 45s → 180s

`src/agent/llm.ts` and `src/proxy/server.ts` both used to cap *time-to-
headers* (the moment the gateway flushes SSE response headers, which
in practice equals the moment the upstream model emits its first
token) at 45 seconds. That number was set when the picker was
Claude/GPT-only — both have sub-second TTFB on warm prompts. With the
catalog now including reasoning-class models the 45s budget is
routinely too tight:

- `zai/glm-5.1` and other GLM thinking variants — 60–120s TTFB on
  cold prompts is normal.
- `nvidia/nemotron-3-nano-omni-*-reasoning` — emits chain-of-thought
  before the answer, similar latency profile.
- `openai/gpt-5-codex` / `o*` reasoning families — variable, often
  slow.
- Anthropic models with extended thinking enabled — likewise.

Worse, the error classifier only retries timeouts once with the same
budget, so a slow reasoning model would hit the 45s wall, retry
(also 45s), and surface "Request failed · Timeout" — burning USDC on
both attempts even though the model would have answered fine given
~90s.

180s is generous for any realistic TTFB and still bounded enough that
genuinely dead requests fail within ~6 min (request × 1 retry).
Override via `FRANKLIN_MODEL_REQUEST_TIMEOUT_MS=<ms>` /
`FRANKLIN_PROXY_REQUEST_TIMEOUT_MS=<ms>` per-session.

Stream-idle timeout (per-chunk silence watchdog) stays at 90s — that
budget catches genuinely stalled SSE connections and bumping it would
mostly just delay error surfacing.

### Long-task system-prompt guidance

`agent/context.ts:getToolPatternsSection` now includes a "Long-running
iteration (>20 items)" bullet that tells the agent: don't loop in the
turn-by-turn agent for paginated work — write a script with a
checkpoint file, run it once via Bash, re-engage only on errors or
completion. The motivation is the same case that prompted the
timeout bump: a 40k-item enrichment task asking GLM-5.1 to be the
for-loop rather than the orchestrator means 40k tool turns + 40k
chances to hit a TTFB wall.

This is a soft nudge in the system prompt, not a hard policy. v3.10
is expected to harden this with a real `franklin task` subsystem
(sqlite-backed TaskRecord, detached subagent runtime, `task list /
tail / cancel / wait` CLI) — modelled on the `src/tasks/` layer in
the upstream openclaw/openclaw repo.

## 3.9.5 — Nemotron Omni prose stripping + gpt-image-2 size pin

Two robustness fixes — one for a free-model leakage pattern, one for a
paid-image-gen timeout pattern.

### Nemotron Omni reasoning prose stripped

`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` emits chain-of-thought
as plain text *without* `<think>` tags, so the existing think-tag
stripper can't catch it. The reasoning prose gets concatenated directly
with the answer, often without a separator — e.g.
`...Just output the tokenOMNI_E2E_OK`. Before this release, that
preamble appeared verbatim in the agent transcript and polluted the
next turn's history.

New `nemotron-prose-stripper.ts`: a heuristic detector recognizing 12+
reasoning openers (`The user asks:`, `Looking at:`, `We must:`,
`I'll/I need to:`, `Let me:`, …) and answer-introducer phrases
(`just output:`, `the answer is:`, `here's the response:`, `output:`,
…). Splits on the **last** introducer match. Conservative fallback:
when reasoning is detected but no introducer is found, leaves the text
intact rather than swallow a possible real answer.

`llm.ts` forces hold-mode for `nvidia/nemotron-3-nano-omni-*` so
streamed text is buffered. At end-of-stream finalize (both
`content_block_stop` and the post-loop flush sites), it runs the
stripper, routes the matched preamble to the thinking channel, and
pushes only the cleaned answer to `collected` — keeping reasoning out
of dialogue history on the next turn.

8 new unit tests cover the real e2e leak, the colon-introducer
pattern, multiple-introducer (takes the last), conservative
passthroughs (no-reasoning input untouched, reasoning-without-
introducer untouched), empty input, and the model-id matcher.

### `openai/gpt-image-2` pinned to 1024x1024

The BlockRun gateway reliably serves `openai/gpt-image-2` only at
1024x1024 — `1792x1024` and `1024x1792` time out before returning,
which means the request still costs USDC (x402 settled) but the user
gets nothing. The router and the `size` field both used to let the
caller request unsupported sizes.

`tools/imagegen.ts` now overrides `imageSize` to `1024x1024` whenever
the resolved model is `openai/gpt-image-2`, regardless of caller or
router input. The override runs **after** the AskUser flow (so router
escalation to gpt-image-2 still gets pinned) and **before** the
content-budget check (so the budgeting cost matches what we actually
send). The schema description for `size` now spells out the
constraint so the LLM stops trying to pass other dimensions. Other
image models — `gpt-image-1`, the Gemini variants, Grok Imagine — are
unaffected and still honor caller-supplied sizes.

## 3.9.4 — Roleplayed JSON tool-calls + V4 Flash / Omni metadata

Two free-model fixes plus a catalog refresh.

### Roleplayed JSON tool-calls handled

Some free models (notably nemotron, qwen, deepseek variants under
load) occasionally emit a raw JSON function-call object as text
instead of using the proper tool-call channel — e.g. the model
streams `{"type":"function","name":"Wallet","parameters":{}}` as a
text segment. Before this release, that JSON appeared verbatim in
the agent transcript, the tool was never actually invoked, and the
loop either hung waiting for a tool result that wasn't coming or
kept echoing the JSON on every retry.

Now, `ModelClient` runs a small state machine over each text segment.
The first non-whitespace character decides:

- Starts with `{` → **hold** the text without streaming, then check
  the full segment against `isRoleplayedJsonToolCallText()` once the
  turn completes.
- Anything else → **stream** normally.

If the held text parses as `{ type: "function", name: "...",
parameters|arguments: ... }`, it's discarded as non-productive and
the recovery layer can switch models. Otherwise the held text is
flushed into the transcript so legitimate JSON answers (e.g. "give
me this object as JSON") still render.

The `interactiveSession()` system prompt also names the failure mode
explicitly — including a "if the user asks you to echo a token,
echo it as plain text; don't call Wallet" clause — so the better
free models stop doing it in the first place.

### V4 Flash + Nemotron Omni metadata

`MODEL_PRICING` and `MODEL_CONTEXT_WINDOWS` now include:

- `nvidia/deepseek-v4-flash` — 1M context, $0/$0
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` — 256K context, $0/$0

Both are available on the BlockRun gateway free tier. No new shortcut
or picker entry yet — pass the full ID until a follow-up release adds
the `v4-flash` / `omni` shortcuts.

`nvidia/deepseek-v4-pro` is intentionally not listed: NVIDIA's NIM
deployment is hung and the BlockRun gateway transparently redirects
V4 Pro requests to V4 Flash, so the entry would be misleading from
the CLI side.

### `franklin start` derives "free" from pricing

The hardcoded `FREE_MODELS` Set in `commands/start.ts` is replaced
with a `MODEL_PRICING` lookup (`input === 0 && output === 0 &&
perCall ?? 0 === 0`). Adding a new free entry to `pricing.ts` is now
enough — no second list to keep in sync — and the new V4 Flash + Omni
entries are recognized as free out of the box.

### Tests

`free-model-matrix.mjs` now also rejects raw JSON function-call
objects in stdout, so a regression on the new state machine surfaces
as a model-matrix failure instead of as a runtime hang.

## 3.9.3 — `/model` picker trim

The `/model` picker had 28 visible entries across six categories. Most
sessions use 4–6 models in practice, and the long list created decision
paralysis without giving any user real new choice — the dropped entries
were either superseded by a same-family successor, an awkward middle
trim that nobody picks because the row above or below dominates it, or
a niche-premium tier ($30/$180) that belongs to power users who already
know its name. Picker now lists 23 entries; the trimmed shortcuts stay
live in `MODEL_SHORTCUTS` so muscle memory still works for users who
type the name directly.

### Removed from the visible picker

- **Premium frontier:** Claude Opus 4.6 (Opus 4.7 strictly better),
  GPT-5.4 (5.5 is flagship, 5.3 Codex is in Reasoning), GPT-5.4 Pro
  (niche $30/$180), Grok 3 (Grok 4 + Grok-fast cover it).
- **Reasoning:** O1 (O3 strictly replaces), O4 Mini (O3 covers, plus
  Grok-fast for cheap reasoning).
- **Budget:** GPT-5 Nano (GPT-5 Mini covers the cheap-OpenAI slot,
  DeepSeek V3 is cheaper still for the absolute floor).

### Still works

`franklin --model opus-4.6 / gpt-5.4 / gpt-5.4-pro / grok / o1 / o4 /
nano` and the matching proxy aliases all resolve unchanged. Pricing
entries for hidden models stay in `src/pricing.ts` so historical
session-cost records keep computing — same pattern PR #33 used for
retired free-tier models and v3.9.2 used for Kimi K2.5.

### Tests

4 new local tests lock in: hidden entries are absent from the picker
list, hidden-model shortcuts still resolve, hero shortcuts still in the
visible list, total entry count stays in the 22–24 band.

## 3.9.2 — Kimi K2.6 alignment with the gateway

The BlockRun gateway now exposes Kimi K2.6 with a 65K `max_output` cap and
has retired the K2.5 endpoint that Franklin's picker still listed as a
"legacy" option. Without this update K2.6 was capped at Franklin's default
16K output (4× headroom on the table for long-form coding output) and
users picking the K2.5 shortcut got routed to a model the gateway no
longer serves.

### Changed

- **`moonshot/kimi-k2.6` max output bumped 16K → 65K.** Mirrors the
  gateway's `max_output: 65536`. Long dashboard scaffolds, multi-file
  refactors, and other workloads that exhausted the implicit 16K default
  now get the full headroom on a single response.
- **`kimi-k2.5` and `k2.5` shortcuts now resolve to `moonshot/kimi-k2.6`**
  in both the agent picker and the proxy alias table. Same pattern used
  for retired NVIDIA free-tier models in v3.9.0 — muscle memory keeps
  working without surprise routing through a paid fallback.
- **`Kimi K2.5 (legacy)` removed from the `/model` picker.** The K2.5
  pricing entry stays in `src/pricing.ts` so historical session-cost
  records keep computing correctly, consistent with how the picker
  treats other gateway-retired models.

## 3.9.1 — Status bar shows chain + per-turn cap raised to $2

User-visible follow-ups to v3.9.0. Two friction points users hit on real
coding sessions: the status bar didn't say which chain the displayed
balance was on, and the per-turn spend cap was tight enough that complex
coding tasks routinely tripped it mid-plan.

### Changed

- **Status bar shows chain + wallet tail.** The input-bar status line now
  appends `· <chain>:<wallet-tail>` after the balance — e.g.
  `auto · $0.05 USDC · sol:KaH` instead of the previous
  `auto · $0.05 USDC`. Chain is colored magenta to make the chain label
  scan-glanceable; the trailing 4 chars of the wallet address help
  disambiguate multiple installations on the same chain. To see the
  balance on the other chain, run `franklin setup <chain>` or set
  `RUNCODE_CHAIN=base|solana` in the environment.
- **Default per-turn spend cap raised from $1.00 → $2.00.** Real coding
  turns — full dashboard scaffolds, multi-file refactors that pull in
  sonnet/opus on a COMPLEX-tier route — routinely crossed $1.00 in their
  first planning pass alone, leaving no headroom for the execution call
  and tripping the cap mid-task. $2.00 keeps the runaway-protection
  promise (catches the buggy-loop drain v3.8.41's retry-policy targets)
  while letting a legitimate complex coding task finish in one turn.
  The recovery hint in the cap-trip message also updated from
  `franklin config set max-turn-spend-usd 2.0` → `… 4.0`. Users who set
  their cap explicitly (and Franklin sees a `max-turn-spend-usd` value in
  config) keep their explicit value; only the no-config-set default
  changes.

## 3.9.0 — Skills MVP (Phase 1) + first-class Wallet tool + balance retry

First minor bump since v3.8.0. Two themes: (1) Franklin learns to load
Anthropic-compatible `SKILL.md` files as wallet-aware slash commands, and
(2) wallet status becomes a first-class tool + the status-bar lock-at-zero
bug is fixed.

### Added

- **Skills (Phase 1).** Franklin natively reads Anthropic-spec
  `SKILL.md` files as prompt-rewrite slash commands. Bundled-only this
  release; user-global and project-local discovery land in Phase 2.
  - `src/skills/{loader,registry,invoke,bootstrap}.ts` — frontmatter
    parser (Anthropic spec keys + Franklin extensions `cost-receipt` and
    `budget-cap-usd`), conflict resolution (project > user > bundled,
    first-wins tiebreaker), and pure dispatch via `matchSkill()` and
    `substituteVariables()`.
  - **Wallet variable injection.** Skill bodies can reference
    `{{wallet_chain}}`, `{{per_turn_cap}}`, `{{spent_this_turn}}`, and
    `{{turn_budget_remaining}}`; Franklin substitutes them at slash-
    command time. Unknown variables stay literal so future variables
    don't break old skills.
  - `src/skills-bundled/budget-grill/SKILL.md` — first wallet-flavored
    bundled skill: a grilling session where every option is framed in
    USDC cost terms.
  - `franklin skills [list|which <name>] [--json]` CLI for inspection.
  - `/help` now shows a Skills block when the registry is non-empty.
- **Wallet tool.** New first-class read-only `Wallet` capability in
  `CORE_TOOL_NAMES` returns chain + address + USDC balance in a single
  zero-arg call. The system prompt steers "balance / wallet balance / wallet
  status" questions there explicitly so they no longer detour through
  Bash + `franklin balance` + parse, which was burning ~13K input tokens
  per natural-language balance query.
- **`CONTEXT.md`** at the repo root — canonical glossary of 24
  internal terms with explicit "Avoid" alternatives, an example
  dialogue, and four flagged ambiguities.
- **`docs/adr/`** — three architectural decision records: x402 as the
  economic substrate, single BlockRun Gateway, and the harness-as-
  removable-components discipline.

### Fixed

- **Status bar locked at $0.00 USDC on a funded wallet.** Some wallet
  client paths return `0` transiently (chain provider not yet
  initialized, RPC race) and the UI's live-balance formula
  `Math.max(0, 0 − cost)` then locked the display at `$0.00` for the
  rest of the session even after the wallet was provably non-empty.
  `retryFetchBalance` now does one extra round-trip on a zero result;
  genuinely empty wallets still resolve to `$0.00` quickly.

### Notes

- Skills are bundled-only this release. The frontmatter contract
  (`cost-receipt: true` printing a receipt under the reply,
  `budget-cap-usd` weaving into the per-turn cap) ships in Phase 2 along
  with `~/.blockrun/skills/` user discovery, `.franklin/skills/` project
  discovery, and `franklin skills install`.

## 3.8.44 — Release hygiene + changelog correction

Small cleanup release after v3.8.43.

### Fixed

- Corrected the release history after `v3.8.43` was published for the
  proxy timeout/fallback work, reserving `3.8.44` for the follow-up
  release metadata cleanup.
- Proxy-side `use <model>` switching now recognizes the same
  version-suffix shortcuts as the CLI `/model` command, including
  `k2.6`, `k2.5`, `gemini-2.5`, `gemini-3.1`, `grok-3`, `grok-4.1`,
  `sonnet-4.6`, `haiku-4.5`, and `m2.7`.
- Removed the stale `pnpm-lock.yaml`, which was not used by CI or
  publishing and still contained a local filesystem link for
  `@blockrun/llm`.
- Brought the legacy `VERSION` file back in sync with the package
  version.

## 3.8.43 — Proxy per-request timeout + payment-aware fallback chain

### Added

- Added proxy request and stream timeouts so slow upstream models cannot
  hang the Anthropic-compatible proxy indefinitely. The defaults are
  45s per backend request and 5min per stream, configurable with
  `FRANKLIN_PROXY_REQUEST_TIMEOUT_MS` and
  `FRANKLIN_PROXY_STREAM_TIMEOUT_MS`.
- Added payment-aware fallback handling for the proxy path. Each model
  attempt now covers the unpaid 402 probe, payment signing, and paid
  request, so failures or timeouts at any stage can move on to the next
  fallback model.

### Fixed

- Slow paid proxy requests now cancel their response bodies and fall
  through to fallback models instead of leaving the client stuck after a
  successful payment probe.

## 3.8.42 — Default per-turn spend cap raised to $1.00

### Changed

- Raised the default per-turn spend guard from `$0.25` to `$1.00` so
  normal multi-step research, image-to-image, and dashboard/scaffold
  tasks can finish without an artificial mid-turn stop.
- Updated the spend-cap error message to tell users how to recover:
  raise the cap with `franklin config set max-turn-spend-usd <amount>`
  and then `/retry`.

## 3.8.41 — Smart timeout recovery

### Added

- Skips automatic timeout retries when replaying the full prompt would
  be too expensive or too large, and tells the user exactly why.
- Auto-continues after stream timeouts so long-running answers can
  recover without forcing a full-context replay.

### Also Included

- Declares `viem` as a direct dependency.
- Adds missing version-suffix model aliases in the `/model` picker.
- Mentions the Franklin VS Code extension in the README quick start.

## 3.8.15 — Harness audit + ablation bench + FRANKLIN_NOPLAN

Internal tooling and methodology work. No new user-facing features, but a
reusable rig for deciding which parts of Franklin's harness are still
load-bearing as frontier models improve — and a new opt-out env flag
that the bench uses to isolate plan-then-execute overhead.

Inspired directly by Anthropic's harness-design writeup
(https://www.anthropic.com/engineering/harness-design-long-running-apps).
Their core principle: every harness component encodes an assumption
about a model-capability gap, and those assumptions go stale. Remove
components one at a time, measure, decide.

### Added

- **`docs/harness-audit.md`** — audit of all 17 current harness
  components, each mapped to the assumption it encodes. 10 classified
  as permanent (safety, cost, loop-termination). 7 as capability
  hedges worth re-testing. Priority-ranked ablation list.
- **`scripts/harness-bench.mjs`** — reusable ablation rig. Runs a
  fixed prompt set across baseline + one-at-a-time env flag toggles.
  Records latency, tool-call count, answer length, best-effort cost.
  Supports `--dry-run`, `--configs`, `--prompts`.
- **`FRANKLIN_NOPLAN=1`** env flag — disables plan-then-execute for
  the process. Used by the bench to isolate planner overhead; also
  useful for users who find the two-call path slower than their model
  executing solo.

## 3.8.14 — Groundedness evaluator

Architectural response to a real-world failure: Franklin was asked about
Circle's stock price, ignored the `TradingMarket` tool it had, and
answered from 2022 training data (naming a dead 2022 SPAC). Root cause
wasn't a prompt defect — it was an absent evaluator. The existing code
verifier only fires when the agent writes code, so read-heavy hero use
cases (trading, research) had zero quality gate.

### Added

- **`src/agent/evaluator.ts`** — independent grading pass that fires
  on any non-trivial factual answer. Checks whether every claim in the
  reply traces to a tool-call result OR is explicitly hedged as
  uncertain. Principle-based prompt (no enumerated tickers or
  phrasings). Runs on a cheap model (free nvidia/nemotron-ultra by
  default); override via `FRANKLIN_EVALUATOR_MODEL`. Fully disable via
  `FRANKLIN_NO_EVAL=1`.
- Fires alongside, not instead of, the existing code verifier. Both
  triggers are orthogonal.
- v1 scope: check-and-annotate. Ungrounded answers get a follow-up ⚠️
  note pointing to the missing tool. The re-prompt loop (iterate until
  PASS) is a v2 concern — v1 needs burn-in to calibrate false-positive
  rate first.

## 3.8.13 — Prompt simplification (principle-based grounding)

### Changed

- Tool-selection prompt rewritten from enumerated examples to
  principles. The previous version listed specific tickers (CRCL,
  AAPL, BTC) to steer tool use; that form rots the moment the market
  changes and reads like a cheat sheet. The replacement states two
  general rules — live-world questions come from tools, unknown names
  get researched rather than asking the user — and lets the model
  generalize. Shorter prompt → more cache hits → cheaper.

## 3.8.12 — Hero tools default-visible + auto-routing UX

Three bugs that were making Franklin answer market and research
questions from training data instead of calling the paid tools it has.

### Changed

- **`CORE_TOOL_NAMES` expanded.** `TradingMarket`, `TradingSignal`,
  `ExaAnswer`, `ExaSearch`, `ExaReadUrls`, `WebFetch`, `WebSearch` are
  now in the always-on core. Previously behind the `ActivateTool`
  gate, which weak-to-mid-tier models rarely pulled — so stock / price
  / research questions fell back to training-data guessing. Long tail
  (VideoGen, MusicGen, ImageGen, WebhookPost, PostToX) stays gated.
- **Auto-routing visibility.** Each routed turn now prints
  `*Auto → <resolved-model>*` so the user sees which concrete model
  was picked. Previously the status bar could read a specific model
  name and look like it was pinned there forever.
- **`/auto` slash command.** Hard-reset to smart routing in one word,
  for users who feel stuck on a pinned model.

### Fixed

- System prompt now steers `TradingMarket` / `ExaAnswer` for ticker,
  price, and "what happened to X" questions rather than demanding a
  ticker symbol from the user.

## 3.8.11 — Update-check nag

### Added

- **Daily update check.** Franklin queries
  `https://registry.npmjs.org/@blockrun/franklin/latest` once per day,
  caches the result in `~/.blockrun/version-check.json`, and prints a
  one-liner under the banner when a newer version is available.
  Non-blocking 2s timeout. Disable with `FRANKLIN_NO_UPDATE_CHECK=1`.
  CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`,
  `CIRCLECI`) auto-skip so pipelines stay quiet.
- `franklin doctor` Franklin-version line now shows the update as a
  warning row with the exact upgrade command.

## 3.8.10 — Panel polish: drop Markets 5s poll

### Changed

- Markets panel now refreshes on tab click, not every 5s. Pipeline
  wiring is code-level and telemetry isn't a price ticker — polling
  was pure overhead. Matches the Audit Log tab's pattern.

## 3.8.9 — Multi-asset trading data + stocks via x402 + Panel Markets

Trading vertical goes from crypto-only to multi-asset. Franklin now
actually spends USDC for real market data — stocks cost $0.001/call via
x402, matching the "agent with a wallet" positioning the rest of the
product already delivered. Panel gets a new Markets page showing the
whole data pipeline and today's spend.

### Added

- **Multi-asset price data.** BlockRun Gateway / Pyth provider covers
  crypto, FX, commodity (all free-tier) and stocks (x402-paid,
  $0.001/call). 12 stock markets (us/hk/jp/kr/gb/de/fr/nl/ie/lu/cn/ca,
  ~1,746 tickers). FX pairs like EUR-USD. Commodities like XAU-USD.
- **`TradingMarket` gains three new actions.** `fxPrice`,
  `commodityPrice`, `stockPrice` complement the existing `price`
  (crypto via CoinGecko). `stockPrice` requires a `market` code enum.
- **Panel Markets tab.** Shows Franklin → provider-registry →
  per-asset-class upstream pipeline. Four metric cards for today's
  calls / spend / p50 latency / payment chain. Provider health panel
  (CoinGecko + BlockRun status chips). Recent paid calls ledger.
- **`src/trading/providers/blockrun/`** — chain-aware REST client
  (Base vs Solana), telemetry-enabled fetchers, x402 signing via
  `@blockrun/llm` primitives. Stocks path handles 402 → sign → retry
  automatically.
- **`src/trading/providers/telemetry.ts`** — in-memory ring buffer
  tracking per-provider calls / ok / failures / p50 latency / daily
  spend. Exported as `/api/markets` for the panel.

### Changed

- **Registry `price` becomes keyed by asset class.** `getPriceProvider
  (assetClass)` replaces the single slot. Crypto stays on CoinGecko
  (free, long tail covered); fx / commodity / stock route to BlockRun.
  Back-compat: `data.ts::getPrice(ticker)` defaults to crypto.
- **Panel Social tab removed.** Was a placeholder; agent-side social
  writer untouched, just the dead panel page dropped.

### Fixed

- CoinGecko crypto fetcher now accepts `BTC-USD` as well as `BTC`
  (Pyth-style pair suffix auto-stripped).

## 3.8.8 — Reliability pass: doctor, bash guard, file-tool guards, philosophy

Motivated by real user feedback that Franklin sometimes takes 2–3 tries
to execute a task correctly. Closes the widest gaps in the basic
execution layer before any new capabilities.

### Added

- **`franklin doctor`** — one-command health check covering Node
  version, config directory writability, chain configuration, wallet
  and balance, gateway reachability, MCP config validity, telemetry
  state, and PATH sanity on macOS. Prints color-coded verdicts with
  remedies; `--json` for machine-parseable output; exits non-zero on
  any failing check so CI scripts can gate on it.
- **`PHILOSOPHY.md`** — canonical statement of what Franklin is and
  isn't. One-line thesis: *Franklin lets you give your AI a budget
  and walk away.* Names the Economic Agent category, explains why
  the wallet is the mechanism (not a feature), and gives the
  decision test every future feature has to pass.

### Changed

- **Bash risk classifier** now covers significantly more destructive
  paths: `mv -f` / `cp -rf` overwrites, writes redirected into
  `/etc`, `/usr`, `/bin`, `/sbin`, `/boot`, `/lib`, `/var/lib`,
  `/sys`, `/proc`; `tar -C /…` / `unzip -d /…` extraction into
  system paths; `eval` and `exec bash`; `git filter-repo` /
  `filter-branch` history rewrites; `DELETE FROM x` without
  `WHERE`; `sed -i` against system paths; `truncate -s 0`; `dd of=`
  to raw block devices; `killall` / `poweroff`; privilege-escalated
  (`sudo` / `doas` / `su -c`) destructive ops; secret-exfiltration
  pipes from `.env` / `.ssh` / `.gnupg`.
- **Read tool** adds NUL-byte content sniff. Files without a known
  binary extension are now also rejected when the first 8KB contain
  a NUL byte — catches encrypted `.env.enc`, raw `.data`, compiled
  executables with no extension, etc.
- **Write tool** enforces a 10MB write cap and refuses to write
  content containing NUL bytes. A text-writing tool silently
  emitting binary is almost always a bug.

No behavior changes for code paths that were already within limits.
Existing tests (117 local) all pass.

## 3.8.7 — Kimi K2.6 flagship

### Added

- **`moonshot/kimi-k2.6`** — Moonshot's new flagship with 256K context,
  vision + reasoning. $0.95 input / $4.00 output per 1M tokens.
  Promoted to the `kimi` CLI shortcut and the default Kimi slot in
  the router's AUTO and PREMIUM tier fallback chains, in the planner's
  premium-profile executor, and in the proxy's alias table.
- Kimi K2.5 stays available via the new `kimi-k2.5` shortcut and is
  kept in the model picker as a legacy option.

No behavior changes beyond the added model. Existing sessions on K2.5
continue to work unchanged.

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
- All commit authors rewritten to `1bcMax` (the repo owner's canonical
  identity). Historical context: the v3.8.4 release had briefly rewritten
  authors to `VickyXAI`; that change was reversed in v3.8.9 so the
  contributor graph reflects the actual owner.

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
