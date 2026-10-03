import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _version = '2.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
  _version = pkg.version || _version;
} catch { /* use default */ }
export const VERSION = _version;

// Shared User-Agent string for all outbound HTTP requests
export const USER_AGENT = `franklin/${_version} (node/${process.versions.node}; ${process.platform}; ${process.arch})`;

export type Chain = 'base' | 'solana' | 'arc';

/**
 * Every chain Franklin can pay on. Base and Arc are both EVM and share one
 * wallet key (~/.blockrun/.session): the same address holds USDC on each, and
 * the 402's `network` selects which chain's USDC domain gets signed. Solana has
 * its own key.
 */
export const CHAINS: readonly Chain[] = ['base', 'solana', 'arc'];

export function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && (CHAINS as readonly string[]).includes(value);
}

/** True for the chains paid from the EVM wallet (Base, Arc). */
export function isEvmChain(chain: Chain): boolean {
  return chain !== 'solana';
}

/** Display name, for copy that names the chain a payment settles on. */
export const CHAIN_LABELS: Record<Chain, string> = {
  base: 'Base',
  solana: 'Solana',
  arc: 'Arc',
};

export const BLOCKRUN_DIR = path.join(os.homedir(), '.blockrun');
export const CHAIN_FILE = path.join(BLOCKRUN_DIR, 'payment-chain');

export const API_URLS: Record<Chain, string> = {
  base: 'https://blockrun.ai/api',
  solana: 'https://sol.blockrun.ai/api',
  // Circle's Arc (eip155:5042): the same gateway API as Base, settled through
  // the Circle facilitator. Needs @blockrun/llm >= 3.16, which signs the 402's
  // network rather than Base's USDC domain.
  arc: 'https://arc.blockrun.ai/api',
};

export const DEFAULT_PROXY_PORT = 8402;

// BlockRun agent-market (the paid skill marketplace Franklin browses with
// `/market` and hires with the agent_talent tool). It speaks standard
// single-leg `exact` x402 on Base, so Franklin pays it with the same EVM
// wallet it uses for the gateway. Overridable via env for local end-to-end
// testing against a dev server.
export const MARKET_URL = (process.env.BLOCKRUN_MARKET_URL || 'https://business.blockrun.ai').replace(/\/+$/, '');

export function saveChain(chain: Chain): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(CHAIN_FILE, chain + '\n', { mode: 0o600 });
}

export function loadChain(): Chain {
  const envChain = process.env.RUNCODE_CHAIN;
  if (isChain(envChain)) return envChain;

  try {
    const content = fs.readFileSync(CHAIN_FILE, 'utf-8').trim();
    if (isChain(content)) return content;
  } catch { /* no explicit choice on disk — fall through to the default */ }

  // Default chain is Solana. Exception: a Base wallet with no Solana wallet
  // means the user funded before the default flipped — silently moving their
  // spending to an empty Solana wallet would strand their USDC, so keep them
  // on Base until they choose explicitly (`franklin solana`, panel switch,
  // setup). Pure read — every path that creates the other wallet also calls
  // saveChain, so the heuristic is only ever the pre-choice fallback.
  // (.session / .solana-session are the SDK's wallet key files.)
  const hasBaseWallet = fs.existsSync(path.join(BLOCKRUN_DIR, '.session'));
  const hasSolanaWallet = fs.existsSync(path.join(BLOCKRUN_DIR, '.solana-session'));
  return hasBaseWallet && !hasSolanaWallet ? 'base' : 'solana';
}

// ── API-key mode ──────────────────────────────────────────────────────────
// BlockRun runs a second, prepaid-credit gateway that authenticates with a
// bearer key instead of an x402 signature. It shares no auth with the x402
// hosts above: a bearer key sent to blockrun.ai/api is ignored (still 402),
// and this host 401s when the key is missing or bad — there is no x402
// fallback on it. That isolation is what lets key mode ship without touching
// wallet users.
//
// Note the path shape differs: API_URLS entries end in `/api`, this one does
// not — api.blockrun.ai serves `/v1/...` at the root and returns a
// `wrong_host` 404 for `/api/v1/...`. Callers that build `${base}/v1/...`
// work unchanged in both modes; callers that assume the `/api` suffix do not.
export const KEY_API_URL = 'https://api.blockrun.ai';

/** Where `franklin login` persists the key (0600). */
export const API_KEY_FILE = path.join(BLOCKRUN_DIR, 'api-key');

/** Dashboard host — signup, top-up, activity. Not an API surface. */
export const DASHBOARD_URL = 'https://user.blockrun.ai';
