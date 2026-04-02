import { getOrCreateWallet, scanWallets, getWalletAddress, getOrCreateSolanaWallet, scanSolanaWallets, } from '@blockrun/llm';
import { loadChain } from '../config.js';
export function walletExists() {
    const chain = loadChain();
    if (chain === 'solana') {
        return scanSolanaWallets().length > 0;
    }
    return scanWallets().length > 0;
}
export function setupWallet() {
    const { address, isNew } = getOrCreateWallet();
    return { address, isNew };
}
export async function setupSolanaWallet() {
    const { address, isNew } = await getOrCreateSolanaWallet();
    return { address, isNew };
}
export function getAddress() {
    const addr = getWalletAddress();
    if (!addr)
        throw new Error('No wallet found. Run `0xcode setup` first.');
    return addr;
}
