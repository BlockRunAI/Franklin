# 0003 — Each harness component must be independently removable

**Status:** accepted

Every layer Franklin wraps around a raw model call — **Plan-then-execute**, **Compaction**, **Code verifier**, **Groundedness evaluator**, **Polish round**, **Bash risk classifier**, the **fallback chain**, and the rest — is treated as encoding a specific assumption about a current model-capability gap. Each component must be independently disable-able (typically via an env flag) so the assumption can be re-tested as frontier models improve. The audit lives in [`docs/harness-audit.md`](../harness-audit.md); the reusable ablation rig lives in [`scripts/harness-bench.mjs`](../../scripts/harness-bench.mjs).

## Why this matters

Harnesses are sticky. Components added in 2025 to compensate for then-real model failures keep running in 2026 even when the underlying gap has closed, costing latency, tokens, and reliability for no current benefit. The default trajectory of any agent codebase is that the harness only grows. The discipline here is the opposite: every component must justify its existence on the current model generation, not the one it was added against.

## Decision

Three rules:

1. **Each new harness component declares the model gap it patches.** The CHANGELOG entry and the relevant ADR (if any) name the assumption explicitly — e.g. "weak models leak `<think>` tags" for the **Polish round**, "read-heavy hero tools answer from training data" for the **Groundedness evaluator**.
2. **Each harness component is removable via a single env flag.** `FRANKLIN_NOPLAN`, `FRANKLIN_NO_EVAL`, `FRANKLIN_NO_ANALYZER`, `FRANKLIN_NO_PREFETCH`, `FRANKLIN_NO_UPDATE_CHECK`, etc. are not debug switches — they are first-class affordances for the ablation rig and for users whose model already covers the gap.
3. **Periodic audit.** [`docs/harness-audit.md`](../harness-audit.md) classifies each component as either **permanent** (safety, cost, loop-termination — survives any model improvement) or a **capability hedge** (worth re-testing). Capability hedges that ablate cleanly on the current frontier model are candidates for retirement.

## Considered options

- **Always-on harness, no opt-out (rejected).** Lowest user-facing complexity but accumulates dead weight indefinitely. There is no path back from "we needed this in March" to "we don't need this in October."
- **Per-component config flags in `franklin config` (rejected for now).** A nicer surface but harder to use from the bench rig and easier to forget to update when components are added. The env-flag convention keeps the cost of adding/removing a component flat.
- **Env-flag-disable-able + audited (chosen).** Adds the ablation rig and the audit doc as first-class artefacts. Component removal is a non-event when a flag already exists.

## Consequences

- Adding a harness component without an env-flag opt-out is a review-blocking gap. The `FRANKLIN_NO_*` flag is part of the component, not a debugging afterthought.
- The ablation rig (`scripts/harness-bench.mjs`) is the source of truth for whether a hedge still pays. "It feels right" is not enough to keep a capability hedge alive.
- The CHANGELOG is the de-facto decision log for individual harness changes (see v3.8.14 evaluator, v3.8.15 NOPLAN, v3.8.41 timeout recovery). New ADRs are created only when a harness change crosses the bar in [the ADR format guide](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/ADR-FORMAT.md): hard to reverse, surprising without context, the result of a real trade-off.
