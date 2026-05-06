# Franklin 3.15.66 → 3.15.76 — Predexon expansion + cost forensics + Claude Code import

*May 1 – May 6, 2026 · 11 patch releases*

A week of work driven entirely by **real audit log forensics** and **a single user
session that wouldn't stop generating bugs**. Three major themes plus a stack of
smaller wins. Every fix is anchored in evidence — a 422 here, a $0.32 wasted turn
there, an `[object Object]` in someone's terminal — not in cleanup or speculative
refactoring.

---

## 1. PredictionMarket: 4 actions → 10 actions, two broken endpoints replaced

Before this week, Franklin's `PredictionMarket` tool exposed 4 actions across 2
venues (Polymarket + Kalshi). One of those was **silently 404'ing from the day
it shipped** — `smartMoney` called a path that doesn't exist on the BlockRun
gateway. Replaced + extended. The tool now offers:

| Action | Cost | What it does |
|---|---|---|
| `searchAll` | $0.005 | One call across Polymarket+Kalshi+Limitless+Opinion+Predict.Fun |
| `searchPolymarket` | $0.001 | Polymarket-specific search with sort/status |
| `searchKalshi` | $0.001 | Kalshi-specific search |
| `crossPlatform` | $0.005 | Pre-matched market pairs across venues (arbitrage) |
| `leaderboard` | $0.001 | Global top wallets by P&L on Polymarket |
| `walletProfile` | $0.005 | Single-wallet full profile or batch (smart dispatch) |
| `walletPnl` | $0.005 | Single-wallet P&L summary + time series |
| `walletPositions` | $0.005 | Single-wallet open + historical positions with per-position P&L |
| `smartActivity` | $0.005 | Markets where high-P&L wallets are positioning |
| `smartMoney` | $0.005 | Per-condition_id smart-money drill-down |

The `walletProfile + walletPnl + walletPositions` triplet is the new default
routing for *"analyze this wallet / can I copy this trader / 复制交易"*: three
parallel $0.005 calls = full picture for $0.015. The system prompt explicitly
forbids `Bash`-curling `data-api.polymarket.com` directly — agents now use the
paid path the architecture exists to provide.

### The bug chain — five patches to converge

The 3.15.70 ship of the four new actions had **four distinct wire-format bugs
none of which local tests could see:**

1. `walletProfile` sent query param `wallets` — Predexon expects `addresses`
   → HTTP 422 every call (3.15.72 fix)
2. `walletProfile` hit the *batch* endpoint when "analyze this wallet" wants
   the *single-wallet* path-parameter endpoint → wrong data shape even after
   the rename (3.15.73 fix: smart-dispatch, plus added `walletPnl` +
   `walletPositions` for the missing surfaces)
3. `searchAll` sent `search`, Predexon expects `q` → 422 (3.15.74)
4. `walletPnl` sent no `granularity`, then sent `daily` instead of `day` →
   two consecutive 422s, second one surfaced the valid enum
   `{day, week, month, year, all}` (3.15.74)

All four were caught by **paid e2e tests added in 3.15.74**, not by local unit
tests. Calling Predexon directly costs ~$0.005/test; the full PredictionMarket
e2e battery is $0.025 and is now permanent in the suite gated behind
`RUN_PAID_E2E=1`.

### Then 3.15.75 fixed `[object Object]`

After all the wire-format work, the formatter still rendered every position row
as `[object Object] — P&L n/a` on real responses. The `as string` cast lied on
nested objects: Predexon returns positions as
`{ market: {title, side_label}, position: {shares, avg_entry_price, ...},
current: {value_usd}, pnl: {unrealized_usd, unrealized_pct} }` — every numeric
field is 1-2 levels deep. Same shape mismatch on `walletProfile` (everything
under `metrics.all_time`) and `walletPnl` (timestamps are unix seconds, the
series key is `pnl_over_time` not `series`).

Fix: a `pickString(...candidates)` helper that walks nested objects looking for
common name-bearing keys, plus per-action shape-aware formatters. The e2e tests
now also assert `!/\[object Object\]/.test(output)` so this regression can't
ship silently again.

### Real before/after

User asked: *"0xdfe3fedc... 分析这个Polymarket地址，可以复制交易吗？"*

**Before:**
```
1. **[object Object]** — P&L n/a
2. **[object Object]** — P&L n/a
3. **[object Object]** — P&L n/a
```
→ agent ignored the tool, bash-curled `data-api.polymarket.com` for 6 retries,
spent **$0.32 on opus-4.7** before the loop guard fired.

