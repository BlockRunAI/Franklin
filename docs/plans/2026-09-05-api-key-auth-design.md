# API-key auth alongside the wallet — design

**Date:** 2026-09-05
**Status:** implemented on `feat/api-key-auth` (2026-09-05)
**Scope:** `@blockrun/franklin` (this repo) + README. Gateway-side asks are listed but out of repo scope.

---

## 1. Why

Today Franklin can only pay one way: sign an x402 payment with a local USDC wallet on
Base or Solana. That is the product's identity ("the AI agent with a wallet") and it
stays. But it also gates the whole funnel behind "create a wallet, bridge USDC, fund
it" — which loses every user who just wants to paste a key and start.

BlockRun already runs a second, prepaid-credit gateway that speaks plain
`Authorization: Bearer brk_live_…`. This design wires Franklin to it as a **second
payment mode**, not a replacement, and rewrites the README so people know where to
sign up and top up.

---

## 2. Established facts (probed 2026-09-05, not assumed)

### 2.1 Two independent gateways

| | Wallet mode | API-key mode |
| --- | --- | --- |
| Host | `blockrun.ai/api` (Base) / `sol.blockrun.ai/api` (Solana) | `api.blockrun.ai` |
| Path shape | `{host}/v1/…` where host ends in `/api` | `{host}/v1/…`, **no `/api` segment** |
| Auth | x402 `PAYMENT-SIGNATURE` header, per request | `Authorization: Bearer brk_live_…` |
| Settlement | on-chain USDC, per call | prepaid credit balance |
| Chain | Base or Solana | **none** — chain is not a concept here |

They do not cross-authenticate:

- A `Bearer brk_live_…` sent to `blockrun.ai/api/v1/chat/completions` is **ignored** —
  still `402 Payment Required` with x402 requirements.
- `api.blockrun.ai` with a bad key **or with no key at all** returns
  `401 {"code":"invalid_api_key"}`. There is no x402 fallback on that host.
- `api.blockrun.ai/api/v1/…` returns `404 {"code":"wrong_host"}` — the `/api` prefix
  must be dropped, not kept.
- The dashboard is a third host, `user.blockrun.ai`.

This mutual isolation is what makes the feature safe: **an existing wallet user who
never sets a key sees byte-identical behaviour.**

### 2.2 Endpoint coverage on the key gateway — effectively complete

All 33 gateway paths Franklin actually calls were probed with the live key. Every one
routes (returning parameter-validation errors, not routing errors):

`/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/v1/images/generations`,
`/v1/images/image2image`, `/v1/videos/generations`, `/v1/audio/generations`,
`/v1/voice/call`, `/v1/exa/{search,answer,contents}`, `/v1/search`, `/v1/surf/**`,
`/v1/crypto|fx|commodity|usstock/price/*`, `/v1/rpc/*`, `/v1/zerox/**`,
`/v1/defillama/*`, `/v1/modal/sandbox/*`, `/v1/phone/*`, `/v1/pm/**`,
`/v1/polymarket/fund`, `/v1/onramp/token`, `/v1/health/overview`.

Four paths return `unsupported_endpoint` — `/v1/stocks/price/*`, `/v1/image/generate`,
`/v1/x/search`, `/v1/wallet/balance`. **These are 404 on the x402 gateway too**
(verified on both `blockrun.ai` and `sol.blockrun.ai`), so they are dead references in
`src/`, not a coverage gap. They should be removed in a separate cleanup, and are
explicitly not this change's problem.

Live 200s confirmed end-to-end on the key: chat completion, Exa neural search,
Grok live search, Polymarket markets, Modal sandbox create, phone number list.

### 2.3 The blocking problem — the key gateway reports no charge

A successful API-key call returns exactly these accounting-relevant headers:

```
payment-response: {"success":true,"transaction":"","network":"credit","payer":"pilot"}
x-settlement-async: true
x-blockrun-request-id: <uuid>
```

There is **no amount anywhere** — not in `payment-response`, not in a dedicated header,
not in the body (except where the upstream provider happens to include one, e.g. Exa's
`costDollars`). And `x-settlement-async: true` means the ledger entry lands after the
response.

Franklin's entire spend ledger is derived from the 402 handshake. Representative
patterns in `src/`:

```ts
// src/tools/exa.ts:108
if (!settled) return; // free/already-paid (200-first) path — no charge to record

// src/tools/surf.ts:246 — paidUsd is only ever assigned inside the 402 branch
if (!response.ok) paidUsd = 0;
recordUsage(`${toolName}:${entry.path}`, 0, 0, paidUsd, Date.now() - start);
```

