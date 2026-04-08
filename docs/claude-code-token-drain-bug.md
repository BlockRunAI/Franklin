# Claude Code Is Burning Your Tokens 4x Faster Than It Should

> _Same projects. Same routines. Same time. But today it burns through your 5-hour limit 4x faster. Your quota drops while you're not even typing._

---

## The Phantom Token Drain

From [anthropics/claude-code#16856](https://github.com/anthropics/claude-code/issues/16856) (68 upvotes, 69 comments):

> _"I am working on the same projects for months, same routines, same time. But today it hits 5h limits like 4+ times faster! I am already on MAX and before today I would usually never hit even 50% weekly cap."_

> _"Just waited for 5 hour reset, ran /usage and got 3% already used. Like what? Where did my 3% 5h limit just go?"_

From [#38239](https://github.com/anthropics/claude-code/issues/38239) (56 upvotes, 62 comments):

> _"Just had this happen to me. Used minimal prompts like I usually do, and within 30 minutes, I have already used up my 5-hour window. I'm on a max subscription."_

From [#6457](https://github.com/anthropics/claude-code/issues/6457) (30 upvotes, 119 comments):

> _"Something is definitely wrong with their usage limits calculation. I'm getting the same thing after literally only running a /compact command today."_

---

## Why Your Tokens Disappear

Three things are eating your quota silently:

### 1. The 1M Context Window Tax

Claude Code now supports 1M token context windows. This means every turn sends the **entire conversation history** to the API. A 30-minute session might have 200K tokens of context. Each prompt you send costs 200K+ input tokens even if your actual message is 10 words.

> _"The 1M context thing would make sense. Bigger window = more tokens per turn even if your actual prompts are the same size, since the full conversation gets sent every time."_

### 2. Auto-Compaction Burns Tokens

When conversations get long, Claude Code runs `/compact` automatically. Compaction itself is an API call that processes the entire conversation. Users report hitting rate limits just from compaction running in the background.

### 3. Version-Specific Regressions

Multiple issues trace sudden token drain to specific Claude Code updates:

> _"Rolled back to 2.0.61 and my usage seems normal again."_

Updates can change how aggressively context is sent, how often compaction runs, or how tools are invoked. Users have no visibility into these changes.

### The core problem: you can't see what you're spending

Claude Max shows a usage percentage that:
- Doesn't correspond to actual tokens used
- Updates inconsistently
- Sometimes shows low usage while you're rate limited
- Has no breakdown of where tokens went

---

## RunCode: Every Token Visible

[RunCode](https://github.com/BlockRunAI/runcode) shows you exactly what you're spending in real time:

```
╭──────────────────────────────────────────╮
│ Type a message...                        │
╰──────────────────────────────────────────╯
 anthropic/claude-sonnet-4.6  ·  $4.02 USDC  -$0.0234
```

That bottom line updates on every request. You see:
- **Your wallet balance** ($4.02 USDC)
- **Session cost so far** (-$0.0234)
- **The exact model** being used

No hidden consumption. No phantom drain. If a compaction costs tokens, you see it. If context is growing, you see the cost increase per turn.

### Smart token management built in

RunCode actively fights token waste:

- **Automatic context compaction** when approaching limits -- but you see the cost
- **Tool result deduplication** -- strips redundant output to save tokens
- **ANSI stripping** -- removes terminal formatting from tool results
- **Per-request cost tracking** -- every API call logged with exact token count

### Switch to cheaper models when you don't need Claude

Most coding tasks don't need Opus. RunCode lets you use the right model for the job:

```
/model deepseek    # $0.28/$0.42 per 1M tokens -- 10x cheaper than Claude
/model flash       # $0.30/$2.50 per 1M tokens -- Google Gemini Flash
/model free        # $0.00 -- NVIDIA free tier
/model sonnet      # When you actually need Claude quality
```

A typical workflow: use DeepSeek or free models for routine tasks, switch to Claude for hard problems. This alone cuts costs 5-10x versus using Claude for everything.

---

## The Comparison

| | Claude Code (Max) | RunCode |
|---|---|---|
| Token visibility | Usage % (unreliable) | **Exact token count + cost per request** |
| Phantom drain | Yes (background compaction, context) | **All costs visible in real time** |
| Cost per session | Unknown (hidden behind %) | **Shown in dollars** |
| Compaction cost | Hidden | **Visible** |
| Model switching | Not possible | **Instant: /model** |
| Cheapest option | $20/month (Pro, rate limited) | **$0 (free NVIDIA models)** |
| Version regressions | Can't detect | **Cost spike is immediately visible** |

---

## Getting Started

```bash
npm install -g @blockrun/runcode
runcode

# Start cheap to see how tokens flow
/model deepseek

# Check your spend anytime
/stats
```

See exactly where every token goes. No surprises.

---

**Links:**
- [RunCode on GitHub](https://github.com/BlockRunAI/runcode)
- [RunCode on npm](https://npmjs.com/package/@blockrun/runcode)
- [BlockRun](https://blockrun.ai)
