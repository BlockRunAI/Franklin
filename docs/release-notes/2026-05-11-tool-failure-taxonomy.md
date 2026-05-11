# Franklin 3.15.92 — tool failure taxonomy + anomaly detector

*May 11, 2026 · 1 patch release*

A self-evolution release. The last six review cycles all started the
same way: the user asks "check the log", and the agent hand-scans
`failures.jsonl` + `franklin-debug.log` looking for new patterns. That
loop works, but it's gated on a human session every single time. The
data to automate it is already on disk.

This release adds a categorical classifier for tool failures, a rate-
normalized anomaly detector, and a one-line CLI surface so the loop
becomes:

```
$ franklin doctor --anomaly
  • SearchX / InvalidArguments  NEW failure type (no baseline)  recent=4, baseline=0
    sample: Cannot read properties of undefined (reading 'snapshot')

  1 anomalies. Investigate before they snowball.
exit: 1
```

## The taxonomy

Six categories, applied to every entry in `failures.jsonl`:

| Category | What it means | Typical remedy |
|---|---|---|
| `InvalidArguments` | Model called the tool wrong — schema reject, missing field, type mismatch, "cannot read properties of undefined" | Fix the tool spec or the model's prompt nudge |
| `UnexpectedEnvironment` | World wasn't as expected — `ENOENT`, wallet not configured, chain mismatch, command not found | Tell the user to fix env or auto-recover |
| `ProviderError` | Upstream API/tool failed — 429, 5xx, gateway, network, `ECONN*` | Retry with backoff, fall back, surface to user |
| `UserAborted` | User Ctrl+C / cancel / abort signal | No action — by design |
| `Timeout` | Call sent successfully but exceeded our time budget | Escalate budget or pick a faster path |
| `Unknown` | Didn't match any pattern | **Bug in the classifier** — file a follow-up |

Inspired by Cursor's published harness-engineering taxonomy. The
patterns are tuned to Franklin's actual tool surface, drawn from the
error messages already in this repo's `failures.jsonl`. The
`"Cannot read properties of undefined (reading 'snapshot')"` test
case is the literal SearchX null-deref that prompted the playwright-
snapshot fix earlier this week.

## How it integrates

The `FailureRecord` interface gained an optional `category` field:

```ts
interface FailureRecord {
  timestamp: number;
  model: string;
  failureType: 'tool_error' | 'model_error' | 'permission_denied' | 'agent_loop';
  toolName?: string;
  errorMessage: string;
  recoveryAction?: string;
  category?: ToolFailureCategory;  // ← new
}
```

The writer auto-classifies on append (`recordFailure()` calls
`classifyToolFailure()` if the caller didn't supply one). The reader
back-fills historical records on load (`loadFailures()` applies the
same classifier to entries missing the field). The on-disk format
stays append-only and JSONL-compatible — **no migration needed**.

Two new operational guarantees on the writer:

1. **Test isolation.** `recordFailure()` now honors
   `FRANKLIN_NO_AUDIT` / `FRANKLIN_NO_PERSIST`, the same way the
   audit-log and stats writers do. Previous releases let test runs
   leak fake failures into the user's home dir (the same pattern that
   bit `cost_log.jsonl` two weeks ago).
2. **`FRANKLIN_HOME` sandboxing.** The failures-file path resolves at
   call time, picking up `FRANKLIN_HOME` if set. Tests can point at a
   temp dir without touching the real file.

## Anomaly detection

```ts
function getToolAnomalies(opts?: AnomalyOptions): AnomalyReport[];
```

Compares `(toolName, category)` failure rates in the **recent window**
(default last 24h) against the **baseline window** (default last 30d,
recent window excluded so the comparison is apples-to-apples). A
bucket surfaces when:

- `recentCount >= 3` (filters single-flake noise), AND
- either the baseline is zero (brand-new failure type — never seen,
  always surfaces, sorts first), or
- `spikeRatio >= 3.0` (rate-normalized: 3× higher per-second failure
  rate in recent vs baseline)

Both thresholds and both windows are overridable per call. The math
is intentionally simple — we're not building a time-series engine,
we're replacing one specific human workflow.

A bucket with `baselineCount=0` and `recentCount >= 3` is the most
important signal. It means the harness is producing a failure mode
that has never been observed in the last 30 days — almost always a
regression worth investigating *before* it stacks up.

## CLI surface

```
franklin doctor --anomaly
franklin doctor --anomaly --json
```

Human-readable mode:

```
  franklin doctor --anomaly
  Looking for (tool, category) failure spikes in the last 24h vs the 30-day baseline.

  • SearchX / InvalidArguments  NEW failure type (no baseline)  recent=4, baseline=0
    sample: Cannot read properties of undefined (reading 'snapshot')
  • Bash / UnexpectedEnvironment  6.3× baseline  recent=6, baseline=1
    sample: ENOENT: no such file or directory

  2 anomalies. Investigate before they snowball.
```

JSON mode emits the `AnomalyReport[]` straight out, suitable for
piping into a hook that opens a GitHub issue or pings a webhook.

**Exit codes**: `0` when clean, `1` when any anomaly is surfaced. So a
cron entry like:

```
0 * * * * franklin doctor --anomaly --json | jq '.anomalies | length' || mail …
```

just works.

## Tests

Eight new in `test/local.mjs`:

- **Six classifier round-trips**, one per category. Each input is a
  real error message observed in production. The
  `"Cannot read properties of undefined (reading 'snapshot')"` case
  is the actual SearchX failure from this repo's `failures.jsonl`.
- **One math fixture** for `getToolAnomalies`: synthetic on-disk file
  with 5 SearchX/ProviderError (no baseline → Infinity, surfaces); 4
  ImageGen/Timeout vs 80 baseline-over-30d (rate-normalized 1.45×, does
  NOT surface); 6 Bash/UnexpectedEnvironment vs 1 baseline (~6×,
  surfaces). Asserts ordering, counts, and sub-threshold suppression.
- **One classifier-glue placeholder** to keep the file's classifier-
  section self-contained.

381/381 tests pass.

## What this is **not**

- **Not a replacement for `failures.jsonl`.** The raw record stays;
  the taxonomy is an annotation layer.
- **Not a time-series database.** Rate-normalized 24h-vs-30d covers
  the use case we have today; if we need per-hour windows or rolling
  baselines, that's a later release.
- **Not a recovery system.** Surfacing anomalies is step 1. Closing
  the loop ("see anomaly → file ticket → fix") is the next layer; this
  release lays the data foundation for it.

## Why split from `franklin stats`

`franklin stats` is for spending — tokens, dollars, cache hit rate.
Failure forensics is a different concern with a different audience
(operators, not end users). Cursor's writeup splits the same way:
their dashboards separate token efficiency from tool reliability.
Mixing them here would have been faster to ship but harder to grow
into the automated tooling that's the actual end state.

## Behavioral implications

After this release, the "check the log" cycle gets replaced by a one-
line CLI call. The data was always on disk; now it's queryable. If
you've been running Franklin daily and noticed the same conversational
ritual every session start, that ritual is the thing this release
retires.

Try it now:

```
franklin doctor --anomaly
```

If you get `No anomalies. Tool failure rates match the 30-day baseline.`
you can skip the next "check the log" question and go straight to your
actual work.
