import {
  getOrCreateWallet,
  scanWallets,
  getWalletAddress,
  getOrCreateSolanaWallet,
  scanSolanaWallets,
} from '@blockrun/llm';
import { loadChain } from '../config.js';

export function walletExists(): boolean {
  const chain = loadChain();
  if (chain === 'solana') {
    return scanSolanaWallets().length > 0;
  }
  return scanWallets().length > 0;
}

export function setupWallet(): { address: string; isNew: boolean } {
  const { address, isNew } = getOrCreateWallet();
  return { address, isNew };
}

export async function setupSolanaWallet(): Promise<{
  address: string;
  isNew: boolean;
}> {
  const { address, isNew } = await getOrCreateSolanaWallet();
  return { address, isNew };
}

export function getAddress(): string {
  const addr = getWalletAddress();
  if (!addr) throw new Error('No wallet found. Run `runcode setup` first.');
  return addr;
}
