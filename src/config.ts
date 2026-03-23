import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export type Chain = 'base' | 'solana';

export const BLOCKRUN_DIR = path.join(os.homedir(), '.blockrun');
export const CHAIN_FILE = path.join(BLOCKRUN_DIR, 'payment-chain');

export const API_URLS: Record<Chain, string> = {
  base: 'https://blockrun.ai/api',
  solana: 'https://sol.blockrun.ai/api',
};

export const DEFAULT_PROXY_PORT = 8402;

export function saveChain(chain: Chain): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(CHAIN_FILE, chain + '\n', { mode: 0o600 });
}

export function loadChain(): Chain {
  const envChain = process.env.BRCC_CHAIN;
  if (envChain === 'solana') return 'solana';
  if (envChain === 'base') return 'base';

  try {
    const content = fs.readFileSync(CHAIN_FILE, 'utf-8').trim();
    if (content === 'solana') return 'solana';
    return 'base';
  } catch {
    return 'base';
  }
}
