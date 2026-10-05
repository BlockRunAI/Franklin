/**
 * Secret-material guard for the model-facing file tools.
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
import os from 'node:os';
import path from 'node:path';
import { API_KEY_FILE, BLOCKRUN_DIR } from '../config.js';

/**
 * Secret-material files under ~/.blockrun.
 *
 * Appended to, never reordered: test/local.mjs indexes this list positionally.
 */
const WALLET_KEY_FILES = [
  path.join(BLOCKRUN_DIR, '.session'),            // EVM private key (0x hex)
  path.join(BLOCKRUN_DIR, '.solana-session'),     // Solana secret key (base58)
  path.join(BLOCKRUN_DIR, '.solana-session-key2'),
  path.join(BLOCKRUN_DIR, 'solana-wallet.json'),  // legacy { address, privateKey }
  // Account bearer key (brk_...). Not a private key, but it spends: it draws
  // on a prepaid balance with no per-call signature and no chain-level
  // ceiling, so `cat ~/.blockrun/api-key` is exfiltration in one Read. It
  // belongs behind the same guard as the wallet keys above.
  API_KEY_FILE,
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

/**
 * True if `absDir` is (or resolves to) a directory that contains a wallet key
 * file somewhere beneath it. Search tools use this to exclude the key files
 * from a directory walk, since a walk never passes the exact key path to
 * isWalletKeyPath.
 */
export function walletKeyFilesUnder(absDir: string): string[] {
  const roots = [absDir];
  try { roots.push(fs.realpathSync(absDir)); } catch { /* not on disk */ }
  const out = new Set<string>();
  for (const root of roots) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    for (const f of WALLET_KEY_FILES) {
      const hit = CASE_INSENSITIVE_FS
        ? f.toLowerCase().startsWith(prefix.toLowerCase())
        : f.startsWith(prefix);
      if (hit) out.add(path.relative(root, f));
    }
  }
  return [...out];
}

// ─── Host credential stores ────────────────────────────────────────────────
// Secrets that belong to the machine, not to Franklin: SSH keys, cloud
// credentials, other wallets' keypairs. Write already refused these; Read and
// the search tools did not, and Read is auto-approved, so a steered model
// could pull `~/.ssh/id_rsa` into context without a prompt. Bash still reaches
// them, but bash-guard classifies those reads as needing approval.

/** Directories whose whole contents are credential material. */
function hostCredentialDirs(home: string): string[] {
  return [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.kube'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.config', 'solana'),   // Solana CLI keypair (id.json)
    path.join(home, '.azure'),
  ];
}

/** Single credential files. */
function hostCredentialFiles(home: string): string[] {
  return [
    path.join(home, '.netrc'),
    path.join(home, '.npmrc'),
    path.join(home, '.pgpass'),
    path.join(home, '.git-credentials'),
    path.join(home, '.docker', 'config.json'),
    path.join(home, '.cargo', 'credentials'),
    path.join(home, '.cargo', 'credentials.toml'),
    path.join(home, '.config', 'rclone', 'rclone.conf'),
    path.join(home, '.config', 'gh', 'hosts.yml'),
  ];
}

function norm(p: string): string {
  const n = p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
  return CASE_INSENSITIVE_FS ? n.toLowerCase() : n;
}

function matchesHostCredential(p: string, home: string): boolean {
  const target = norm(p);
  for (const dir of hostCredentialDirs(home)) {
    const d = norm(dir);
    if (target === d || target.startsWith(d + path.sep)) return true;
  }
  return hostCredentialFiles(home).some((f) => norm(f) === target);
}

/**
 * True if `resolvedAbsPath` is — or resolves through a symlink to — a host
 * credential store (see hostCredentialDirs / hostCredentialFiles).
 */
export function isHostCredentialPath(resolvedAbsPath: string): boolean {
  const home = os.homedir();
  if (matchesHostCredential(resolvedAbsPath, home)) return true;
  try {
    if (fs.existsSync(resolvedAbsPath) &&
        matchesHostCredential(fs.realpathSync(resolvedAbsPath), home)) {
      return true;
    }
  } catch { /* best-effort symlink check */ }
  return false;
}

/** Home-relative credential directories, for tools that keep their own blocklist. */
export function hostCredentialDirPaths(): string[] {
  return hostCredentialDirs(os.homedir());
}

/** The single refusal used by every model-facing tool that reads files. */
export function secretPathRefusal(resolvedAbsPath: string): string | null {
  if (isWalletKeyPath(resolvedAbsPath)) {
    return `Error: refusing to read the wallet key store: ${resolvedAbsPath}`;
  }
  if (isHostCredentialPath(resolvedAbsPath)) {
    return `Error: refusing to read a credential store: ${resolvedAbsPath}. ` +
      `If the user needs this file, they can open it themselves.`;
  }
  return null;
}

// ─── Wallet secrets as redaction literals ──────────────────────────────────
// The path guards stop the tools we know about. This is the backstop for any
// path we do not: the exact key values, scrubbed from every tool result.
// Matching on the literal (not a 0x + 64-hex shape) keeps tx hashes intact.

let secretCache: { stamp: string; values: string[] } | null = null;

function extractSecrets(file: string, raw: string): string[] {
  const out: string[] = [];
  const text = raw.trim();
  if (!text) return out;
  if (file.endsWith('.json')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      for (const k of ['privateKey', 'private_key', 'secretKey', 'secret_key']) {
        const v = obj[k];
        if (typeof v === 'string') out.push(v.trim());
      }
    } catch { /* not JSON: fall through to raw */ }
    if (out.length) return out;
  }
  out.push(text);
  return out;
}

/**
 * Current wallet key + account key values, for the tool-output redactor.
 * Re-read only when a key file's mtime/size changes (the panel can import a
 * new wallet mid-session).
 */
export function walletSecretLiterals(): string[] {
  const stats = WALLET_KEY_FILES.map((f) => {
    try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
  });
  const stamp = stats.join('|');
  if (secretCache && secretCache.stamp === stamp) return secretCache.values;

  const values = new Set<string>();
  WALLET_KEY_FILES.forEach((f, i) => {
    if (stats[i] === '-') return;
    try {
      for (const v of extractSecrets(f, fs.readFileSync(f, 'utf-8'))) {
        if (v.length < 32) continue;
        values.add(v);
        // An EVM key shows up with or without its 0x prefix.
        if (/^0x[0-9a-fA-F]{64}$/.test(v)) values.add(v.slice(2));
        else if (/^[0-9a-fA-F]{64}$/.test(v)) values.add('0x' + v);
      }
    } catch { /* unreadable: nothing to redact */ }
  });
  secretCache = { stamp, values: [...values] };
  return secretCache.values;
}
