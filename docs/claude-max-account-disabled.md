# Paid $200 for Claude Max. Account Disabled. No Response from Support.

> _You upgraded to Claude Max 5x. Entered your credit card. Account immediately disabled. No warning. No email. Support takes days to respond. You can't work._

---

## It Happens More Than You Think

From [anthropics/claude-code#5088](https://github.com/anthropics/claude-code/issues/5088) (49 upvotes, 160 comments):

> _"I just updated my billing details before purchasing. I am devastated as I am unable to get a response and I just paid a lot for this."_

> _"I am so upset that I did not even receive any warning or email that I violated something that led to the disablement."_

> _"On August 1, my two accounts (one personal, one for work) were unexpectedly disabled. I discovered this after receiving refund emails for both accounts."_

This issue has been open since mid-2025. Users pay $100-$200/month and get locked out the same day. Some never get their accounts back.

---

## The Phone Verification Wall

Even before you can pay, you might not get in. [#34229](https://github.com/anthropics/claude-code/issues/34229) is the **second most upvoted issue** in the entire Claude Code repo: **747 upvotes, 667 comments.**

> _"Why did this error persist for so long and no dev noticed? You're losing new users."_

> _"None of the phone numbers work for signup! Switching devices or using new numbers doesn't make any difference either."_

> _"I don't even get an error, I just never get an SMS with the code."_

The pattern:
1. Developer wants to use Claude Code
2. Phone verification SMS never arrives
3. They try different phones, different countries
4. No workaround exists
5. They give up or switch to a competitor

---

## Why This Happens

Anthropic uses phone verification as an anti-abuse measure and subscription billing through Stripe. Both systems have failure modes:

- **Phone verification**: SMS delivery varies by carrier and country. Many VoIP numbers are blocked. Some countries have low delivery rates.
- **Account disabling**: Triggered by billing flags, geographic anomalies, or usage patterns that match abuse heuristics. No appeal process is documented.
- **Support response time**: Days to weeks, per user reports.

The fundamental issue: **a subscription model requires an account, and an account can be disabled.**

---

## The Alternative: No Account Needed

[RunCode](https://github.com/BlockRunAI/runcode) doesn't have accounts. There's nothing to disable.

```bash
npm install -g @blockrun/runcode
runcode
```

RunCode uses a local crypto wallet (USDC on Base) instead of an account. Your wallet is on your machine. Nobody can disable it. Nobody can lock you out.

| | Claude Max | RunCode |
|---|---|---|
| Account required | Yes | **No** |
| Phone verification | Yes (often broken) | **No** |
| Can be disabled | Yes (no warning) | **No -- wallet is yours** |
| Support needed to unlock | Yes (days to respond) | **N/A** |
| Payment method | Credit card | USDC (crypto) |
| Refund on disable | Sometimes | **N/A -- pay per use** |

### How it works

Instead of paying a monthly subscription to an account that can be suspended, you pay per request from a wallet you control:

```
Your wallet (USDC) → RunCode → BlockRun → Claude API
                      signs payment     same models
                      locally           no account
```

Your private key never leaves your machine. BlockRun can't freeze your funds. If you stop using RunCode, your USDC is still yours.

---

## Same Claude, No Account Risk

RunCode routes to the same Claude models (Sonnet 4.6, Opus 4.6, Haiku 4.5) via BlockRun's API gateway. The quality is identical -- it's the same Anthropic API underneath.

The difference: you're paying per token instead of per month, and there's no account to disable.

Plus, you get 41+ other models. If Claude goes down or gets rate limited on Anthropic's side, switch to GPT-5.4 or Gemini with `/model gpt` -- no interruption to your work.

---

## Getting Started

```bash
npm install -g @blockrun/runcode

# Test with a free model first (no wallet needed)
runcode
/model nemotron

# Fund your wallet when ready
# $5 USDC on Base = ~1 week of coding
```

No phone number. No credit card. No account that can be disabled. Just code.

---

**Links:**
- [RunCode on GitHub](https://github.com/BlockRunAI/runcode)
- [RunCode on npm](https://npmjs.com/package/@blockrun/runcode)
- [BlockRun](https://blockrun.ai)
