# Live E2E Checklist

Use this checklist when you want to verify the real gateway path in a network-enabled environment.

## Scope

This covers four layers:

- Free smoke: startup, simple response, a basic tool call, and session cost reporting.
- Free model matrix: exact-response and basic tool-use probes across every current free NVIDIA model.
- Core happy-path: write/read/glob/grep/multi-tool and multi-turn session accounting.
- Weak-model polish: output cleanup on a live low-cost model.
- Paid tools: ExaSearch, ExaAnswer, ExaReadUrls, and VideoGen.

## Preconditions

Before running live e2e, make sure all of these are true:

- Node.js is 20 or newer.
- Dependencies are installed with `npm install`.
- The project builds locally with `npm run build`.
- Deterministic local tests pass with `npm test`.
- The machine has outbound network access to the BlockRun gateway.
- For paid-tool coverage, the wallet is funded and usable.

Useful checks:

```bash
npm run build
npm test
node dist/index.js --help
node dist/index.js balance
```

## Environment Knobs

- `E2E_MODEL=<provider/model>` overrides the default live model. If unset, e2e defaults to `zai/glm-5.1`.
- `FREE_MODEL_MATRIX=<provider/model>,<shortcut>` limits `npm run test:free-models` to a subset. If unset, it runs every picker-listed free model.
- `FREE_MODEL_MATRIX_PROBES=echo,bash` controls the live free-model probes. Use `echo` for a lighter rate-limit-friendly pass.
- `FREE_MODEL_MATRIX_TIMEOUT_MS=180000` controls the per-model live matrix timeout.
- `RUN_PAID_E2E=1` enables the paid-tool tests. Without it, paid tests are skipped on purpose.
- `FRANKLIN_MODEL_REQUEST_TIMEOUT_MS` controls how long Franklin waits for the initial model response headers.
- `FRANKLIN_MODEL_STREAM_IDLE_TIMEOUT_MS` controls how long Franklin waits for the next streamed chunk after the response has started.

For normal validation, leave the timeout env vars alone. They are mainly for debugging slow or flaky networks.

## Recommended Order

Run the live suite in this order so failures are easy to localize.

### 1. Free smoke

This is the fastest signal that the CLI starts, the gateway is reachable, the default live model answers, and the basic session summary still works.

```bash
node --test --test-reporter=spec \
  --test-name-pattern='startup|simple response|bash tool: executes shell command and returns output|session cost: token usage reported at session end' \
  test/e2e.mjs
```

Expected result in a healthy network-enabled environment:

- `startup` passes immediately.
- `simple response` passes.
- `bash tool` passes.
- `session cost` passes.

If these skip with `Live gateway/network unavailable in this environment`, treat that as an environment problem, not a product pass.

### 2. Free model matrix

This checks that all current free models in the picker behave consistently on
the two smallest live behaviors Franklin relies on: plain text output and one
basic local tool call. It spends no USDC, but it can consume free-tier request
quota.

```bash
npm run test:free-models
```

For a lighter smoke when rate limits are tight:

```bash
FREE_MODEL_MATRIX_PROBES=echo npm run test:free-models
```

To isolate one or two models:

```bash
FREE_MODEL_MATRIX=nvidia/qwen3-coder-480b,maverick npm run test:free-models
```

Expected result:

- The catalog sanity test passes locally.
- Each selected free model echoes its marker.
- When the `bash` probe is enabled, each selected free model uses the Bash tool and returns the marker.
- No response leaks raw `<think>` tags or role-played `[TOOLCALL]` text.

### 3. Core happy-path

Once smoke passes, verify the main tool and session paths.

```bash
node --test --test-reporter=spec \
  --test-name-pattern='write tool: creates a file with specified content|read tool: reads a pre-existing file|glob tool: finds files by pattern|grep tool: finds content in files|bash tool: error exit code is captured|multi-tool: write then read a file in same session|session cost: accumulates across multiple turns|session cost: /cost command shows cost info|polish: weak model respects instruction without leaking <think> or \\[TOOLCALL\\]' \
  test/e2e.mjs
```

Expected result:

- File tools pass on a real temp directory.
- `bash tool: error exit code is captured` still exits the CLI cleanly.
- `/cost` and multi-turn accounting both pass.
- The weak-model polish probe returns `POLISH_PROBE_OK` without leaking `<think>` or `[TOOLCALL]`.

### 4. Paid tools

Run this only after free/core are clean and the wallet has funds.

```bash
RUN_PAID_E2E=1 node --test --test-reporter=spec \
  --test-name-pattern='ExaSearch tool|ExaAnswer tool|ExaReadUrls tool|VideoGen tool' \
  test/e2e.mjs
```

Expected result:

- ExaSearch shows a visible `ExaSearch` call and at least one URL.
- ExaAnswer shows a visible `ExaAnswer` call and a grounded answer mentioning `x402`, `payment`, or `HTTP 402`.
- ExaReadUrls shows a visible `ExaReadUrls` call and mentions `HTTP 402` or payment.
- VideoGen creates a non-trivial MP4 at the requested output path.

### 5. Full live suite

After the focused runs are green, run the full live suite as the final check.

```bash
RUN_PAID_E2E=1 npm run test:e2e
```

If you only want the unfunded/free live suite, omit `RUN_PAID_E2E=1`.

## How To Read Failures

Use the first recognizable failure signature to decide where to look next.

- `Live gateway/network unavailable in this environment`
  - The machine could not reach the live gateway, or the request timed out before headers/stream data arrived.
  - Check outbound network access first.

- `Model unavailable due to payment/balance constraints`
  - The selected model or tool path needs funds, or payment verification failed.
  - Check wallet balance and try again with a funded wallet or a cheaper/free `E2E_MODEL`.

- `Free tier rate limited (60 req/hr)`
  - The free model path is exhausted for now.
  - Retry later or switch `E2E_MODEL` to another model you intend to validate.

- A harness-level timeout with no skip
  - This is more suspicious.
  - It can mean a regression in request timeout handling, stream idle handling, or a CLI code path that no longer exits cleanly.

- Free smoke passes but write/read/glob/grep fails
  - The gateway is likely fine.
  - Focus on local tool execution, file-path handling, or prompt/tool orchestration.

- The free model matrix passes `echo` but fails `bash`
  - The selected model can answer but is not reliably following Franklin's tool protocol.
  - Focus on weak-model prompting, tool inventory guardrails, or model-specific routing.

- Tool tests pass but session cost tests fail
  - Focus on stderr summaries, token accounting, or `/cost` command rendering.

- Paid Exa tests fail but free/core passes
  - Focus on x402 payment flow, wallet funding, or the paid-tool integration layer rather than the base CLI loop.

## Pass Criteria

Treat the run as truly green only when:

- Free smoke passes without skipping.
- Free model matrix passes for the current picker-listed free models, or any skips are explicitly attributable to rate limit/network.
- Core happy-path passes without skipping.
- Paid-tool tests pass when `RUN_PAID_E2E=1` is enabled on a funded wallet.
- No test spends a long time hanging before failing or skipping.

Fast skip is acceptable in a network-restricted environment. It is not evidence that the live happy-path works.
