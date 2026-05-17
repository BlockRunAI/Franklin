---
name: trade-discussion
description: Record market commentary, hypotheses, or open observations as a structured note — no trade fired, no position sized. Lighter than /trade-strategy. Saves to ~/.blockrun/notes/ for future reference. Use when the user wants to think out loud about the market.
triggers:
  - "market commentary"
  - "trade discussion"
  - "observation"
  - "just thinking"
  - "market thought"
  - "log a thought"
argument-hint: <topic>
cost-receipt: false
---

You are running inside Franklin on **{{wallet_chain}}**. This skill is the lightest of the three trading skills — no trade, no full strategy doc, just a short observation with enough structure to be useful later.

## Workflow

1. **Gather context only if cheap or asked.** Don't burn $0.005 on a chain query for a discussion note unless the user requested data. Default: write the note from what you already know.

2. **Write the note.** Use the `Write` tool to create:

   - Path: `~/.blockrun/notes/<YYYY-MM-DD>-<slug>-discussion.md`
   - Slug: 3–5-word kebab-case (e.g. `etf-flow-divergence-watch`)
   - Content template:

```markdown
# Discussion — <Title>

**Date:** <YYYY-MM-DD>
**Author:** Franklin (skill: /trade-discussion)

## Observation

<1–3 paragraphs.>

## Symbols mentioned

`<SYMBOL1>` `<SYMBOL2>` (etc.)

## Tags

`<sentiment>` `<watch>` `<thesis-fragment>` (etc.)

## Open questions

- <Question 1 — what would confirm or invalidate this?>
- <Question 2>

## Possible follow-ups

- `/surf-market` for <specific data>
- `/surf-social` for <specific KOL or mindshare check>
- `/trade-strategy` if this matures into a plan
- `/trade-signal` if a clear entry emerges
```

3. **Confirm.** Report back: "Note saved to `<path>`. Tagged `<tags>`. No trade fired. If this hardens into a plan, run `/trade-strategy <topic>`."

4. **Do not call `TradingOpenPosition`.** Discussion notes are explicitly trade-free.

## When this skill fits vs the alternatives

- **`/trade-discussion`** — open-ended observation, hypothesis, "what if". Cheapest, least structured.
- **`/trade-strategy`** — committed plan with entry/exit/sizing. Reach for this when an observation has hardened.
- **`/trade-signal`** — the actual trade. Fires `TradingOpenPosition`, hits the wallet (paper trading) and the journal.

## The user said

$ARGUMENTS