`src/tools/rpc.ts`, `src/tools/defillama.ts` and `src/tools/blockrun.ts` follow the same
shape. Since API-key mode never produces a 402, **`paidUsd` stays `0` and every paid
call records `$0`**. Downstream, that silently breaks:

- `franklin stats` / the panel Audit tab — all spend reads zero
- the `--max-spend` session ceiling — never trips, so an autonomous run has no cap
- `PreSpend` / `PostSpend` hooks — `estimatedUsd` is null or zero, so user guardrails
  do not fire
- budget-bound content generation in `src/content/`
- trade-plan cost lines
- reconciliation against `user.blockrun.ai` — Franklin says $0, the dashboard says the
  real number

This is the single largest risk in the change and is addressed in §4.

### 2.4 No credit-balance endpoint is exposed to the key

`/v1/credits`, `/v1/key`, `/v1/usage`, `/v1/account`, `/v1/me` all return
`unsupported_endpoint`; `/v1/balance` exists but takes an on-chain `address` (it is the
wallet-balance endpoint, not a credit endpoint). So `franklin balance` cannot show a
credit balance today — see §7 for the gateway-side ask and §5.5 for the interim
behaviour.

### 2.5 Solana is already the code default

`loadChain()` in `src/config.ts` already returns `'solana'` unless the user has a Base
wallet and no Solana wallet (a deliberate no-strand heuristic). The Base-first ordering
that remains is in **docs, the README, and setup copy**, e.g.
`franklin setup base        # or: franklin setup solana`.

### 2.6 `brk_live_` is not redacted

`src/agent/secret-redact.ts` covers GitHub, Anthropic, OpenAI, AWS, Google, Slack,
Stripe, Twilio and raw private keys — but has no `brk_` pattern. Once keys exist in the
product, an unredacted key can reach transcripts, logs and `franklin logs` output.
Must be fixed in the same change.

---

## 3. Decisions taken

1. **Precedence:** API key wins when present; wallet is the fallback. A key that is
   invalid, or an endpoint the key gateway does not serve, falls back to the x402
   wallet path rather than hard-failing.
2. **Key entry:** all four of — `BLOCKRUN_API_KEY` env var, `franklin login <key>`
   persisting to `~/.blockrun/api-key`, a step in the first-run setup wizard, and a
   field in the desktop panel.
3. **README framing:** two parallel on-ramps, wallet remains the primary narrative.
   The absolute claim "No API keys. No account." is removed.

---

## 4. Architecture

### 4.1 One resolver, not 43 edits

Every gateway caller in `src/` already funnels through the same two lines:

```ts
const chain = loadChain();
const apiUrl = API_URLS[chain];   // ends in /api
// … fetch(`${apiUrl}/v1/…`)
```

So the change is a new module, `src/payments/auth-mode.ts`, exposing:

```ts
export type PayMode =
  | { kind: 'key'; apiBase: 'https://api.blockrun.ai'; key: string }
  | { kind: 'wallet'; apiBase: string; chain: Chain };

export function resolvePayMode(): PayMode;      // cached per process
export function gatewayHeaders(m: PayMode): Record<string, string>;
export function invalidateKey(): void;          // on 401, demote to wallet for the process
```

`resolvePayMode()` order: `BLOCKRUN_API_KEY` → `~/.blockrun/api-key` → wallet mode via
`loadChain()`. Callers replace `API_URLS[chain]` with `resolvePayMode().apiBase` and
merge `gatewayHeaders(mode)` into their existing header object. Because the key host
serves `/v1/…` at the root and `API_URLS[chain]` ends in `/api`, the concatenation
`${apiBase}/v1/…` is correct in both modes with no per-call-site branching.

**One exception:** `src/gateway-models.ts:149` does
`API_URLS[chain].replace(/\/api$/, '')` to reach a non-`/v1` path. That regex is a
no-op on `https://api.blockrun.ai` and must be reviewed by hand.

### 4.2 Fallback on 401 / unsupported endpoint

`postWithPayment()` in `src/payments/post-with-payment.ts` and the streaming path in
`src/agent/llm.ts` gain one branch:

- key mode, response is `401 invalid_api_key` → warn once, `invalidateKey()`, retry the
  whole request against the wallet gateway. Never retry a second time.
- key mode, response is `404 unsupported_endpoint` → retry on the wallet gateway for
  that call only; do not demote the process.
- key mode, any other status → surface as-is. No fallback on 400/402/5xx, so a bad
  request does not silently spend wallet USDC.

### 4.3 Cost accounting in key mode

