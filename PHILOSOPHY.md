# Franklin Philosophy

## One sentence

**Franklin lets you give your AI a budget and walk away.**

Every other design decision in this repo falls out of that one sentence.

## Why a wallet

Autonomy requires accountability. An AI that can act on its own behalf
needs something it can spend, run out of, and stop at — not because we
asked it to, but because it physically cannot continue.

A subscription breaks this. Flat fees decouple agent actions from their
cost, which means:

- destructive actions have no upper bound
- token bloat is invisible to both the user and the agent
- single-vendor lock-in is automatic
- billing becomes a separate, opaque system
- agent misbehavior has no economic consequence

Fix the economic substrate and four of those five problems go away at
the same time. That substrate — for us — is a user-held USDC wallet
paying per-call via the x402 HTTP-402 micropayment protocol.

The wallet isn't a feature. The wallet is the mechanism that makes
every other promise of autonomous AI actually hold.

## What we are not

**Franklin is not a Claude Code alternative.** The comparison misses the
category. Coding copilots are about typing speed and intent capture.
They assume a human is watching. We are about *what the AI does when
nobody is watching* — and the thing that makes it safe to look away is
the budget.

**Franklin is not "cheaper AI."** You can find cheaper. Cheap without a
wallet is just someone else subsidizing your waste while capping your
autonomy. That's a worse tradeoff than paying per-action against a
budget you chose.

**Franklin is not "AI with crypto strapped on."** The wallet isn't
aesthetic. Remove it and you cannot deliver budget-bounded autonomy at
all. The payment layer isn't a grace note; it's the instrument.

## What we are

Franklin is the reference implementation of an **Economic Agent** — an
AI agent that:

1. holds a wallet you funded,
2. prices every action before taking it,
3. signs a USDC micropayment for every paid call,
4. stops — structurally, not politely — when the wallet is empty.

That shape unlocks things general-purpose chat agents cannot do:

- *An autonomous task that runs for an hour without babysitting*, because
  the worst-case spend is the wallet balance.
- *A multi-provider router*, because no subscription locks you in — the
  wallet doesn't care which model answered.
- *A per-action receipt*, because every payment has an on-chain
  signature.
- *Access without a bank account*, because the only identity you need
  is a public address.
- *No tier, no limit, no overdraft*, because the balance itself is the
  only rate limiter.

The Economic Agent category is what Franklin exists to demonstrate. The
code is evidence, not the product. The product is the pattern.

## What "good" looks like

If we are doing this right, a user can:

1. Fund a wallet with $20.
2. Give Franklin a task longer than their attention span.
3. Walk away.
4. Come back to either the finished work or an empty wallet — and in
   both cases, know exactly what happened and what it cost.

Every feature we ship should be tested against that path. If it makes
that path more certain, more transparent, or more trustable, it belongs.
If it's a coding-copilot feature that makes Franklin a better typing
assistant but doesn't touch step 2–4, it's a distraction.

## The test we never stop running

For every decision — what to build, what to deprecate, how to write
marketing, what to tell users — we ask:

> *Does this move Franklin toward "you can trust it with money and
> leave" — or toward "it's a nicer prompt box"?*

The first is the thing. The second is table stakes. We don't compete on
table stakes.

## Who this is for

Franklin is built for people who:

- are done paying subscriptions for capacity they don't use,
- have tried to run an agent unattended and been burned,
- hold crypto and are tired of AI products that don't recognize that
  wallet as identity,
- want the AI to be honest about what each action costs, per call, in
  real dollars.

We are not trying to be everyone's first AI. We are trying to be the
first AI anyone trusts with autonomy.

## On reliability

The current generation of models is not reliable enough to "hire" in
the human-employee sense. We know this. Our users will tell us so (and
they already have). Our answer is not to hide the unreliability — it's
to make unreliable AI *safe to run at scale* by giving the user a hard
economic ceiling underneath it.

A model that fails 30% of the time on a subscription = wasted month.
A model that fails 30% of the time on a \$5 wallet = $1.50 of wasted
money and a full set of receipts showing where it went wrong.

That's the asymmetry we're betting on: **the economic layer makes
imperfect AI usable today, while the model layer catches up to the
autonomy promise over time.**

Subscriptions bet on the model being perfect. We bet on the money
being honest.

---

*Franklin is open-source (Apache-2.0) at
[`github.com/BlockRunAI/Franklin`](https://github.com/BlockRunAI/Franklin).
Docs live at [franklin.run](https://franklin.run).*
