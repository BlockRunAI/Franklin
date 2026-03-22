import { Keypair, VersionedTransaction } from '@solana/web3.js';
import fs from 'node:fs/promises';
import { CONFIG_DIR, WALLET_PATH } from '../config.js';

export interface WalletData {
  publicKey: string;
  secretKey: number[];
}

export interface WalletAdapter {
  publicKey: { toString(): string };
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

export async function walletExists(): Promise<boolean> {
  try {
    await fs.access(WALLET_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function generateWallet(): Promise<{
  publicKey: string;
  keypair: Keypair;
}> {
  const keypair = Keypair.generate();
  const walletData: WalletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
  };

  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(WALLET_PATH, JSON.stringify(walletData, null, 2));
  await fs.chmod(WALLET_PATH, 0o600);

  return { publicKey: keypair.publicKey.toBase58(), keypair };
}

export async function loadWallet(): Promise<Keypair> {
  const data = await fs.readFile(WALLET_PATH, 'utf-8');
  const walletData: WalletData = JSON.parse(data);
  return Keypair.fromSecretKey(Uint8Array.from(walletData.secretKey));
}

export async function getPublicKey(): Promise<string> {
  const data = await fs.readFile(WALLET_PATH, 'utf-8');
  const walletData: WalletData = JSON.parse(data);
  return walletData.publicKey;
}

export function createWalletAdapter(keypair: Keypair): WalletAdapter {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([keypair]);
      return tx;
    },
  };
}
