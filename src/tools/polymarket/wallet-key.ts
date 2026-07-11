// src/tools/polymarket/wallet-key.ts
//
// Franklin shim for the two wallet helpers the ported Polymarket module expects
// from blockrun-mcp's `../wallet.js`. Franklin keeps its EVM session key via
// @blockrun/llm (`~/.blockrun/.session` — the SAME key that pays x402 fees on
// Base), so a bet on Polygon and an API payment on Base are one identity. The
// key never leaves this machine.
//
// getOrCreateWalletKey() must stay SYNCHRONOUS because the ported client.ts calls
// it inside getPolymarketAccount() without awaiting. We satisfy that by caching
// the key: the PolymarketBet capability calls ensurePolymarketWallet() (async,
// creates the wallet if missing) before dispatching any action, after which the
// sync getter returns the cached key. loadWallet() (sync) is the fallback when
// the cache is cold but a wallet already exists on disk.
import { createPublicClient, http, erc20Abi, type Hex } from "viem";
import { base } from "viem/chains";
import { getOrCreateWallet, loadWallet } from "@blockrun/llm";
import { BASE_USDC } from "./constants.js";

let _cachedKey: Hex | null = null;

/**
 * Load-or-create the EVM session key and cache it so the synchronous
 * getOrCreateWalletKey() below can serve it. Call once at capability entry.
 */
export async function ensurePolymarketWallet(): Promise<void> {
  const wallet = await getOrCreateWallet();
  _cachedKey = wallet.privateKey as Hex;
}

/** The local EVM private key (0x…), cached. Mirrors blockrun-mcp's sync helper. */
export function getOrCreateWalletKey(): Hex {
  if (_cachedKey) return _cachedKey;
  // Cold cache but a wallet may already exist: loadWallet() returns the key
  // string synchronously (or throws/empty if none exists yet).
  try {
    const raw = loadWallet() as unknown;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length === 66) {
      _cachedKey = raw as Hex;
      return _cachedKey;
    }
  } catch {
    /* fall through to the explicit error */
  }
  throw new Error(
    "Polymarket wallet not initialized. This is an internal error — the " +
      "capability must call ensurePolymarketWallet() before signing.",
  );
}

const BASE_RPC =
  process.env.BASE_RPC_URL || process.env.RUNCODE_BASE_RPC || "https://mainnet.base.org";

/**
 * USDC balance in whole dollars for `address` on the given chain. Only "base" is
 * supported (the agent's x402 wallet); Solana returns null since Polymarket
 * funding always sources Base USDC. Read-only viem call, best-effort.
 */
export async function getChainBalance(
  chain: "base" | "solana",
  address: string,
): Promise<number | null> {
  if (chain !== "base") return null;
  try {
    const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
    const bal = (await client.readContract({
      address: BASE_USDC as Hex,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as Hex],
    })) as bigint;
    return Number(bal) / 1e6;
  } catch {
    return null;
  }
}
