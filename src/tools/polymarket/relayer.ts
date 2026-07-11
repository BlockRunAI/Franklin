// src/utils/polymarket/relayer.ts
//
// Thin wrapper over @polymarket/builder-relayer-client for the deposit-wallet
// lifecycle: derive (CREATE2, pre-deploy), deploy (WALLET-CREATE), and signed
// WALLET batches (approvals, redeem). Everything here is GASLESS — the relayer
// sponsors gas. It is a courier, not a custodian: it only ever receives
// EIP-712 payloads signed by the local key, which it can neither alter (the
// signature covers every byte) nor replay (nonce + deadline).
//
// The relayer requires API credentials (polymarket.com → Settings → API Keys)
// purely to authenticate use of its gas-sponsoring service. Phase 2 moves
// these behind the BlockRun gateway so end users need no Polymarket account.
import { RelayClient, type DepositWalletCall } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getPolymarketAccount } from "./client.js";
import { CLOB_HOST, POLYGON_CHAIN_ID, POLYGON_RPC_URLS, RELAYER_URL } from "./constants.js";
import { loadBuilderCreds, loadL2Creds, saveBuilderCreds, saveL2Creds } from "./creds.js";
import { deriveApiCreds } from "./l1-auth-1271.js";

export type { DepositWalletCall };

let _relayClient: RelayClient | null = null;

// The deposit-wallet flow no longer needs manually-obtained relayer credentials:
// the MCP bootstraps a Builder API key from the wallet key itself (see
// getOrCreateBuilderCreds). These functions are retained as always-available.
export function relayerCredsMissing(): boolean {
  return false;
}

export function relayerCredsMissingMessage(): string {
  return "";
}

/**
 * Programmatically obtain Builder API credentials (key/secret/passphrase) for
 * the local wallet — created via the CLOB createBuilderApiKey() (L2-authed),
 * cached on disk (the secret is only returned once). This replaces the manual
 * "get a relayer API key from polymarket.com" step: the relayer authenticates
 * via the builder-HMAC path, and because the builder == the deposit-wallet
 * owner (this wallet), the relayer's from==owner check is satisfied.
 */
async function getOrCreateBuilderCreds(): Promise<{ key: string; secret: string; passphrase: string }> {
  const account = getPolymarketAccount();
  const cached = loadBuilderCreds(account.address);
  if (cached) return { key: cached.key, secret: cached.secret, passphrase: cached.passphrase };

  // Plain EOA CLOB L2 creds (sig type 0) — needed to authenticate the builder-key
  // creation. Cached like any L2 creds.
  let l2 = loadL2Creds(account.address, 0);
  if (!l2) {
    const derived = await deriveApiCreds(account, { sigType: 0 });
    saveL2Creds(account.address, 0, derived);
    l2 = loadL2Creds(account.address, 0);
    if (!l2) throw new Error("failed to derive CLOB credentials for builder-key creation");
  }

  const wc = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URLS[0]) });
  const clob = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID,
    signer: wc,
    creds: { key: l2.key, secret: l2.secret, passphrase: l2.passphrase },
    throwOnError: true,
  });
  const builder = (await clob.createBuilderApiKey()) as { key: string; secret: string; passphrase: string };
  if (!builder?.key || !builder?.secret || !builder?.passphrase) {
    throw new Error(`createBuilderApiKey did not return complete credentials (${JSON.stringify(Object.keys(builder ?? {}))})`);
  }
  saveBuilderCreds(account.address, builder);
  return builder;
}

/**
 * RelayClient bound to the REAL account address (the deposit-wallet owner), with
 * builder-HMAC auth from bootstrapped Builder API creds. Async because the first
 * call may create the builder key. The relayer is not geoblocked → direct.
 */
export async function getRelayClient(): Promise<RelayClient> {
  if (_relayClient) return _relayClient;
  const walletClient = createWalletClient({
    account: getPolymarketAccount(),
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
  const builderCreds = await getOrCreateBuilderCreds();
  const builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
  _relayClient = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, walletClient, builderConfig);
  return _relayClient;
}

/** CREATE2-derived deposit wallet address for the local key (pre-deploy safe). */
export async function deriveDepositWallet(): Promise<Hex> {
  const addr = await (await getRelayClient()).deriveDepositWalletAddress();
  return addr as Hex;
}

/**
 * Derive the deposit wallet address WITHOUT relayer API creds. Derivation is
 * pure CREATE2 math over the signer address plus a public-RPC factory read — no
 * authenticated relayer call — so it works before the user has creds, letting
 * them pre-fund the address. (Deploy/approve/trade still need creds.)
 */
export async function deriveDepositWalletNoCreds(): Promise<Hex> {
  const walletClient = createWalletClient({
    account: getPolymarketAccount(),
    chain: polygon,
    transport: http(POLYGON_RPC_URLS[0]),
  });
  const client = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, walletClient);
  const addr = await client.deriveDepositWalletAddress();
  return addr as Hex;
}

export async function isDepositWalletDeployed(address: string): Promise<boolean> {
  return (await getRelayClient()).getDeployed(address, "WALLET");
}

/**
 * Deploy the deposit wallet (idempotence guarded by the caller via
 * isDepositWalletDeployed). Waits for on-chain confirmation; throws with the
 * relayer transaction id on failure/timeout so the user can re-run setup.
 */
export async function deployDepositWallet(): Promise<{ transactionHash?: string }> {
  const response = await (await getRelayClient()).deployDepositWallet();
  const confirmed = await response.wait();
  if (!confirmed) {
    throw new Error(
      `Deposit wallet deployment did not confirm (relayer tx ${response.transactionID}). ` +
      `It may still be pending — re-run action:"setup" in a minute.`,
    );
  }
  return { transactionHash: confirmed.transactionHash };
}

/**
 * Execute a signed WALLET batch from the deposit wallet (approvals, redeem…).
 * The SDK fetches the nonce, EIP-712-signs the Batch with the local key, and
 * submits; we wait for confirmation.
 */
export async function sendWalletBatch(
  calls: DepositWalletCall[],
  depositWallet: string,
  description: string,
): Promise<{ transactionHash?: string }> {
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const response = await (await getRelayClient()).executeDepositWalletBatch(calls, depositWallet, deadline);
  const confirmed = await response.wait();
  if (!confirmed) {
    throw new Error(
      `${description}: relayer batch did not confirm (tx ${response.transactionID}). ` +
      `Re-run action:"setup" to check state and retry.`,
    );
  }
  return { transactionHash: confirmed.transactionHash };
}
