# Franklin native Polymarket betting — design

**Date:** 2026-07-10
**Status:** Implemented (branch `feat/native-polymarket-betting`)

## Problem

blockrun-mcp ships **end-to-end** Polymarket betting — discover → fund → bet →
manage → settle → cash out. Franklin only had the *research* half: the read-only
`PredictionMarket` tool (Predexon `/v1/pm/*`) can answer "what are the odds / should
I bet on X" but cannot place a bet. That gap sits exactly on Franklin's positioning:
"the AI agent with a wallet that actually spends USDC." Betting is the purest
expression of the Trading vertical, and Franklin couldn't do it.

## Decision

Give Franklin the **execution half** as a native capability, so the reference
client itself holds the wallet and places the bet (not an external process).

Decisions taken with the owner:
- **Approach: native port** (not MCP-wrap, not shared package). Franklin becomes
  the true reference client that bets.
- **Scope: full parity** — all 9 actions: `setup, fund, buy, sell, orders, cancel,
  positions, redeem, withdraw`.
- **Safety: interactive confirm + caps** — a human approves every real placement
  in-session, on top of the ported per-order/session USD caps.

## Key architectural fact

blockrun-mcp's betting is **client-side**: orders are EIP-712 signed locally with
`@polymarket/clob-client-v2` + `viem`, using the same `~/.blockrun/.session` key
that pays x402 fees on Base. Only `fund` calls a BlockRun gateway endpoint
(`POST /v1/polymarket/fund`, $0.01 x402 fee). There is no server bet API to call —
the logic must live in the client. So "aligning Franklin" = porting that module.

## Implementation

### Module (ported verbatim from blockrun-mcp)
`src/tools/polymarket/` — 11 files, byte-identical to
`blockrun-mcp/src/utils/polymarket/*` except two import lines:
`client.ts`, `constants.ts`, `creds.ts`, `fund.ts`, `l1-auth-1271.ts`, `orders.ts`,
`positions.ts`, `redeem.ts`, `relayer.ts`, `setup.ts`, `withdraw.ts`.

`l1-auth-1271.ts` (the ERC-7739 workaround for clob-client-v2 issue #65) is
byte-for-byte identical and pinned against `@polymarket/clob-client-v2@1.0.8` — its
golden-vector test is the regression guard.

### Franklin glue (the only new logic)
- `src/tools/polymarket/wallet-key.ts` — shims blockrun-mcp's `../wallet.js`:
  - `getOrCreateWalletKey()` (sync) — served from a cache populated by
    `ensurePolymarketWallet()` (async, `@blockrun/llm` `getOrCreateWallet`), with a
    sync `loadWallet()` fallback. Sync signature preserved because the ported
    signer calls it un-awaited.
  - `getChainBalance('base', addr)` — Base USDC `balanceOf` via viem.
- `src/tools/polymarket-bet.ts` — the `PolymarketBet` `CapabilityHandler`. Rewrites
  blockrun-mcp's MCP tool wrapper as a Franklin capability: same action enum + input
  vocabulary, `concurrent: false` (betting mutates state).

### Safety model
1. **Dry-run unless `confirm:true`** — every placement previews first (ported).
2. **Interactive human gate** — when the agent passes `confirm:true`, the wrapper
   runs the *real* dry-run, shows it through `ctx.onAskUser(['Confirm','Cancel'])`,
   and only signs on explicit user approval. Bypass with `auto_approve:true` or
   `FRANKLIN_POLYMARKET_AUTO_APPROVE=1` (headless). Mirrors `jupiter.ts`/`zerox-base.ts`.
3. **Hard caps** — `POLYMARKET_MAX_BET_USD` ($25 default) per-order +
   `POLYMARKET_MAX_SESSION_USD` session cap, enforced inside `orders.ts`.
4. **Separate ledger** — bet stakes are the user's own pUSD on Polygon and do **not**
   draw from the x402 `--max-spend` AI budget. Only the $0.01 `fund` fee is metered
   via `recordUsage('PolymarketBet:fund', …)`.

### Registration
- `src/tools/index.ts` — imported + added to `allCapabilities` next to
  `predictionMarketCapability`.
- `src/tools/tool-categories.ts` — added `PolymarketBet` to `CORE_TOOL_NAMES` so the
  agent reaches for it the moment "place the bet" follows the research.

### Dependencies added
`@polymarket/clob-client-v2@1.0.8` (pinned), `@polymarket/builder-relayer-client@^0.0.10`,
`@polymarket/builder-signing-sdk@0.0.8` (pinned), `axios@^1.18.1`,
`https-proxy-agent@^9.1.0`. `viem` was already present. No manual relayer creds
required — a builder API key auto-bootstraps from the wallet key.

## Scope boundary

Betting is **Polymarket-only** — Kalshi/Limitless/Opinion/Predict.Fun remain
research-only via `PredictionMarket`, because only Polymarket has a client-side
execution path today. Discovery (token_id, condition_id, prices) stays with
`PredictionMarket` / `blockrun_markets`; `PolymarketBet` only executes.

## Verification
- `npm run build` — clean.
- `npm test` — 513/513 (510 existing + 3 new golden-vector tests).
- Byte-diff: every ported file identical to source except the 2 intended import edits.
- Functional smoke: capability registered + in core set; `execute()` dispatches
  through the wallet shim to the ported handlers (validation guards fire correctly).
- Live betting path (setup/fund/buy against real CLOB) requires a funded wallet and
  is gated behind explicit user confirmation — not exercised in CI.
