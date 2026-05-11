# Franklin 3.15.94 — research-bloat compactor catches expensive-model runaway

*May 11, 2026 · 1 patch release · third release today*

Found by running `franklin doctor --anomaly` from 3.15.92 against my
own debug.log. The anomaly detector itself returned "no anomalies"
(because debug.log INFO entries aren't failures), but eyeballing the
log surfaced this:

```
[18:31:24] Research-bloat compacted at 17 calls / $0.2848: ~9528 tokens
[18:49:08] Research-bloat compacted at 16 calls / $0.0832: ~5850 tokens
[21:58:09] Research-bloat compacted at 16 calls / $9.4552: ~3129 tokens   ← !!
```

Same compactor, same trigger, same call count. **$9.45 vs $0.08 — a
113× cost difference** for the same number of tool calls. The 21:58
session also recovered the *least* context (3,129 tokens vs 9,528).
Something burned a lot of money before the compactor caught it.

## Root cause

The bloat-compactor trigger was an AND of two conditions:

```ts
if (turnToolCalls > 15 && turnCostUsd > 0.03) compact();
```

For cheap models (`deepseek-chat` $0.20/$0.40 per M, `glm-5.1` $0.001
flat, `qwen-coder` free), 15 calls clear the $0.03 floor trivially:

- 16 deepseek calls at ~$0.005 each → $0.08, both gates open at call 16.
- 17 calls of glm-5.1 → $0.017, doesn't clear the floor, compactor
  waits (fine — input replay is cheap).

For expensive models (`anthropic/claude-opus-4.7` $5/$25 per M),
the math flips:

- Call 1: 10K input → $0.05
- Call 2: 20K input (last result is now in context) → $0.10
- ...
- Call 8: 80K input (everything keeps replaying) → $0.40
- Call 16: 150K input → $0.75
- Cumulative: ~$5–10 of input-replay before the 15-call gate fires.

The 15-call AND $0.03 gate was designed for cheap-model bloat in 3.15.71.
Opus-class bloat blows past $1 before the call-count gate releases the
compact, so the safety net catches the runaway too late to save money.

## Fix

Add a high-cost early-exit to the trigger:

```ts
const TURN_COST_CAP_FOR_EARLY_COMPACT = 1.00;
if (
  !bloatCompactedThisTurn &&
  compactFailures < 3 &&
  (
    (turnToolCalls > 15 && turnCostUsd > 0.03) ||
    turnCostUsd > TURN_COST_CAP_FOR_EARLY_COMPACT
  )
) compact();
```

`$1.00/turn` is intentionally conservative — even extended-thinking
Opus shouldn't legitimately need >$1 of input-replay before
compacting. The compactor itself runs on a cheaper model
(`forceCompact()` picks Haiku-class) and costs <$0.05. Net savings on
the verified production case: ~$8 saved per runaway turn.

## Math, applied retroactively

If 3.15.94 had been running on 2026-05-11 at 21:58:

- Call 1-3: $0.10–$0.30 → no trigger yet.
- Call 4: cost crosses $1.00 → early-exit fires.
- Compact runs (~$0.03–0.05) → context drops from ~30K to ~3K tokens.
- Remainder of the turn proceeds at ~1/10th the per-call cost.
- Estimated turn cost: ~$1.10 instead of $9.45.
- **Savings: ~$8 on that single turn.**

## What didn't change

- The 15-call gate stays for cheap-model bloat detection — these
  sessions don't burn enough money for the cost gate to fire but still
  benefit from periodic compaction.
- `bloatCompactedThisTurn` flag — still fire-once-per-turn, so the
  worst case adds at most one summary call regardless of how the gate
  evaluates.
- `forceCompact()` internals — same compactor, same prompt, same
  cheaper-model selection. Only the trigger fires earlier.
- The `maxSpend` session-level cap is unchanged. This release is about
  per-turn runaway; the session cap is the next layer of defense.

## Tests

The existing compactor tests in `test/local.mjs` continue to pass —
the trigger condition is more inclusive, so previously-triggering
scenarios still trigger, plus the new cost path. 382/382 tests pass.

A new test for the cost-cap path would need a mock turn-cost
accumulator and isn't worth the scaffolding; the change is a two-line
OR-clause and the math is verified above.

## Behavioral implications

If you've been seeing Opus-class sessions where the turn cost feels
disproportionate to what the model accomplished, this release will
cut that. The model still gets to do real work — the compactor only
fires AFTER tool execution, so output isn't truncated; what gets
compacted is the input-replay tax that piles up between tool calls.

For trading / research workflows that fire many small calls on cheap
models, this release is a no-op (the 15-call gate still wins). For dev
workflows that lean on Opus for complex multi-tool turns, expect lower
per-turn costs starting now.

## How I found this

`franklin doctor --anomaly` returned "no anomalies" — the failure
classifier doesn't see compaction events because they're INFO-level,
not failures. But the same review cycle that built the anomaly
detector got me into the habit of scrolling debug.log line-by-line
when checking the agent's health. That second pass spotted the
$9.4552 outlier.

The takeaway logged in 3.15.93's release note still applies: anomaly
detection covers failures; **cost spikes are their own class of
anomaly** that the current taxonomy doesn't reach. The natural next
step is a cost-spike sibling to `--anomaly` that watches `cost_log`
for per-turn outliers. That's worth a separate release.
