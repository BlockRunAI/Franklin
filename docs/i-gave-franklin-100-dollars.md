# I Gave Franklin $100 USDC and Asked It to Launch a Product

A worked walk-through of what an Economic Agent can actually buy you
on a one-week content launch. Numbers are live pricing as of
publication.

---

## The setup

One terminal. One prompt. One wallet.

```bash
franklin setup base
franklin balance
# Chain:  base
# Wallet: 0x3a7f…1e22
# USDC Balance: $0.00
```

I sent $100 USDC on Base to the wallet address. The balance became
`$100.00`. Everything that follows comes out of that $100 — no
subscription, no API keys, no tiers, no backup budget.

```bash
franklin
# Franklin v3.8.4 — The AI agent with a wallet.
# > _
```

The goal: take a small open-source library I'd just finished writing
and produce a week-long launch package. Research brief, blog post,
hero image, short video, and scheduled content reminders that
Franklin would manage. Franklin would decide what to call, what to
pay for, and when to stop.

Here's what actually happened.

---

## Day 1 — Research and launch brief

**Prompt:**

> Research how small open-source TypeScript libraries in the
> observability space position themselves in their READMEs and
> launch blog posts. Look at 10 recent launches that seemed to get
> traction. Pull the patterns, don't copy them.

Franklin's response timeline:

```
✓ WebSearch "TypeScript observability library"   $0.003
✓ WebSearch "open source TS library launch"      $0.003
✓ WebFetch  repo #1 README                       $0.002
✓ WebFetch  repo #2 README                       $0.002
✓ WebFetch  repo #3 README                       $0.002
✓ WebFetch  repo #4 README                       $0.002
✓ WebFetch  repo #5 README                       $0.002
✓ WebFetch  repo #6 README                       $0.002
✓ WebFetch  repo #7 README                       $0.002
✓ WebFetch  repo #8 README                       $0.001
✓ WebFetch  repo #9 README                       $0.001
✓ WebFetch  repo #10 README                      $0.001

Sonnet-tier · 14.2K in / 3.1K out · $0.0312  saved 82%
```

Total for the research: **$0.053**.

The reply was a distilled pattern analysis (hook → problem → unique
angle → tiny code snippet → invitation) and a launch-brief draft
applied to my library. I reviewed, tweaked, asked Franklin to
rewrite two weak sections, and filed the final version in
`~/drafts/launch-brief.md`.

Day-1 spend: **$0.09**. Balance: **$99.91**.

---

## Day 2 — Long-form blog post

**Prompt:**

> Expand the brief into a 1500-word launch blog post. Use the same
> hook. Add a small API example. Mention the library's TypeScript-
> first design. Output to `~/drafts/launch-post.md`.

Franklin picked a Sonnet-tier model for this one (`COMPLEX`,
writing-heavy) and produced a single-pass draft. Total:

```
Sonnet · 18.4K in / 4.8K out · $0.0476  saved 76%
```

I asked for two revisions — tightening the intro, shortening the API
snippet. Each revision was another $0.02–0.04. The final post sat at
`~/drafts/launch-post.md`.

Day-2 spend: **$0.14**. Balance: **$99.77**.

---

## Day 3 — Hero image for the launch

**Prompt:**

> Generate a hero image for the library. Subject: abstract geometric
> shapes evoking routing, minimalist, dark background, 1024x1024.

```
✓ ImageGen  "abstract geometric shapes…"  $0.042

Image saved to ~/drafts/hero-v1.png (1024x1024)
```

It came back in 14 seconds. I asked for three variants (different
color palettes) and one with a tighter crop. Each $0.042. I kept the
fourth one.

Day-3 spend: **$0.17** (4 images). Balance: **$99.60**.

Worth flagging: Franklin wouldn't let me generate a 5th image without
asking first. The `ImageGen` tool's description tells the model to
confirm before iterating — so the agent paused and said "want
another, or keep v4?" That's a simple prompt-engineered guardrail,
not a wallet constraint, but it felt right.

---

## Day 4 — A 10-second launch video

**Prompt:**

> Use hero-v4.png as a seed image and generate an 8-second video:
> subtle camera dolly forward, the geometric shapes slowly rotating,
> same color palette. Save to `~/drafts/launch-clip.mp4`.

Franklin picked up the `VideoGen` tool (xAI Grok-Imagine). The CLI
warned me:

```
⚠️  VideoGen is expensive and slow. Cost: ~$0.42 (8s @ $0.05/s).
   Continue? (y/n)
```

