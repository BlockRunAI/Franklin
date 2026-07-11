// src/utils/polymarket/client.ts
//
// ClobClient factory for Polymarket CLOB V2 trading. The signer is the same
// local EVM key that pays BlockRun x402 fees on Base (~/.blockrun/.session) —
// a private key is chain-agnostic, so one identity pays API fees on Base and
// authorizes bets on Polygon. The key never leaves this machine.
//
// POLY_1271 note (issue #65): the CLOB authenticates L1/L2 by the OWNER EOA, not
// the deposit wallet — the reference Rust client (rs-clob-client-v2 src/auth.rs)
// derives API creds from the owner's plain ECDSA ClobAuth signature and binds the
// key to the EOA. Orders then carry signer/maker = deposit wallet (POLY_1271) and
// are validated on-chain by the wallet's ERC-1271 isValidSignature. So the signer
// handed to ClobClient is the real EOA (L2 POLY_ADDRESS = EOA = API key address),
// and funderAddress carries the deposit wallet for order building. (An earlier
// attempt to bind creds to the deposit wallet via an ERC-7739-wrapped L1 ClobAuth
// — the fix issue #65 proposed — is rejected by the CLOB with "Invalid L1 Request
// headers"; see the note in getClobClient.)
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createWalletClient, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { getOrCreateWalletKey } from "./wallet-key.js";
import {
  assertContractConfig,
  CLOB_HOST,
  GEOBLOCK_URL,
  getBuilderCode,
  getClobProxy,
  getSigType,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URLS,
} from "./constants.js";
import { loadDepositWalletForSigner, loadL2Creds, saveL2Creds } from "./creds.js";
import { deriveApiCreds } from "./l1-auth-1271.js";

let _account: PrivateKeyAccount | null = null;
let _clobClient: ClobClient | null = null;
let _clobClientKey = "";
let _proxyApplied = false;
let _proxyAgent: HttpsProxyAgent<string> | null | undefined;
let _bridgeApplied = false;

// Polymarket's auth headers all contain UNDERSCORES, which HTTP proxies
// (Caddy/Cloud Run and others) frequently drop or refuse to forward. When the
// MCP routes through a relay (POLYMARKET_CLOB_HOST / POLYMARKET_RELAYER_URL),
// that silently strips POLY_ADDRESS et al. and every authed call fails with
// "missing address header" / "Invalid L1 Request headers". Fix: also send each
// as a hyphenated copy (POLY_ADDRESS → poly-address) which survives proxies; the
// relay maps them back to underscores (see deploy/tokyo-egress/Caddyfile).
// Sending both is harmless direct — Polymarket reads the underscore header and
// ignores the extra hyphenated one.
const UNDERSCORE_AUTH_HEADERS = [
  "POLY_ADDRESS", "POLY_SIGNATURE", "POLY_TIMESTAMP", "POLY_NONCE",
  "POLY_API_KEY", "POLY_PASSPHRASE",
  "POLY_BUILDER_API_KEY", "POLY_BUILDER_PASSPHRASE",
  "POLY_BUILDER_SIGNATURE", "POLY_BUILDER_TIMESTAMP",
];

/**
 * Install a request interceptor on an axios instance that duplicates each
 * underscore auth header as its hyphenated form so it survives header-stripping
 * proxies. Idempotent per instance (guarded by the caller).
 */
export function installUnderscoreHeaderBridge(instance: {
  interceptors: { request: { use: (fn: (config: unknown) => unknown) => void } };
}): void {
  instance.interceptors.request.use((config: unknown) => {
    const headers = (config as { headers?: unknown }).headers as
      | { get?: (n: string) => unknown; set?: (n: string, v: unknown) => void; [k: string]: unknown }
      | undefined;
    if (!headers) return config;
    for (const name of UNDERSCORE_AUTH_HEADERS) {
      const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
      if (value == null) continue;
      const hyphen = name.replace(/_/g, "-").toLowerCase();
      if (typeof headers.set === "function") headers.set(hyphen, value);
      else headers[hyphen] = value as never;
    }
    return config;
  });
}

