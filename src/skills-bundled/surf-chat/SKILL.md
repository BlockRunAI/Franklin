---
name: surf-chat
description: Crypto-native chat with citations via the surf-1.5 model. Different from a generic LLM call — surf-1.5 is grounded in live crypto data and returns first-class citations (source links + charts). Use when the user wants research-shaped answers about projects, tokens, market events, or DeFi protocols, with sources attached.
triggers:
  - "surf chat"
  - "crypto research"
  - "ask surf"
  - "with citations"
  - "grounded answer"
argument-hint: <research question>
cost-receipt: true
---

You are running inside Franklin on **{{wallet_chain}}**. The `surf-1.5` model is crypto-native: it knows current market data, projects, on-chain flow, social signal, and returns structured citations. Reach for it when the user wants a sourced answer rather than a vibes-based one.

**Chain note:** Surf currently settles x402 payments on **Base** only. If the user's active chain is `solana`, ask them to `/chain base` before calling — surf-1.5 is $0.02/call, so a failed payment retry isn't free.

## How to use

Call:

```
BlockRun({
  path: "/v1/surf/chat/completions",
  method: "POST",
  body: {
    model: "surf-1.5",
    messages: [
      { role: "user", content: "<the question>" }
    ],
    citation: ["source", "chart"]
  }
})
```

Cost: **flat $0.02 per call** (per-token billing is Phase 2 upstream).

### Response shape

OpenAI-compatible, with two extras:
- `choices[0].message.content` — the text answer
- `choices[0].message.citations[]` — array of `{ type: "source" | "chart", url, title }`

When you report back to the user, **always include the citations** as a footer:

```
[Answer text]

Sources:
1. <title> — <url>
2. <title> — <url>
```

If `citations` is empty, mention that the answer is ungrounded.

### Multi-turn

Pass previous `messages` back in for follow-up turns. Each turn is $0.02.

## When to use surf-chat vs the main agent loop

- **Use surf-chat** when: the question is about market state, project research, narrative tracking, or "what happened to X in the last week" — anywhere fresh crypto context matters and you want citations to share with the user.
- **Use the main agent loop** (no surf-chat) when: the question is general reasoning, coding, planning, summarization of content already in scope, or anything where adding citations doesn't add value.

The wallet is funding the surf-chat call directly — be deliberate about reaching for it.

## When to use surf-chat vs the data endpoints

- **surf-chat** is good when you don't know which endpoints to compose, or when the answer is qualitative ("what's the bull case for $X?").
- The **`/surf-market` / `/surf-chain` / `/surf-social` skills** are better when the question is structured ("price of BTC", "RSI on ETH", "wallet net worth") — they're $0.001–$0.005 each and you keep full control of the data.

If you can answer with one $0.001 call to a data endpoint, do that. Only escalate to surf-chat when the question needs synthesis across many endpoints or the user explicitly asks for cited research.

## The user asked

$ARGUMENTS