I hit `y`. Franklin issued the call. The BlockRun gateway replied
402 Payment Required with the cost, Franklin signed a USDC transfer
on Base, retried, the gateway streamed the upstream xAI job status,
and ~50 seconds later I had:

```
Video saved to ~/drafts/launch-clip.mp4 (2.1MB, 8s, xai/grok-imagine-video)

Open with: open ~/drafts/launch-clip.mp4
```

I watched it. The dolly was subtle but nice. I didn't ask for a
second variant — $0.42 felt like "get it right once, don't gamble."

Day-4 spend: **$0.42**. Balance: **$99.18**.

Here's the thing — if the wallet had held $0.30 instead of $99.18,
the call would have failed at the 402-sign step. Not because the CLI
asked me, but because I literally could not sign a $0.42 payment
against a $0.30 balance. That's the hard floor. Can't spend what's
not there.

---

## Day 5 — Telegram-driven review and content queue

I like working from my phone. I ran `franklin telegram` on my
always-on laptop, pointed at a bot I'd registered with `@BotFather`,
and set `TELEGRAM_OWNER_ID` to my numeric Telegram user id.

From Telegram:

> **Me:** Read `~/drafts/launch-brief.md` and give me 12 one-line
> summary variants I could copy-paste into whatever platform I want
> to post on this week. Save them to `~/drafts/launch-snippets.md`
> and tell me which three are strongest.

Franklin's reply came back a minute later in Telegram, chunked at
paragraph boundaries:

> ⏳ Read…
> ⏳ Write…
> Saved 12 snippets to `~/drafts/launch-snippets.md`. My three
> strongest picks (by specificity + hook): #3, #7, #11.
> Cost: $0.024

I spent the rest of the week copy-pasting from that file to the
platforms I actually use. Franklin wasn't trying to own my
distribution channels — it just gave me clean, priced, ready-to-go
copy on my phone whenever I wanted it. Every re-request to polish
one ran under 3 cents.

Day-5 spend: **$0.18** (snippets + three polish passes). Balance:
**$99.00**.

---

## Total after a week

| Day | Artifact | Spend |
|---|---|---|
| 1 | Research + launch brief | $0.09 |
| 2 | 1500-word blog post + 2 revs | $0.14 |
| 3 | 4 hero image variants | $0.17 |
| 4 | 8-second launch video | $0.42 |
| 5 | Telegram-driven snippets + polish | $0.18 |
| | **Total** | **$1.00** |

Balance: **$99.00**.

I spent **one dollar** on a full week's launch content — brief,
blog post, 4 image variants, a video, and a portable snippet sheet
I could post from anywhere. The subscription I would have canceled
to fund this would have cost me $40 minimum for the month.

The remaining $99 is still sitting in the wallet waiting for next
week's work.

---

## The part that matters

This walk-through understates the thing that actually changed for me.
It's not the one dollar — it's that I can look at `franklin insights`
and see *exactly* where every one of those 100 pennies went.

```
Per-model breakdown:
  anthropic/claude-sonnet-4.6       $0.43   8 requests
  openai/gpt-image-1                $0.168  4 requests
  xai/grok-imagine-video            $0.42   1 request
  nvidia/nemotron-ultra-253b        $0.00  12 requests (free tier)
  google/gemini-2.5-flash           $0.04   4 requests
```

Every paid action has a USDC receipt. Every model switch is logged.
Every tool call is priced and itemized. If Franklin ever does
something I didn't authorize, I'll see it on that list. If I top up
the wallet with $10, I know exactly what $10 buys me.

That visibility is what I actually bought with $100. The dollar of
work is almost a side effect.

---

## How to try it

```bash
npm install -g @blockrun/franklin
franklin setup base      # or: franklin setup solana
franklin balance         # shows your new wallet address
# Send $5 of USDC to that address on Base or Solana
franklin                 # start the agent
```

Free-tier NVIDIA models run at $0.00/call — you don't need to fund
the wallet to try the product. The wallet lights up the frontier
models and the paid tools (images, video, web search at volume).

The first $5 is genuinely a lot of AI work when you only pay for the
outcome.

---

*Franklin is open-source (Apache-2.0) at
[`github.com/BlockRunAI/Franklin`](https://github.com/BlockRunAI/Franklin).
The numbers in this post are illustrative — actual per-call prices
reflect current BlockRun gateway rates, which vary by model.*