// Install the underscore-header bridge on the shared axios at module load, so
// EVERY Polymarket axios call has it regardless of call order — including
// credential derivation and builder-key creation, which can run before the CLOB
// client (and thus before applyClobProxyOnce) is first built.
installUnderscoreHeaderBridge(axios as never);
_bridgeApplied = true;

/** The local EOA account (BlockRun session key) used as the Polymarket signer. */
export function getPolymarketAccount(): PrivateKeyAccount {
  if (!_account) {
    _account = privateKeyToAccount(getOrCreateWalletKey());
  }
  return _account;
}

/**
 * The shared HttpsProxyAgent for POLYMARKET_CLOB_PROXY, or null when unset.
 * Built once. Reused for both the CLOB axios (v1, here) and the relayer's own
 * axios (0.27) instance (relayer.ts injects it), so a US-egress demo can route
 * ALL geoblockable Polymarket traffic — order placement AND the relayer
 * deploy/approve/redeem calls — through one permitted egress.
 */
export function getClobProxyAgent(): HttpsProxyAgent<string> | null {
  if (_proxyAgent === undefined) {
    const proxy = getClobProxy();
    _proxyAgent = proxy ? new HttpsProxyAgent(proxy) : null;
  }
  return _proxyAgent;
}

/**
 * Route CLOB traffic through POLYMARKET_CLOB_PROXY when set. Applied to the
 * axios v1 defaults, which clob-client-v2 (and our l1-auth / geoblock / Data-API
 * calls) share via the hoisted axios install; @blockrun/llm and the other tools
 * use fetch (which ignores this), so it scopes to Polymarket traffic. Plain
 * HTTPS_PROXY is honored by BOTH axios copies natively (proxy-from-env) without
 * any of this — the simplest option for a US-egress demo.
 */
export function applyClobProxyOnce(): void {
  // The header bridge is harmless everywhere and needed whenever a relay is in
  // play, so install it unconditionally (once) on the shared axios the CLOB
  // client + l1-auth use.
  if (!_bridgeApplied) {
    _bridgeApplied = true;
    installUnderscoreHeaderBridge(axios as never);
  }
  if (_proxyApplied) return;
  _proxyApplied = true;
  const agent = getClobProxyAgent();
  if (!agent) return;
  axios.defaults.httpsAgent = agent;
  axios.defaults.proxy = false;
}

/**
 * Wallet client that reports `reportAddress` but signs with the real key.
 * See the POLY_1271 note in the file header for why this is sound.
 */
function buildWalletClient(reportAddress?: Hex): WalletClient {
  const real = getPolymarketAccount();
  const account = reportAddress ? { ...real, address: reportAddress } : real;
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
}

/**
 * Cached, authenticated ClobClient for the active signature mode. Requires
 * setup to have persisted the deposit wallet address first in POLY_1271 mode.
 */
export async function getClobClient(): Promise<ClobClient> {
  assertContractConfig();
  applyClobProxyOnce();

  const sigType = getSigType();
  const account = getPolymarketAccount();
  const depositWallet = loadDepositWalletForSigner(account.address) as Hex | undefined;

  if (sigType === 3 && !depositWallet) {
    throw new Error(
      `No Polymarket deposit wallet configured for this signer yet. Run blockrun_polymarket ` +
      `action:"setup" first (or set POLYMARKET_SIG_TYPE=0 for plain EOA mode).`,
    );
  }

  // L2 API credentials are ALWAYS bound to the owner EOA (POLY_ADDRESS = EOA),
  // even in POLY_1271 mode. This mirrors the reference Rust client (rs-clob-
  // client-v2 src/auth.rs): L1/L2 auth uses the owner's plain ECDSA signature,
  // while POLY_1271 orders carry signer/maker = deposit wallet and are validated
  // on-chain by the wallet's ERC-1271 isValidSignature. The earlier attempt to
  // bind creds to the deposit wallet via an ERC-7739-wrapped L1 ClobAuth is what
  // the CLOB rejects with "Invalid L1 Request headers" — issue #65 misdiagnosed
  // the fix as wrapping L1 auth; the real path keeps L1 auth as the EOA.
  const cacheKey = `${sigType}:${account.address.toLowerCase()}`;
  if (_clobClient && _clobClientKey === cacheKey) return _clobClient;

  let creds = loadL2Creds(account.address, 0);
  if (!creds) {
    const derived = await deriveApiCreds(account, { sigType: 0 });
    saveL2Creds(account.address, 0, derived);
    creds = loadL2Creds(account.address, 0);
    if (!creds) throw new Error("failed to persist derived Polymarket API credentials");
  }

  const builderCode = getBuilderCode();
  _clobClient = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    // Real EOA signer: the L2 header POLY_ADDRESS must equal the API key's
    // address (the EOA). funderAddress carries the deposit wallet for orders.
    signer: buildWalletClient(),
    creds: { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    signatureType: sigType === 3 ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA,
    ...(sigType === 3 ? { funderAddress: depositWallet } : {}),
    ...(builderCode ? { builderConfig: { builderCode } } : {}),
    throwOnError: true,
  });
  _clobClientKey = cacheKey;
  return _clobClient;
}

