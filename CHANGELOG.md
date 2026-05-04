# Changelog

## 3.15.18 — Sweep orphan tool-results directories

Round-3 audit, after sweeping orphan session jsonl + legacy files in
3.15.15 and gating session writes in 3.15.17: \`~/.blockrun/tool-results/\`
also accumulates per-session subdirs that nothing ever cleans. The
\`streaming-executor\` writes large tool outputs to
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
- +1 test covering the live-survives, orphan-dies invariant.

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

## 3.15.13 — TradingSignal: 90d default, real verdict, no more "持有观望"

Same BTC report from 2026-05-03 had a second-order bug. After the
agent landed on a model that could read the tool output, TradingSignal
returned `MACD: 1822.73 / Signal: NaN / Histogram: NaN — neutral`
because default lookback was 30 closes — MACD needs slow EMA (26) +
signal EMA (9) = 35 minimum. Agent translated the partial signal into
"持有观望" / "wait and see", the exact wishy-washy default the user
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
  forbidden-phrases section. Forbids "持有观望" / "wait and see" /
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
("让我先 X...", "Now I have...", "好，现在我..."), Korean phrases leaked
into a Chinese reply, three pasted YouTube URLs returned 32 tokens of
"can't access YouTube", and a 215K→9K context drop between turns had
no explanation.

- `system-prompt`: removed an internal contradiction. The Output
  Efficiency section said "do not narrate" while Tone & Style said
  "use a period not a colon" with the same example — models followed
  the latter and narrated freely. New rule explicitly bans pre-tool
  phrases ("Let me read…", "让我先…", "好，现在我…") and adds a
  language-consistency rule so private reasoning in another language
  ("좋아", "OK now") doesn't leak into user-facing text.
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
  `current`, `members`, `price of`, plus Chinese equivalents. Pushes
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
  zero-arg call. The system prompt steers "balance / 钱包余额 / wallet
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