**After:**
```
1. **Zelenskyy out as Ukraine president by end of 2026?** — No · 203,111.96 shares · avg 61.6% · now $174.7K · P&L $49.6K (+39.7%)
2. **Will the US acquire part of Greenland in 2026?** — No · 172,151.62 shares · avg 77.0% · now $149.3K · P&L $16.8K (+12.6%)
3. **Russia x Ukraine ceasefire by end of 2026?** — No · 217,830.13 shares · avg 53.4% · now $148.1K · P&L $31.9K (+27.4%)
```
→ three parallel paid calls, $0.015 total, in ~5 seconds.

### Panel telemetry too

Prediction-market calls now flow through the same telemetry ring buffer as
trading-data calls. The Markets tab's "Calls today / Spend today / Recent paid
calls" includes `/v1/pm/...` endpoints alongside CoinGecko + BlockRun stock
quotes. Tagline updated to *"How Franklin gets trading + prediction-market data
— and what it costs."*

---

## 2. Cost forensics: audit log forensics caught five real bugs

The audit log (`~/.blockrun/franklin-audit.jsonl`) became the spine of this
week's debugging. Before any of this work, the log was *unreadable* for cost
attribution because of three latent bugs:

### Audit `outputTokens` was undercounted on 3 model families

A real user session showed 89% of `zai/glm-5.1` calls had `outputTokens: 1` in
the audit, even though the agent was producing rich multi-line bash commands.
The non-Anthropic providers behind the gateway send `message_start` with the
placeholder `output_tokens: 1` and never finalize via `message_delta`. Cost
estimation downstream of the audit was therefore **wrong** for those routes.

| Model | Tiny-output rate (pre-fix) |
|---|---|
| `zai/glm-5.1` | ~89% |
| `nvidia/qwen3-coder-480b` | 57% |
| `google/gemini-2.5-flash` | 32% |
| `anthropic/claude-sonnet-4.6` | 1% (correct) |
| `deepseek/deepseek-v4-pro` | 0.3% (correct) |

3.15.69 fix: at end of LLM stream, if `usage.outputTokens <= 1` but the
collected payload has real content, estimate from byte length (~4 chars/token).
Model-agnostic — only fires when the wire value is implausibly small for the
actual content.

### Audit `prompt` was logging harness-injected text instead of user input

`extractLastUserPrompt` walked Anthropic's message history backward looking for
the last `role: "user"` message. But `role: "user"` is also used for synthetic
injections like `[FRANKLIN HARNESS PREFETCH] CRCL price...` and
`[GROUNDING CHECK FAILED] retry`. Real audit log:
- 403 rows started with `[FRANKLIN HARNESS PREFETCH]`
- 18 rows started with `[GROUNDING CHECK FAILED]`
- 421 / 4,983 audit entries (~8.5%) had no usable user prompt

3.15.71 skipped messages that *start* with a SCREAMING-CASE bracket. 3.15.76
also strips *trailing* labels — the post-response evaluator now appends
`[SYSTEM NOTE] The user is correcting you...` to the user's real text within
the SAME message, half-real / half-synthetic. Both endpoints trimmed.

### Cap-exceeded messages now report real spend

The user-facing message used to say *"Bash called 3× with the same input"* —
but in the real failure case, 47 *other* bash calls had already preceded it.
Users reasonably read the message and thought the guard fired at call #3, when
it actually fired at call #50.

3.15.69: cap-exceeded messages now show
`N tool calls, $X spent this turn`. New `turnCostUsd` accumulator next to the
existing `turnToolCalls`, bumped at the same site as `sessionCostUsd`. Both
the HARD_TOOL_CAP message and the signature-loop message use it.

### Failed-external-call hard stop

The signature-based loop guard caught exact-input repeats but missed the case
where a model thrashed against a dead endpoint with structurally distinct
inputs. Verified: `glm-5.1` burned 50 calls / $0.05 cycling 17 different curl
variants against Cloudflare-blocked `api.querit.ai` before the signature guard
finally fired on the first exact repeat.

3.15.69 added a guard: 5 consecutive Bash/WebFetch results matching
`/(401|403|429|5xx|unauthorized|forbidden|WAF|cloudflare|fault filter|blocked|invalid (auth|api|token|key|bearer))/i`
→ break the turn. Resets on any non-failed external call so legitimate
retry-then-succeed paths aren't punished.

### Research-bloat compaction (tightened)

The window-based auto-compact only fires near the context ceiling (~172K tokens
for a 200K model). Long research sessions burn money long before that. Top
audit log session: **$6.67 on `gemini-2.5-flash` in 121 calls** — never
approached the 1M-token compaction threshold.

3.15.69 added a secondary trigger fired once per turn at
`turnToolCalls > 30 && turnCostUsd > 0.05`. 3.15.71 tightened to
`> 15 && > $0.03` after a real franklin-shorts edit session ended at 16 calls
/ $0.055 without ever crossing the 30-call boundary.

---

## 3. `franklin migrate` — current Claude Code layout

