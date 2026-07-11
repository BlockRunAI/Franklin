// src/utils/polymarket/creds.ts
//
// On-disk state for the Polymarket tool, kept alongside the wallet session in
// ~/.blockrun/ with 0600 modes (same discipline as setChain() in ../wallet.ts):
//
//   .polymarket-creds  — CLOB L2 API credentials keyed by `${address}:${sigType}`.
//                        The key encodes the identity the creds are bound to
//                        (deposit wallet for sig type 3, EOA for type 0), so a
//                        sig-type switch never reuses mismatched creds — exactly
//                        the mismatch behind clob-client-v2 issue #65.
//   .polymarket.json   — tool state (deposit wallet address, deploy/approval
//                        progress) so setup is idempotent across restarts.
//
// L2 `secret`/`passphrase` are betting-account credentials, not BlockRun keys.
// They are only ever read back into the ClobClient (client.ts) — no code path
// prints them: setup/positions/orders report field presence or key prefixes,
// never the values, and the credential-derivation error path (l1-auth-1271.ts)
// reports only which fields a response contained, never the body.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BLOCKRUN_DIR = path.join(os.homedir(), ".blockrun");
const CREDS_FILE = path.join(BLOCKRUN_DIR, ".polymarket-creds");
const BUILDER_CREDS_FILE = path.join(BLOCKRUN_DIR, ".polymarket-builder-creds");
const STATE_FILE = path.join(BLOCKRUN_DIR, ".polymarket.json");

export interface L2Creds {
  key: string;
  secret: string;
  passphrase: string;
  derivedAt: string;
}

// Builder API creds (key/secret/passphrase) created programmatically via the
// CLOB createBuilderApiKey(). Used for the relayer's builder-HMAC auth so the
// deposit-wallet flow needs NO manually-obtained relayer credentials. The
// secret is only returned once at creation, so it must be cached here.
export interface BuilderCreds {
  key: string;
  secret: string;
  passphrase: string;
  createdAt: string;
}

export interface PolymarketState {
  depositWallet?: string;
  signer?: string;
  deployed?: boolean;
  approvalsDone?: boolean;
}

function readJsonFile<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8").trim();
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function credsKey(address: string, sigType: number): string {
  return `${address.toLowerCase()}:${sigType}`;
}

export function loadL2Creds(address: string, sigType: number): L2Creds | null {
  const all = readJsonFile<Record<string, L2Creds>>(CREDS_FILE);
  const entry = all?.[credsKey(address, sigType)];
  if (!entry?.key || !entry?.secret || !entry?.passphrase) return null;
  return entry;
}

export function saveL2Creds(address: string, sigType: number, creds: Omit<L2Creds, "derivedAt">): void {
  const all = readJsonFile<Record<string, L2Creds>>(CREDS_FILE) ?? {};
  all[credsKey(address, sigType)] = { ...creds, derivedAt: new Date().toISOString() };
  writeJsonFile(CREDS_FILE, all);
}

/** Drop cached creds (called on CLOB 401 / the issue-#65 error fingerprint). */
export function invalidateL2Creds(address: string, sigType: number): void {
  const all = readJsonFile<Record<string, L2Creds>>(CREDS_FILE);
  if (!all) return;
  delete all[credsKey(address, sigType)];
  writeJsonFile(CREDS_FILE, all);
}

export function loadBuilderCreds(owner: string): BuilderCreds | null {
  const all = readJsonFile<Record<string, BuilderCreds>>(BUILDER_CREDS_FILE);
  const entry = all?.[owner.toLowerCase()];
  if (!entry?.key || !entry?.secret || !entry?.passphrase) return null;
  return entry;
}

export function saveBuilderCreds(owner: string, creds: Omit<BuilderCreds, "createdAt">): void {
  const all = readJsonFile<Record<string, BuilderCreds>>(BUILDER_CREDS_FILE) ?? {};
  all[owner.toLowerCase()] = { ...creds, createdAt: new Date().toISOString() };
  writeJsonFile(BUILDER_CREDS_FILE, all);
}

export function loadState(): PolymarketState {
  return readJsonFile<PolymarketState>(STATE_FILE) ?? {};
}

/**
 * The persisted deposit wallet, but ONLY if it belongs to `signer`. After a
 * BlockRun key rotation (~/.blockrun/.session regenerated) the stored wallet is
 * a CREATE2 vault the new key cannot control, so returning it would point
 * trading/funding at unrecoverable funds. Returns undefined on signer mismatch.
 */
export function loadDepositWalletForSigner(signer: string): string | undefined {
  const state = loadState();
  if (state.depositWallet && state.signer && state.signer.toLowerCase() === signer.toLowerCase()) {
    return state.depositWallet;
  }
  return undefined;
}

export function saveState(patch: Partial<PolymarketState>): PolymarketState {
  const next = { ...loadState(), ...patch };
  writeJsonFile(STATE_FILE, next);
  return next;
}
