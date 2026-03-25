# Claude Code Rate Limits Are Broken. Here's the Fix.

> _You're paying $200/month for Claude Max. You hit "usage limit reached" after 90 minutes. Your account gets disabled. Phone verification fails. You can't work._

---

## The $200/Month Problem

From [anthropics/claude-code#16157](https://github.com/anthropics/claude-code/issues/16157) (1,252 comments):

> _"Instantly hitting usage limits with Max subscription. I've been a paying customer since launch. Today I can't get through a single coding session without being rate limited."_

From [#29579](https://github.com/anthropics/claude-code/issues/29579) (89 comments):

> _"Rate limit reached despite Max subscription and only 16% usage. The usage meter shows 16% but I'm locked out. Support says 'wait 5 hours.'"_

From [#5088](https://github.com/anthropics/claude-code/issues/5088) (145 comments):

> _"Account disabled after payment for Max 5x plan. Paid $1,000. Account immediately disabled. No response from support for 3 days."_

From [#34229](https://github.com/anthropics/claude-code/issues/34229) (546 comments):

> _"Phone verification — unable to send verification code. I can't even sign up. I've tried 4 different phone numbers across 2 countries."_

This isn't a niche problem. **4,350+ comments across dozens of issues.** These are professional developers who can't do their jobs.

---

## Why This Keeps Happening

Claude Code's pricing model has a fundamental conflict:

**Anthropic sells unlimited-sounding subscriptions ($20-200/month) but enforces unpublished usage caps.** The exact limits are not documented. They change without notice. The usage meter is unreliable. And when you hit the invisible wall, you're locked out for hours.

The result:

| What they promise | What happens |
|-------------------|-------------|
| "Max plan — highest usage" | Rate limited after 90 minutes |
| "5x more usage" | Account disabled after payment |
| "Usage: 16%" | "You've hit your limit" |
| "Phone verification" | Code never arrives |
| "$200/month" | Can't complete a single session |

---

## The Fix: Pay Per Token, Not Per Month

**brcc** ([github.com/BlockRunAI/brcc](https://github.com/BlockRunAI/brcc)) takes a different approach: you pay for exactly what you use. No subscriptions. No limits. No accounts.

```bash
sudo npm install -g @blockrun/cc  # use sudo on Linux
brcc setup base
brcc start
```

Three commands. Claude Code opens. You have access to 50+ models. No rate limits.

### How it works

brcc runs a local proxy between Claude Code and [BlockRun](https://blockrun.ai), an AI API gateway that accepts USDC micropayments:

```
Claude Code → brcc (localhost) → BlockRun → Any model
                signs payment      50+ models
                with your wallet   pay per token
```

Every request is paid individually via the [x402 protocol](https://x402.org). Your wallet has USDC → you can make requests. No USDC → no requests. No ambiguity. No invisible limits.

### What it costs

| Model | Cost per 1K tokens | ~Cost per coding session |
|-------|-------------------|-------------------------|
| Claude Sonnet 4.6 | ~$0.009 | ~$0.50-2.00 |
| GPT-5.4 | ~$0.009 | ~$0.50-2.00 |
| DeepSeek V3 | ~$0.0004 | ~$0.02-0.10 |
| Claude Opus 4.6 | ~$0.015 | ~$1.00-5.00 |
| NVIDIA GPT-OSS 120B | **Free** | **$0.00** |

A typical developer spends **$5-15/week** using brcc. Compare that to $200/month for a Max subscription that doesn't work.

---

## But I Want Claude Specifically

You can still use Claude through brcc. BlockRun routes to Anthropic's Claude API — same models, same quality. The difference:

- **Claude Max**: $200/month, opaque limits, account locks
- **Claude via brcc**: ~$2/day for heavy use, no limits, no account

And you get a bonus: **access to every other model too.** Need GPT-5 for reasoning? Gemini for long context? DeepSeek for cheap bulk work? Switch with `--model` or `/model` inside Claude Code.

---

## Who Should Use brcc

**You should use brcc if:**
- You've been rate limited on Claude Max
- You can't verify your phone number
- You're in a region where Claude is expensive or unavailable
- You want to use models other than Claude in Claude Code
- You want transparent, predictable pricing
- You're an agent developer who needs programmatic access without OAuth

**You should keep Claude Max if:**
- You never hit rate limits (lucky you)
- You only use Claude and don't need other models
- You prefer subscription pricing over pay-per-use

---

## Getting Started

```bash
# Install (one line)
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/brcc/main/install.sh | bash

# Or manual
sudo npm install -g @blockrun/cc  # use sudo on Linux
brcc setup base
brcc start --model nvidia/nemotron-ultra-253b  # Free model to test
```

Fund your wallet with $5 USDC on Base. That's enough for a week of heavy coding.

---

**Links:**
- [brcc on GitHub](https://github.com/BlockRunAI/brcc)
- [brcc on npm](https://npmjs.com/package/@blockrun/cc)
- [BlockRun](https://blockrun.ai)
- [Telegram](https://t.me/blockrunAI)