Franklin's `migrate.ts` was looking at `~/.claude/mcp.json` and
`~/.claude/history.jsonl` — files that haven't existed on a fresh Claude Code
install in years. New users running `franklin migrate` saw zero items detected.

Real Claude Code 2026 layout:
- MCP config: `~/.claude.json` (top-level), field `mcpServers`,
  field name `type` not `transport`
- Sessions: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`,
  one file per conversation (1,591 files on a typical heavy user's machine)

3.15.69 fix walks both legacy and current layouts, converts Claude Code's line
shape (`{type, message:{role,content}, timestamp}`) to Franklin's `Dialogue`,
preserving session boundaries. Plus a sticky `imported: true` flag on
`SessionMeta` so importing 200+ historical sessions doesn't trigger
`pruneOldSessions`'s 20-newest cap on the next `franklin` launch — that would
have silently destroyed the user's history.

---

## 4. Plugin SDK: doc reconciliation, no behavior change

`docs/plugin-sdk.md` and `CLAUDE.md` referenced `src/plugins-bundled/` as if it
shipped with the repo. Directory was retired in v3.2.0; nothing has shipped
there since. Fixed in 3.15.69: stale paths replaced with the actually-present
`trading/` and `content/` directories, the inline plugin example noted as the
canonical reference. Plugin discovery path order, `Workflow` SDK exports, and
`WorkflowStepContext.callModel` signature are all stable. Hackathon participants
importing from `@blockrun/franklin/plugin-sdk` get the same SDK they had before
— just with docs that match what's on disk.

---

## 5. Smaller wins

- **3.15.66 — chat-completions example uses real model names.** Removed
  `gpt-5.1` and `grok-5` from the system prompt — they're not models that
  exist. Opus would happily echo them back as if they did.
- **3.15.67 — `franklin context` reports the real Solana wallet.** Was reading
  a legacy ghost path on machines that had toggled chains.
- **3.15.68 — pid-less queued tasks reaped after 5min.** Background tasks
  whose runner crashed during module import (wrong cliPath, missing dep) used
  to live forever in `status: queued / pid: undefined`. `reconcileLostTasks`
  short-circuited because there was no pid to ping.
- **3.15.68 — `franklin task list` header row + full hygiene counters.**
- **3.15.66 — terminal task records pruned after 7 days.** Hygiene was leaving
  cruft in `~/.blockrun/tasks/`.
- **3.15.76 — system prompt: ASCII pipes only in markdown tables.** Real
  session had a model emit a "table" with `│` (box-drawing U+2502) data rows
  and `|` separator — no renderer parsed it. Prompt-only fix; works on any
  model.

---

## What you actually need to know if you're a Franklin user

```bash
npm install -g @blockrun/franklin@latest    # picks up 3.15.76
```

If you ran `franklin` before this week, your installed version probably has at
least one of: silently-broken `smartMoney`, 422 on Polymarket wallet analysis,
`[object Object]` in tool output, audit log full of harness preambles, cap
messages that don't tell you what the turn cost. All fixed. Restart your
Franklin process to pick them up — npm install alone updates the binary on
disk but a long-running `franklin` keeps the old code in memory.

## What we deliberately didn't do

- **No restoration of a "cheap" SIMPLE auto-tier.** Both SIMPLE and MEDIUM
  currently route to `deepseek-v4-pro`, which means there's no actual cost
  difference between routing tiers. Tempting to put `gemini-2.5-flash` or
  `glm-5.1` back as primary for SIMPLE — but the v4-pro choice was deliberate
  for tool-use reliability in agent loops, and a regression there would be
  costlier than the savings. Flagged for a separate decision with eyes open
  on the tradeoff, not a quiet swap.
- **No backfill of the 421 polluted audit prompts.** The 3.15.71/76 fixes
  apply going forward; old rows stay polluted but the new field will be clean
  within a week of usage. Backfill costs more than it returns.
- **No bridge tool surface yet.** The agent's "you'd need to bridge USDC from
  Base to Polygon for Polymarket" dead-end is a real product gap. Adding a
  bridge tool is a multi-call decision (which bridge, slippage policy, paper
  vs real) and deserves its own scope.
- **No post-stream `│ → |` sanitizer.** Trying the prompt nudge first; if the
  prompt rule isn't enough, a streaming sanitizer is the next escalation.

## Honest cost of the Predexon work

The 3.15.70 → 3.15.75 chain took five patches to converge. The 3.15.70 ship
should have included paid e2e tests. Shipping a paid-API tool without
paid-API validation is exactly how you ship four broken endpoints in one
commit. Lesson: e2e gating tests for any new gateway endpoint, paid or not,
is mandatory from now on. The 5-test PredictionMarket suite at $0.025 per run
will catch the next round before it lands.