Franklin already owns local list prices — `MODEL_PRICING` / `estimateCost()` in
`src/pricing.ts`, `perImageUsd` in `imagegen.ts`, `fallbackUsd` in `exa.ts`. The fix
generalises that: **when no 402 occurred, price the call locally instead of recording
zero.** Priority per call:

1. a gateway-reported charge, if the response carries one (Exa `costDollars`, and any
   future charge header — see §7)
2. `estimateCost(model, promptTokens, completionTokens)` for token-metered endpoints,
   using the `usage` block the key gateway does return
3. the tool's own list-price constant for flat-rate endpoints

Every recorded row is tagged with its provenance so the audit trail never claims more
precision than it has — `exact` (settled x402 or gateway-reported) vs `estimated`
(locally priced). `franklin stats` and the panel Audit tab render estimated rows with a
`~` prefix, and `franklin stats` grows a one-line footer in key mode pointing at
`user.blockrun.ai/dashboard` as the source of truth.

This keeps `--max-spend`, `PreSpend` hooks and content budgets functional in key mode.
They operate on an estimate, and that is stated plainly rather than hidden.

---

## 5. Component changes

### 5.1 New

- `src/payments/auth-mode.ts` — resolver, header builder, key file I/O (`0600`).
- `src/commands/login.ts` — `franklin login <key>` / `franklin login --show` /
  `franklin logout`. Validates the key with one cheap live call before persisting;
  refuses to write a key that does not authenticate.

### 5.2 Modified

| File | Change |
| --- | --- |
| `src/config.ts` | export `KEY_API_URL`, `API_KEY_FILE`; keep `API_URLS` unchanged |
| `src/agent/llm.ts` | key headers on the streaming path; 401 fallback; estimated-cost recording |
| `src/payments/post-with-payment.ts` | same, for every non-streaming gateway caller |
| 16 files doing the x402 handshake | `API_URLS[chain]` → `resolvePayMode().apiBase`, merge auth headers, local pricing when unsettled |
| `src/gateway-models.ts` | hand-review the `/api`-stripping regex |
| `src/agent/secret-redact.ts` | add `/\bbrk_(live|test)_[A-Za-z0-9]{20,}\b/g` |
| `src/commands/setup.ts` | offer the key path first, wallet second; Solana before Base |
| `src/commands/balance.ts` | in key mode print key status + dashboard link (§5.5) |
| `src/commands/doctor.ts` | report active pay mode, key validity, resolved gateway host |
| `src/proxy/server.ts` | forward in key mode so the Anthropic-compatible proxy works |
| `src/proxy/server.ts` | `applyGatewayAuth` on the forwarded header bag |
| `apps/desktop` panel | wallet page states when spend comes from a key (see §9) |

### 5.3 Backward compatibility — the guarantee for wallet users

No key set anywhere ⇒ `resolvePayMode()` returns wallet mode ⇒ `apiBase` is exactly
`API_URLS[loadChain()]` and `gatewayHeaders()` returns `{}`. Every wallet code path is
untouched. This is asserted by test, not by inspection (§6).

Both can coexist on one machine: keeping a key set and running `franklin --wallet`
forces wallet mode for that invocation.

### 5.4 Solana before Base

Code default already is Solana. Remaining work is ordering and copy: setup wizard
prompt order, README examples, `docs/`, the desktop chain picker, and any
`base … or solana` phrasing. The Base-wallet no-strand heuristic in `loadChain()`
**stays** — flipping it would move existing users' spend to an empty Solana wallet.

### 5.5 `franklin balance` in key mode

Until a credit endpoint exists, print the key's masked identity, that it authenticates,
the session's estimated spend from the local ledger, and a link to
`user.blockrun.ai/dashboard` for the authoritative balance. Do not invent a number.

---

## 6. Verification plan

Local (`npm test`, no network):

- wallet mode with no key resolves to today's exact host and empty headers — per chain
- key mode resolves to `https://api.blockrun.ai` and drops `/api`
- env var beats key file; `--wallet` beats both
- `brk_live_…` is redacted by `redactSecrets()`
- unsettled paid calls record a non-zero estimated cost tagged `estimated`

Live, against the real key (`npm run test:e2e` gated on `BLOCKRUN_API_KEY`):

- one call per endpoint family: chat, exa, search, image, pm, rpc, surf
- 401 fallback: bad key + funded wallet completes via the wallet path
- unsupported endpoint falls back for that call only

Dashboard reconciliation — **this is how we answer "are the amounts right" and must be done by
hand**, because there is no usage API to automate it against:

