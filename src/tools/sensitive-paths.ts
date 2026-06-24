/**
 * Wallet secret-material guard for the model-facing file tools.
 *
 * Franklin IS the wallet: a steered model (prompt injection via a fetched page,
 * MCP result, file contents, etc.) that can Read/Write/Edit arbitrary paths
 * could exfiltrate, destroy, or — worst — SUBSTITUTE the private key so future
 * on-chain x402 spends sign from an attacker's key. Write's `dangerousPaths`
 * blocklist already covers ~/.ssh, ~/.aws, ~/.gnupg, ... but historically
 * missed the BlockRun key store this product is built around. These helpers
 * close that gap for Write, Edit, AND Read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

/** Private-key / wallet-secret files under ~/.blockrun. */
const WALLET_KEY_FILES = [
  path.join(BLOCKRUN_DIR, '.session'),            // EVM private key (0x hex)
  path.join(BLOCKRUN_DIR, '.solana-session'),     // Solana secret key (base58)
  path.join(BLOCKRUN_DIR, '.solana-session-key2'),
  path.join(BLOCKRUN_DIR, 'solana-wallet.json'),  // legacy { address, private_key }
];

// macOS (APFS) and Windows are case-INSENSITIVE by default, and fs.realpathSync
// does NOT canonicalize case — so `.SOLANA-SESSION` opens the real
// `.solana-session` while an exact compare would miss it. Compare accordingly.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function matchesKeyFile(p: string): boolean {
  const norm = p.endsWith(path.sep) ? p.slice(0, -1) : p;
  if (CASE_INSENSITIVE_FS) {
    const lower = norm.toLowerCase();
    return WALLET_KEY_FILES.some((f) => f.toLowerCase() === lower);
  }
  return WALLET_KEY_FILES.includes(norm);
}

/**
 * True if `resolvedAbsPath` is — or resolves through a symlink to — a wallet
 * private-key file. Callers must pass an already-absolute path.
 */
export function isWalletKeyPath(resolvedAbsPath: string): boolean {
  if (matchesKeyFile(resolvedAbsPath)) return true;
  try {
    if (fs.existsSync(resolvedAbsPath) && matchesKeyFile(fs.realpathSync(resolvedAbsPath))) {
      return true;
    }
  } catch { /* best-effort symlink check */ }
  return false;
}

/** Exported for tests / reuse. */
export const WALLET_KEY_PATHS = WALLET_KEY_FILES;
