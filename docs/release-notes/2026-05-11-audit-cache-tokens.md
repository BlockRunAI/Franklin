# Franklin 3.15.95 — audit captures the cache-token fields that vision calls were silently using

*May 11, 2026 · 1 patch release · fourth same-day release · last one for tonight*

The wallet truth fix from 3.15.89 made `franklin-stats.json` accurate
against real x402 settlements. But running `franklin doctor --anomaly`
and eyeballing the audit log surfaced a different problem:

```
audit row: model=anthropic/claude-opus-4.7  inputTokens=3653  outputTokens=56  costUsd=$0.567
```

At Opus 4.7's $5/M input rate, **$0.567 implies ~113K input-equivalent
tokens**. The audit logged 3,653. The ratio is 28× off. Where did the
other 109K go?

## Root cause

Anthropic's `usage` object on a vision or prompt-cached call returns
**three** input-token counts:

```json
{
  "usage": {
    "input_tokens": 3653,
    "cache_creation_input_tokens": 96347,
    "cache_read_input_tokens": 13000,
    "output_tokens": 56
  }
}
```

Each is billed at a different rate:

| Field | Multiplier | Per 1M (Opus 4.7) |
|---|---|---|
| `input_tokens` (base) | 1.0× | $5 |
| `cache_creation_input_tokens` | 1.25× | $6.25 |
| `cache_read_input_tokens` | 0.1× | $0.50 |

Franklin's streaming client read **only** `input_tokens`. The two
cache fields fell on the floor. The wallet settled correctly (gateway
saw all three), but the audit log under-reported input by ~30×, and
every dashboard that computed `costPerToken` or `cacheHitRate` from
`franklin-stats.byModel` got nonsense.

## Fix

```ts
// CompletionUsage (src/agent/llm.ts)
export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

// SSE parser — both message_start and message_delta
if (msgUsage['cache_creation_input_tokens'] !== undefined) {
  usage.cacheCreationInputTokens = msgUsage['cache_creation_input_tokens'];
}
if (msgUsage['cache_read_input_tokens'] !== undefined) {
  usage.cacheReadInputTokens = msgUsage['cache_read_input_tokens'];
}

// AuditEntry (src/stats/audit.ts) — same two optional fields
// loop.ts — passes them through on every appendAudit() call
```

Optional types (not required), so:

- Sessions without prompt caching are unchanged.
- Free-model and non-Anthropic calls (the cache fields are
  Anthropic-specific) are unchanged.
- Older audit rows without the fields are still parseable.

## What didn't change

- **Wallet charges**: Always correct — gateway settles against
  Anthropic's full billing breakdown.
- **`franklin-stats.totalCostUsd`**: Always correct — uses the
  real x402 settlement (3.15.89's wallet-truth fix).
- **Compaction logic**: 3.15.94's cost-cap is independent.
- **No behavioral change** — same model selection, same routing, same
  payment flow.

The fix is purely additive observability.

## Test

`appendAudit` round-trip test in `test/local.mjs` pins the field
serialization. Asserts both `cacheCreationInputTokens` and
`cacheReadInputTokens` survive a write/read cycle, including
`cacheReadInputTokens: 0` (which is meaningful — distinct from
"undefined" — for cache-cold sessions).

383/383 tests pass.

## Why this is the third "tracking gap" fix in 24 hours

- 3.15.89: cost_log captured wallet truth.
- 3.15.92: failure taxonomy + anomaly detector.
- 3.15.93: `franklin doctor` does a fresh npm fetch (no 24h stale).
- 3.15.94: bloat compactor catches expensive-model runaway.
- **3.15.95** (this release): audit captures full input-token breakdown.

Each was found by the previous one's tooling. The pattern: as soon as
one data layer became trustworthy, the next layer's noise stood out.
That's the harness-engineering flywheel — make one signal honest,
watch the next inconsistency surface, fix it.

## What this unlocks

With cache-token fields available, two dashboards become possible:

1. **Effective cache hit rate** per model. The 28× ratio in audits
   means the user's Opus sessions today were heavily cache-served
   (cache reads at 0.1× base) but also paid for big cache writes.
   Until now invisible.
2. **Token efficiency** — total billed input vs uncached input,
   model-by-model. A higher ratio means Franklin is using prompt
   caching well (good); a low ratio means we're paying for too much
   re-replayed context (bad — links back to 3.15.94's compaction
   work).

I'll wire a `franklin doctor --cost-spike` or similar surface in a
later release. Cost spike detection is the next natural extension of
3.15.92's anomaly detector — currently it only watches failures, but
runaway cost is a failure too, just a quieter one.

## Behavioral implications

Existing audit rows show small `inputTokens` for Anthropic vision
calls. They're not wrong per se — `inputTokens` was always meant to
be the uncached portion — but until now they were the only signal,
which made them misleading. New rows carry the full picture; old rows
keep working with the cache fields as `undefined`. Dashboards that
care about cost efficiency should sum `inputTokens +
cacheCreationInputTokens + cacheReadInputTokens` for the true billed
input count.

If you want to see this in action: run an Opus session that re-reads
a large file or attaches an image, then `jq '.[-3:]'
~/.blockrun/franklin-audit.jsonl`. The last entry will have non-zero
`cacheCreationInputTokens` matching where the wallet actually paid.
