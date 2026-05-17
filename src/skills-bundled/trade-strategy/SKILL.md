---
name: trade-strategy
description: Write a long-form trading strategy document — thesis, entry triggers, exit rules, position sizing, hold horizon, kill criteria. No trade is fired. Saves a structured markdown note to ~/.blockrun/notes/. Use when the user wants to plan an approach before committing capital.
triggers:
  - "trading strategy"
  - "write a strategy"
  - "strategy doc"
  - "trade plan"
  - "planning a trade"
argument-hint: <topic or thesis>
cost-receipt: false
---

You are running inside Franklin on **{{wallet_chain}}**. This skill captures *intent* before *action*. The user wants a written strategy, not an executed trade. Result: a markdown file under `~/.blockrun/notes/` that the user (and future Franklin sessions) can reference when the actual trade fires via `/trade-signal`.

## Workflow

1. **Clarify if needed.** If the argument is just a ticker ("BTC") without a direction, ask one clarifying question about what the user is trying to do (long, short, range, event-driven).

2. **Gather supporting context.** Use the `/surf-market`, `/surf-chain`, or `/surf-social` skills to pull data that informs the strategy. Each surfaces its own cost; mention what you spent at the end.

3. **Write the strategy doc.** Use the `Write` tool to create:

   - Path: `~/.blockrun/notes/<YYYY-MM-DD>-<slug>-strategy.md` (replace `~` with the user's actual home dir; ask if you don't know it, or run `Bash("echo $HOME")` once)
   - Slug: short kebab-case identifier derived from the topic (e.g. `btc-pre-halving-long`)
   - Content template:

```markdown
# Strategy — <Title>

**Date:** <YYYY-MM-DD>
**Author:** Franklin (skill: /trade-strategy)
**Status:** draft

## Thesis

<2–4 paragraphs: why this trade now. Cite the data sources you pulled.>

## Symbols & direction

- Primary: <SYMBOL> <long|short>
- Hedges (if any): <SYMBOL> <long|short>

## Entry triggers

- <Specific price levels, indicator readings, or events that must hold>
- <…>

## Position sizing

- Per-symbol notional cap: $<N> (vs Franklin's $400 default)
- Conviction tier: <1–5> — justification: <…>

## Exit rules

- Take profit: <price | indicator | event>
- Stop loss: <price | indicator | event>
- Time stop: exit by <date / horizon> regardless

## Kill criteria

What invalidates the entire thesis? (Be specific — name a level, a metric, or a market regime change.)

## Evidence

- <source 1>
- <source 2>
- <indicator reading>

## Tags

`<momentum>` `<macro>` `<event>` (etc.)

## Linked trades

(Populated as `/trade-signal` invocations reference this doc.)
```

4. **Confirm the path.** Report back to the user: "Strategy saved to `<path>`. Open it with your editor or pull it into your next `/trade-signal` call as context. Discipline score on the strategy is captured when the first trade fires."

5. **Do not call `TradingOpenPosition`.** This skill is plan-only. The user fires the trade separately via `/trade-signal` when ready.

## Anti-patterns

- Skipping kill criteria. Every strategy has them; "I'll know when to exit" is not a strategy.
- Position sizing without conviction-justified caps. A conviction-2 strategy that loads the full $400 cap is theater.
- Writing a strategy doc and immediately firing a trade. The point of separating the two is to force a pause. If the user wants both, run `/trade-strategy` first, then `/trade-signal` referencing the saved file.

## The user said

$ARGUMENTS
