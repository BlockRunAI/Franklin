# Franklin Harness Audit

**Methodology:** Anthropic's harness-design writeup (https://www.anthropic.com/engineering/harness-design-long-running-apps) frames every harness component as encoding an assumption about a model capability gap. When models improve, those assumptions go stale and the component becomes dead weight. This document enumerates Franklin's current harness, names the assumption each piece encodes, and flags which are likely stale under Opus 4.7 / Sonnet 4.6 / Haiku 4.5 baseline capability.

Use this doc as a **pre-release checklist**: when a new frontier model ships, walk the table, re-test the "still load-bearing?" column, remove what no longer carries weight.

---

## The question to ask of every component

Not "is this useful?" but:

> **What failure mode does this component prevent, and does a current-generation model still exhibit that failure mode without it?**

If the failure mode has been absorbed by model capability, the component is now overhead without benefit. Per the article:

> "Every component in a harness encodes an assumption about what the model can't do on its own. Those assumptions are worth stress testing, both because they may be incorrect, and because they can quickly go stale as models improve."

---

## Franklin harness inventory — full audit

| # | Component | File | Encoded assumption | Category | Load-bearing today? | How to test removal |
|---|---|---|---|---|---|---|
| 1 | Plan-then-execute | `src/agent/planner.ts` | "Weak executor following a strong planner's plan is cheaper + just as good as expensive single-model execution" | Capability | **Suspect** — Opus 4.7 / Sonnet 4.6 execute coherently for hours. Two-call overhead may exceed savings. Plus trigger matches only code verbs (build / refactor / fix) — misses research / analysis. | `FRANKLIN_NOPLAN=1` env or `/noplan` slash; rerun bench |
| 2 | Dynamic tool visibility | `src/tools/tool-categories.ts`, `activate.ts` | "25+ tools visible at once → weak models hallucinate tool names / emit [TOOLCALL] roleplay" | Capability | **Partially stale** — hero tools re-promoted to CORE in v3.8.12; the remaining ActivateTool meta-layer may still help on GLM / nemotron free-tier. | `FRANKLIN_DYNAMIC_TOOLS=0` |
| 3 | Adversarial code verifier | `src/agent/verification.ts` | "Models stub features + ship broken code on frontier tasks" | Capability | **Holds** — Anthropic kept theirs on 4.6 because generators still stubbed. Same rule applies for Franklin's code tasks. | `FRANKLIN_NO_VERIFY=1` (new env, not implemented) |
| 4 | Groundedness evaluator | `src/agent/evaluator.ts` | "Models answer factual questions from training data even when live tools are available" | Capability | **Just added (v3.8.14)** — CRCL incident was direct evidence. Needs real-world burn-in. | `FRANKLIN_NO_EVAL=1` (already wired) |
| 5 | Context compaction | `src/agent/compact.ts` | "Near context limit, models exhibit context anxiety and wrap up prematurely" | Capability | **Partly stale** — Anthropic says Opus 4.6 largely killed context anxiety; they switched from compaction to context resets. Franklin still compacts. | Same-session long task with compaction on vs. off |
| 6 | Token reduction | `src/agent/reduce.ts` | "Old verbose tool results balloon context for no information value" | Infrastructure | **Permanent** — not a capability gap, a cost gap | Not a candidate for removal |
| 7 | Token optimization (size budgets, adaptive max_tokens) | `src/agent/optimize.ts` | "Large tool outputs + output slot reservations consume budget Franklin can spend elsewhere" | Infrastructure | **Permanent** — cost management, not model gap | Not a candidate |
| 8 | Tool guard (same-tool repeat, loop breaker) | `src/agent/tool-guard.ts` | "Agent gets stuck repeating the same Grep / Read call forever" | Agent-loop | **Permanent** — this is a loop-termination invariant independent of model capability | Not a candidate |
| 9 | Bash risk classifier (destructive command warning) | `src/agent/bash-guard.ts` | "Agent executes `rm -rf` / `git push --force` / DROP TABLE without realizing" | Safety | **Permanent** — safety layer, not capability layer | Not a candidate |
| 10 | Error classifier | `src/agent/error-classifier.ts` | "LLM gateway errors need categorization for correct retry / fallback behavior" | Infrastructure | **Permanent** | Not a candidate |
| 11 | Payment fallback to free models | `loop.ts` 402 handler | "Wallet can run out mid-session; session should degrade gracefully, not die" | Resilience | **Permanent** — economic invariant | Not a candidate |
| 12 | Empty-response fallback | `loop.ts` line 864 | "Models occasionally return empty content; same-model retry is deterministic waste, swap to a different model" | Resilience | **Permanent** | Not a candidate |
| 13 | Think-tag stripper | `src/agent/think-tag-stripper.ts` | "Reasoning-heavy models leak `<think>...</think>` into user-visible output when decoding is imperfect" | Output cleanup | **Permanent** — streaming UX invariant | Not a candidate |
| 14 | Planner → executor model swap mid-turn | `loop.ts` lines 773–784 | "Cheap executor model can follow a plan made by an expensive planner" | Capability | **Coupled to #1** — if #1 goes, this goes too | Covered by #1 test |
| 15 | Brain auto-recall | `loop.ts` lines 537–563 | "Model can't always remember entities from earlier in the same session" | Capability | **Low load** — nice UX, probably not critical. Test by disabling and measuring continuity. | Needs new env flag |
| 16 | Weak-model tool inventory injection | `loop.ts` lines 800–808 | "Weak / free models invent tool names when not given an explicit list" | Capability | **Holds for free tier**, likely **stale for Sonnet / Opus** | Split injection on model tier |
| 17 | Sub-agent delegation (Task tool) | `src/tools/subagent.ts` | "Main agent's context can't afford broad research; delegate to a fresh sub-agent" | Capability / context mgmt | **Holds** — basic parallelism + context isolation win | Not a candidate |

