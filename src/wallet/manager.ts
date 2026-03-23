import {
  getOrCreateWallet,
  scanWallets,
  getWalletAddress,
} from '@blockrun/llm';

export function walletExists(): boolean {
  const wallets = scanWallets();
  return wallets.length > 0;
}

export function setupWallet(): { address: string; isNew: boolean } {
  const { address, isNew } = getOrCreateWallet();
  return { address, isNew };
}

export function getAddress(): string {
  const addr = getWalletAddress();
  if (!addr) throw new Error('No wallet found. Run `brcc setup` first.');
  return addr;
}