/** Drop the cached client (after creds invalidation or a sig-type switch). */
export function resetClobClient(): void {
  _clobClient = null;
  _clobClientKey = "";
}

export interface GeoblockStatus {
  orderPlacement: "permitted" | "blocked" | "unknown";
  country: string | null;
  ip: string | null;
  raw: unknown;
}

let _geoCache: { at: number; value: GeoblockStatus } | null = null;

/**
 * Region check for ORDER PLACEMENT. The authoritative signal is the CLOB order
 * endpoint itself: an unauthenticated POST returns 403 ("Trading restricted in
 * your region") when geoblocked, or 401/400 (auth/validation) when NOT — and it
 * routes through POLYMARKET_CLOB_HOST, i.e. the exact egress real orders use.
 *
 * We deliberately do NOT trust polymarket.com/api/geoblock's boolean: it
 * reflects FRONTEND blocking (it returns blocked=true for Japan even though the
 * Japanese API accepts orders — verified: POST /order from a Tokyo egress
 * returns 401, not 403). The /api/geoblock call is kept only for country/ip
 * context. Cached 10 min; fail-open (unknown) on network error so a hiccup never
 * blocks a call that might succeed.
 */
export async function checkGeoblock(): Promise<GeoblockStatus> {
  applyClobProxyOnce();
  if (_geoCache && Date.now() - _geoCache.at < 10 * 60_000) return _geoCache.value;

  let orderPlacement: GeoblockStatus["orderPlacement"] = "unknown";
  try {
    const res = await axios.post(`${CLOB_HOST}/order`, {}, { timeout: 6_000, validateStatus: () => true });
    orderPlacement = res.status === 403 ? "blocked" : "permitted";
  } catch { /* network error → unknown */ }

  // Country/ip context — route it through the SAME egress as orders so the
  // reported country is the relay's, not the local IP. If POLYMARKET_GEOBLOCK_URL
  // is explicitly set, GEOBLOCK_URL already honors it; otherwise, when CLOB_HOST
  // is a relay (not the direct Polymarket host), derive the relay's geoblock path.
  let geoUrl = GEOBLOCK_URL;
  if (!process.env.POLYMARKET_GEOBLOCK_URL && !CLOB_HOST.includes("clob.polymarket.com")) {
    geoUrl = `${CLOB_HOST.replace(/\/clob\/?$/, "")}/geoblock/api/geoblock`;
  }
  let country: string | null = null;
  let ip: string | null = null;
  try {
    const g = await axios.get(geoUrl, { timeout: 3_000 });
    const d = g.data as Record<string, unknown>;
    country = typeof d?.country === "string" ? d.country : null;
    ip = typeof d?.ip === "string" ? d.ip : null;
  } catch { /* context is optional */ }

  const value: GeoblockStatus = { orderPlacement, country, ip, raw: { orderPlacement, country, ip } };
  if (orderPlacement !== "unknown") _geoCache = { at: Date.now(), value };
  return value;
}
