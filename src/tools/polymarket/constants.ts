// src/utils/polymarket/constants.ts
//
// Polymarket CLOB V2 trading constants (Polygon mainnet, chainId 137).
//
// VERIFY addresses against https://docs.polymarket.com/resources/contracts
// before changing — and note the runtime cross-check below: if our copies ever
// disagree with the installed @polymarket/clob-client-v2's own contract config,
// assertContractConfig() throws at first use so an upstream address rotation is
// caught loudly instead of sending approvals to a dead contract.
import { getContractConfig } from "@polymarket/clob-client-v2";

export const POLYGON_CHAIN_ID = 137;

// --- Contracts (Polygon 137) ---
// Exchange contracts are per-order-version; production CLOB reports version 2
// (GET /version) as of 2026-07. The SDK routes orders to the right exchange by
// itself — these copies exist for the APPROVALS batch and redeem calldata.
export const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_CTF_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
// pUSD — Polymarket's 1:1 collateral wrapper (labelled CollateralToken proxy).
export const PUSD_COLLATERAL = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
// pUSD collateral adapters — the ONLY correct redeem targets in the pUSD era.
// CTF positions (the CLOB token_ids) are still keyed to USDC.e (standard) or
// the legacy NegRiskAdapter's wrapped collateral (neg-risk); calling the CTF /
// legacy adapter with pUSD burns a positionId nobody holds, which SUCCEEDS
// redeeming 0 (CTF redeemPositions never reverts on zero balance). These
// adapters pull the caller's outcome tokens (need a one-time CTF operator
// approval), redeem through the right underlying path, wrap the USDC.e payout
// into pUSD, and return it to the caller. Verified on-chain 2026-07-13:
// Sourcify exact_match; COLLATERAL_TOKEN/CONDITIONAL_TOKENS/USDCE (and
// NEG_RISK_ADAPTER/WRAPPED_COLLATERAL) all point at the addresses above.
export const CTF_COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f";
export const NEG_RISK_CTF_COLLATERAL_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab";
export const COLLATERAL_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
// USDC.e — the legacy collateral CTF position ids are keyed to. Withdrawals
// sweep any residue of it (historic direct-CTF redemptions paid out USDC.e)
// through the onramp's wrap(asset, to, amount) — signature verified against the
// Sourcify exact-match source of COLLATERAL_ONRAMP, 2026-07-21 — since the
// bridge only accepts pUSD.
export const USDCE_COLLATERAL = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";

/**
 * Cross-check our address copies against the SDK's canonical config. Called
 * once from the client factory; throwing here is deliberate — a silent
 * mismatch would mean approvals/redeem target different contracts than the
 * orders the SDK signs.
 */
export function assertContractConfig(): void {
  const cfg = getContractConfig(POLYGON_CHAIN_ID);
  const checks: Array<[string, string, string]> = [
    ["exchangeV2", cfg.exchangeV2, CTF_EXCHANGE_V2],
    ["negRiskExchangeV2", cfg.negRiskExchangeV2, NEG_RISK_CTF_EXCHANGE_V2],
    ["negRiskAdapter", cfg.negRiskAdapter, NEG_RISK_ADAPTER],
    ["collateral", cfg.collateral, PUSD_COLLATERAL],
    ["conditionalTokens", cfg.conditionalTokens, CONDITIONAL_TOKENS],
  ];
  for (const [name, sdkAddr, ours] of checks) {
    if (sdkAddr.toLowerCase() !== ours.toLowerCase()) {
      throw new Error(
        `Polymarket contract mismatch for '${name}': SDK says ${sdkAddr}, ` +
        `blockrun-mcp has ${ours}. Update src/utils/polymarket/constants.ts ` +
        `after verifying https://docs.polymarket.com/resources/contracts.`
      );
    }
  }
}

// --- Hosts (env-overridable so Phase 2 can point them at the BlockRun gateway) ---
// CLOB order placement is geoblocked by IP (US/UK/EU and many regions). We
// DEFAULT to BlockRun's hosted Finland egress (europe-north1) so trading works
// out of the box with zero config — Finland is FULLY unrestricted under
// Polymarket's geographic policy (frontend + API), a more durable choice than
// Japan (close-only on the frontend). The relay only forwards to Polymarket's
// CLOB (it can't see or move funds; every order is still signed locally by the
// user's key). Override with POLYMARKET_CLOB_HOST to hit Polymarket directly
// (from a permitted region) or run your own egress (see deploy/finland-egress).
// Direct Polymarket host: https://clob.polymarket.com
export const CLOB_HOST =
  process.env.POLYMARKET_CLOB_HOST || "https://pm-egress-1092497648280.europe-north1.run.app/clob";
export const RELAYER_URL =
  process.env.POLYMARKET_RELAYER_URL || "https://relayer-v2.polymarket.com";
export const DATA_API_HOST =
  process.env.POLYMARKET_DATA_API_HOST || "https://data-api.polymarket.com";
export const BRIDGE_API_HOST =
  process.env.POLYMARKET_BRIDGE_HOST || "https://bridge.polymarket.com";

// Default withdrawal destination: native USDC on Base (chainId 8453) — the same
// token/chain the BlockRun agent wallet already uses for x402 payments, so
// winnings cash out to the very wallet that pays for AI. (Same address as
// USDC_ADDRESS in ../constants.ts.)
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Overridable so a demo routing orders through the egress relay can report the
// SAME egress's region (a permitted ✅) instead of the local IP's status.
export const GEOBLOCK_URL =
  process.env.POLYMARKET_GEOBLOCK_URL || "https://polymarket.com/api/geoblock";