1. Note the dashboard credit balance and the last activity row.
2. Run a scripted burst of exactly N calls of known types.
3. Compare Franklin's `franklin stats` total against the dashboard's delta.
4. Record the drift. Allow for `x-settlement-async: true` — re-check after a few
   minutes before calling a discrepancy real.
5. Confirm each call appears as an activity row with the right endpoint and model.

Expected outcome: **Franklin's tally reads high**, by a known and predictable amount.
user.blockrun.ai states that key mode bills provider list price with no markup and no
per-call fee (the only charge is 5.5% + $0.30 at top-up), whereas the x402 rate card
Franklin prices from carries a 5% margin plus a $0.001 per-transaction fee
(`GATEWAY_MARGIN` / `GATEWAY_TRANSACTION_FEE_USD` in `src/gateway-models.ts`). So the
estimate over-counts by roughly 5% plus $0.001 per call.

That direction is deliberate — over-counting is the safe side of a spend ceiling — and it
is disclosed rather than hidden. It is not worth "correcting" by guessing at a key-mode
formula we have only seen stated in marketing copy; §7's charge header removes the
guesswork entirely and should be the fix. Reconciliation should confirm the drift is
about that size and no larger. A drift in the other direction (Franklin under-counting)
would be a real bug and a blocker.

---

## 7. Gateway-side asks (not this repo)

1. **A charge header on API-key responses**, e.g.
   `x-blockrun-charged-usd: 0.002000`. This removes all estimation and makes
   Franklin's ledger exact in both modes. Franklin should read it opportunistically
   from day one so it starts working the moment it ships.
2. **A key-scoped credit endpoint**, e.g. `GET /v1/credits` →
   `{ balance_usd, spent_today_usd }`, so `franklin balance` and low-balance warnings
   work in key mode.
3. Clarify `"payer":"pilot"` — whether that reflects a pilot tier on this specific key
   or is constant, since it may affect pricing users are quoted.

---

## 8. README rewrite

- Delete "No subscriptions. No API keys. No account." → keep "No subscriptions", and
  state the two on-ramps.
- New **"Two ways to pay"** section right after the pitch:
  - **Wallet (crypto-native).** No signup. `franklin setup solana`, send USDC, done.
  - **API key (prepaid credit).** Sign up at `user.blockrun.ai`, top up, create a key,
    `franklin login brk_live_…`.
- Quick start gains a step 3b for the key path; every chain example puts Solana first.
- New **"Sign up and top up"** section: the `user.blockrun.ai` link, where the key
  lives in the dashboard, how to add credit, where to watch activity and spend.
- Free tier section: state that free models need neither a wallet nor a key.
- Keep the wallet as the headline narrative — "wallet is identity" stays, with the key
  presented as the on-ramp for people who are not there yet.

---

## 9. What shipped, and what did not

Built and verified against the live gateway:

- `resolvePayMode()` / `gatewayHeaders()` / `applyGatewayAuth()` and the host swap
  across all 43 gateway callers, including the Anthropic-compatible payment proxy.
- `franklin login` / `logout`, the `--wallet` override, key-aware `balance`, `doctor`
  and `setup`, and `brk_` redaction.
- The price catalog, so key-mode calls record a real amount instead of $0.
- 23 unit tests plus live runs of chat, Exa, Surf and the proxy in both modes.

**One bug was found and fixed during live testing.** The proxy forwards the client's
headers with Node's lowercased names, and `gatewayHeaders()` returns the canonical
`Authorization`. A plain object holds both, `fetch` sent two Authorization headers, the
gateway read the client's and answered 401. `applyGatewayAuth` now strips every case
variant first; covered by a regression test.

**Not done — deliberately deferred:**

- **An editable API-key field in the desktop panel.** The desktop talks to the CLI over
  a websocket RPC that is read-only for credentials by design — the CLI owns everything
  in `~/.blockrun/` and never exports a key. Adding a write path for secrets is a
  larger security decision than this change should make on its own. What did ship is
  the honest half: `wallet.info` now reports `payMode`, and the wallet page says spend
  is coming from a key rather than presenting the USDC balance as the budget. Keys are
  set from the terminal with `franklin login`.

## 10. Out of scope

- Removing the four dead `/v1/…` paths (separate cleanup).
- Any change to the x402 protocol handling itself.
- Team/multi-key management.
- Auto top-up from a wallet into credit.

## 11. Unrelated defect noticed while testing

`SurfMarket` fails on the Solana wallet path with
`{"error":"Payment verification failed","reason":"verification_failed"}` — the signature
is produced and sent, and the gateway rejects it. **This reproduces identically on
`main`**, so it predates this change and is not a regression from it. It needs its own
investigation.