**Count:** 17 components.
- **Permanent / infrastructure** (not candidates for removal): 10 (#6–13, #17)
- **Capability-gap hedges worth re-testing now**: 7 (#1, #2, #4, #5, #14, #15, #16)
- **Just-added, needs burn-in**: 1 (#4)

---

## Priority ablation candidates

Of the 7 capability hedges, rank by highest expected payoff (confidence × size of impact if stale):

1. **#1 plan-then-execute** — Highest expected payoff. If stale, removes an entire two-call pathway. Easy to test via existing `/noplan`. Trigger is also clearly mis-shaped for research questions (only fires on code verbs).

2. **#5 context compaction → context reset** — If the article's Opus 4.6 result holds for 4.7, a reset pattern gives cleaner handoffs at long sessions. Requires writing the reset pathway before testing, so higher up-front cost.

3. **#16 weak-model tool inventory** — Cheap to split by tier. Medium impact.

4. **#2 ActivateTool meta-layer (remaining part)** — Already half-removed; the leftover may be redundant. Clean test.

5. **#15 brain auto-recall** — Nice UX; skip for now unless telemetry shows it's firing a lot.

---

## What we refuse to remove

These are NOT capability hedges; they encode invariants that don't evaporate when models improve:

- **Safety / destructive command guards** (#9) — a more capable model may in fact be *more* eager to delete things
- **Cost budgeting** (#6, #7) — spending money unnecessarily is a product flaw at any capability level
- **Payment / error fallback** (#10, #11, #12) — resilience to external systems
- **Tool loop breaker** (#8) — graph-termination invariant
- **Context isolation via sub-agents** (#17) — architectural separation, not a model crutch

---

## Ablation methodology

Follow the article's prescription: **remove one component at a time, measure, decide.**

Do NOT do a radical simplification pass — Anthropic tried that, couldn't tell what was load-bearing, and had to back up to one-at-a-time.

The bench script (`scripts/harness-bench.mjs`) fixes this:
1. A fixed set of ~15 prompts covering code / trading / research / edge cases
2. For each ablation, run the full bench with one env flag toggled
3. Record cost, latency, tool call count, final grounding verdict
4. Diff against baseline; sign decisions by data, not intuition

---

## Lessons from my (Franklin's maintainer's) own process

Things I did wrong this session that this audit is meant to prevent next time:

- Added `evaluator.ts` without first asking "can I reshape an existing component (e.g. planner trigger) to cover this?"
- Fixed CORE_TOOL_NAMES reactively based on one data point (CRCL) instead of checking whether the whole dynamic-visibility mechanism is still necessary.
- Hard-coded ticker examples into the system prompt (got called out, reverted).
- Shipped four releases (v3.8.12 → v3.8.14) in the same afternoon chasing symptoms.

The correct order is: **observe → map to assumption → check if existing component covers → ablate if stale → add only as last resort.**

---

## Review cadence

- Walk this table on every Opus / Sonnet / Haiku major release
- Run the bench script before + after; record deltas in this doc's changelog section
- Archive old audits so we can see how the harness shrank / grew over time

---

## Changelog

- **2026-04-21** — Initial audit on v3.8.14. 17 components enumerated. 5 ablation candidates ranked. Bench script scaffolded.