export const BRIDGE_UI_URL = "https://polymarket.com"; // deposits happen via the Polymarket bridge UI/API

// Public Polygon RPCs with fallback, mirroring BASE_RPC_URLS in ../constants.ts.
// Probed 2026-07-21 with a real eth_call (not just eth_blockNumber):
//   polygon-bor-rpc.publicnode.com  200 OK
//   polygon.drpc.org                200 OK
//   1rpc.io/matic                   200 OK once, then -32001 "usage limit" — rate-limited
//   polygon.llamarpc.com            DNS/fetch failure
//   polygon-rpc.com                 401 "tenant disabled"
//   rpc.ankr.com/polygon            -32000 "Unauthorized: you must authenticate"
// Two of the three entries here were dead, so fallback() depth was effectively 1
// while ~9 reads x 4 retries piled onto a single rate-limited endpoint. Dead
// entries are not free: each costs retryCount x timeout before the chain moves on.
//
// READS ONLY. Used by the viem public client, which fans out across all of them
// via fallback().
export const POLYGON_READ_RPC_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
];

/**
 * WRITES. Separate on purpose.
 *
 * There used to be one list, and entry 0 doubled as the sole un-fallbacked
 * transport for every SIGNING wallet client (withdraw, redeem, relayer, setup).
 * So reordering what looked like a read-only fallback list silently changed
 * which endpoint broadcasts every money transaction — a write-path change
 * disguised as a comment tweak, and one nobody would review as such.
 * (Splitting these was @KillerQueen-Z's idea in #66; the default below is not.)
 *
 * publicnode, not 1rpc: 1rpc answers once and then returns
 * -32001 "usage limit" (measured 2026-07-21), which is the last thing you want
 * broadcasting a withdrawal. Override per-deployment with POLYMARKET_WRITE_RPC_URL.
 *
 * Deliberately a single endpoint rather than a fallback list: viem's fallback()
 * would re-send a signed transaction to the next provider on a timeout, and a
 * transaction that was actually mined by the first provider must not be
 * broadcast again. Failing loudly on one endpoint is correct here; silently
 * retrying a money movement is not.
 */
export const POLYGON_WRITE_RPC_URL =
  process.env.POLYMARKET_WRITE_RPC_URL || "https://polygon-bor-rpc.publicnode.com";

// --- Safety knobs ---
/**
 * Parse a money-cap env var with FAIL-CLOSED semantics for safety controls:
 * - unset/blank → `unsetDefault` (the intended default when the knob is absent)
 * - a valid non-negative number → that number (0 is honored, e.g. "freeze")
 * - garbage (typo like "$100", negative) → 0 and a stderr warning, so a
 *   misconfigured cap blocks trading rather than silently reverting to a
 *   permissive default.
 */
function parseCapEnv(name: string, raw: string | undefined, unsetDefault: number | null): number | null {
  if (raw === undefined || raw.trim() === "") return unsetDefault;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  console.error(
    `[blockrun_polymarket] ${name}="${raw}" is not a valid number — treating it as 0 ` +
    `(orders blocked) so a misconfigured safety cap fails closed. Set a positive dollar amount.`,
  );
  return 0;
}

/** Hard per-order notional cap in pUSD dollars (default $25; 0/invalid blocks). */
export function getMaxBetUsd(): number {
  return parseCapEnv("POLYMARKET_MAX_BET_USD", process.env.POLYMARKET_MAX_BET_USD, 25) as number;
}

/** Optional cumulative per-process cap; null = uncapped (unset); 0 = freeze. */
export function getMaxSessionUsd(): number | null {
  return parseCapEnv("POLYMARKET_MAX_SESSION_USD", process.env.POLYMARKET_MAX_SESSION_USD, null);
}

/**
 * Bounded pUSD approvals in dollars; null = unlimited (maxUint256). The CTF
 * ERC-1155 approval is inherently all-or-nothing either way. Only a valid
 * positive value bounds; 0/garbage → unlimited (approvals are not a per-order
 * spend gate, so failing them "closed" would just block setup).
 */
export function getBoundedApprovalsUsd(): number | null {
  const raw = process.env.POLYMARKET_BOUNDED_APPROVALS;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Signature type override: 3 (POLY_1271 deposit wallet, default) or 0 (plain
 * EOA "demo insurance" mode — EOA holds pUSD itself, pays its own POL gas).
 */
export function getSigType(): 0 | 3 {
  return process.env.POLYMARKET_SIG_TYPE === "0" ? 0 : 3;
}

/**
 * Optional builder attribution code (bytes32 or plain string per Polymarket
 * builder settings). Absent → orders carry no builder fee attribution.
 */
export function getBuilderCode(): string | undefined {
  const v = process.env.BLOCKRUN_BUILDER_CODE?.trim();
  return v ? v : undefined;
}

/** Egress proxy for CLOB order traffic (see README: geoblock). */
export function getClobProxy(): string | undefined {
  const v = process.env.POLYMARKET_CLOB_PROXY?.trim();
  return v ? v : undefined;
}

// ERC-20/1155 minimal ABIs for approval + balance reads and approval calldata.
export const ERC20_ABI = [
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ERC1155_ABI = [
  {
    name: "isApprovedForAll", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "setApprovalForAll", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }],
    outputs: [],
  },
  {
    name: "redeemPositions", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

export const PUSD_DECIMALS = 6;
