# brcc Roadmap

## Vision

brcc = Claude Code + any model + no rate limits + pay-per-use USDC

The goal is to let any developer run Claude Code with any LLM model, selecting and switching models freely, paying only for what they use.

## Current State (v0.5.0)

```
User runs: brcc start --model openai/gpt-5.4

  brcc proxy (localhost:8402)
    ├── Receives Anthropic-format requests from Claude Code
    ├── Overrides model name to user's choice
    ├── Signs x402 payment with user's wallet
    └── Forwards to blockrun.ai/api/v1/messages
```

**Working:**
- `brcc setup base|solana` — create wallet
- `brcc start --model <model>` — start proxy + launch Claude Code
- `brcc models` — list 40+ models with pricing
- `brcc balance` — check USDC balance
- Dual chain support (Base + Solana)
- Free model (nvidia/gpt-oss-120b) tested end-to-end

**Limitations:**
- Cannot switch models inside Claude Code — must restart with different `--model`
- Claude Code's `/model` only shows Anthropic models
- Auth conflict warning when user has existing claude.ai login

---

## Phase 1: Dynamic Model Selection (next)

### Goal
Let users switch between any BlockRun model inside Claude Code without restarting.

### Approach: Combine tweakcc + claude-code-router patterns

**From [tweakcc](https://github.com/Piebald-AI/tweakcc):**
- `allowCustomAgentModels` patch — removes Claude Code's model name validation
- Enables arbitrary model names in Claude Code's `/model` picker
- Patches Claude Code's minified JS directly

**From [claude-code-router](https://github.com/musistudio/claude-code-router):**
- Dynamic `/model provider,model_name` syntax inside Claude Code
- Smart routing based on task type (simple/complex/reasoning/long-context)
- Transformer chain for format conversion between providers
- Per-subagent model override via tags

### Implementation Plan

#### 1. Add tweakcc patching to brcc

```bash
brcc patch          # Patch Claude Code to allow custom model names
brcc patch --undo   # Restore original Claude Code
```

Key patches to apply:
- `allowCustomAgentModels` — unlock arbitrary model names
- `contextLimit` override — support models with different context windows
- `subagentModels` — set different models for plan/explore/general-purpose agents

Reference: `/Users/vickyfu/tmp/tweakcc/src/patches/`

#### 2. Smart model routing in proxy

Borrow from ClawRouter's 14-dimension classifier:

```
Claude Code request → brcc proxy analyzes request →
  Simple task (definitions, math) → cheapest model (DeepSeek, NVIDIA free)
  Code task (editing, debugging) → code-optimized model (Claude Sonnet, GPT-5)
  Reasoning task (proofs, planning) → reasoning model (o3, Grok reasoning)
  Long context (large files) → large context model (GPT-5.4 1M, Gemini)
```

User can override with explicit `/model` selection.

Reference: `/Users/vickyfu/Documents/blockrun-web/ClawRouter/`

#### 3. Env var model mapping

brcc start sets these env vars so Claude Code's built-in `/model` picker maps to BlockRun models:

```bash
ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-chat  # cheap alternative
CLAUDE_CODE_SUBAGENT_MODEL=anthropic/claude-haiku-4.5
```

User can customize in `~/.blockrun/brcc-config.json`.

#### 4. Transformer chain

For non-Anthropic models, the proxy needs format conversion:

```
Claude Code (Anthropic format)
  → brcc proxy
    → If Anthropic model: pass through to /v1/messages
    → If OpenAI model: convert Anthropic→OpenAI format, call /v1/chat/completions
    → Convert response back to Anthropic format
  → Claude Code
```

BlockRun's `/v1/messages` endpoint already handles this server-side, so the proxy just forwards. But for edge cases (streaming, tool calling), client-side transformation may be needed.

---

## Phase 2: Installation UX

### Goal
One-line install that sets up everything.

### Implementation

```bash
# Install brcc + Claude Code + patch in one command
curl -fsSL https://brcc.blockrun.ai/install.sh | bash
```

The install script:
1. Install Node.js if missing
2. Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
3. Install brcc: `npm install -g @blockrun/cc`
4. Create wallet: `brcc setup base`
5. Patch Claude Code: `brcc patch`
6. Show wallet address + funding instructions

### Uninstall

```bash
brcc patch --undo    # Restore Claude Code
npm uninstall -g @blockrun/cc
```

---

## Phase 3: Smart Defaults

### Goal
Zero-config experience — brcc auto-picks the best model for each task.

### Implementation

```bash
brcc start --smart   # Auto-route every request to optimal model
```

Uses ClawRouter's classifier to analyze each request:
- Token count, code presence, reasoning markers, creative markers
- Routes to cheapest capable model
- User sets budget: `brcc start --smart --budget 0.01` (max $0.01 per request)

---

## Phase 4: Team Features

### Goal
Teams share a wallet and track per-developer usage.

### Implementation

```bash
brcc team create "My Team"
brcc team add dev@example.com
brcc team budget 100          # $100 monthly budget
brcc team usage                # Per-developer breakdown
```

---

## Technical Reference

### Key repos
| Repo | What to borrow |
|------|----------------|
| [tweakcc](https://github.com/Piebald-AI/tweakcc) | JS patching engine, `allowCustomAgentModels`, `subagentModels`, prompt customization |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | Dynamic `/model` switching, transformer chain, smart routing by task type |
| [ClawRouter](https://github.com/BlockRunAI/ClawRouter) | 14-dimension request classifier, cost-optimized model selection |
| [OpenRouter](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration) | `ANTHROPIC_DEFAULT_*_MODEL` env vars, `ANTHROPIC_AUTH_TOKEN` pattern |

### Key Claude Code env vars
```bash
ANTHROPIC_BASE_URL              # API endpoint (brcc sets to localhost proxy)
ANTHROPIC_API_KEY               # API key (brcc sets dummy key)
ANTHROPIC_MODEL                 # Default model
ANTHROPIC_DEFAULT_OPUS_MODEL    # What /model opus resolves to
ANTHROPIC_DEFAULT_SONNET_MODEL  # What /model sonnet resolves to
ANTHROPIC_DEFAULT_HAIKU_MODEL   # What /model haiku resolves to
CLAUDE_CODE_SUBAGENT_MODEL      # Model for subagents
ANTHROPIC_CUSTOM_MODEL_OPTION   # Custom model in /model picker (no validation)
```

### Architecture target

```
brcc start
  │
  ├── Patch Claude Code (tweakcc engine)
  │     └── Unlock custom model names
  │
  ├── Start proxy (localhost:8402)
  │     ├── Request classifier (ClawRouter)
  │     ├── Model router (CCR pattern)
  │     ├── Transformer chain (Anthropic↔OpenAI)
  │     ├── x402 payment signing
  │     └── Response streaming
  │
  └── Launch Claude Code
        ├── ANTHROPIC_BASE_URL → proxy
        ├── Model env vars → BlockRun models
        └── /model picker → all 40+ models
```
