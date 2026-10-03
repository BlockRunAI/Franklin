import {
  getOrCreateWallet,
  scanWallets,
  getWalletAddress,
  getOrCreateSolanaWallet,
  scanSolanaWallets,
} from '@blockrun/llm';
import { API_URLS, USER_AGENT, loadChain, type Chain } from '../config.js';

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
  if (!addr) throw new Error('No wallet found. Run `franklin setup` first.');
  return addr;
}

/**
 * USDC balance of an EVM wallet on the given chain, in dollars.
 *
 * Base reads through the SDK. The SDK's reader is Base-only, so Arc asks the
 * Arc gateway's free `/v1/balance`, which reads the USDC ERC-20 at 0x3600…0000
 * (6 decimals) through BlockRun's own Arc RPC — public Arc proxies answer
 * eth_chainId but fail eth_call. Like the Base reader this THROWS on failure
 * rather than returning 0, so an unreachable endpoint never reads as an empty
 * wallet.
 */
export async function readEvmBalance(
  chain: Exclude<Chain, 'solana'>,
  client: { getWalletAddress(): string; getBalance(): Promise<number> },
): Promise<number> {
  if (chain !== 'arc') return client.getBalance();
  const address = client.getWalletAddress();
  const res = await fetch(`${API_URLS.arc}/v1/balance?address=${encodeURIComponent(address)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Arc balance read failed (HTTP ${res.status})`);
  const body = (await res.json()) as { balance?: unknown };
  if (typeof body.balance !== 'string' || !/^\d+$/.test(body.balance)) {
    throw new Error('Arc balance read returned no balance');
  }
  return Number(BigInt(body.balance)) / 1_000_000;
}
