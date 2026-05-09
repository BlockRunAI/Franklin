import fs from 'node:fs';
import { loadChain } from '../config.js';
import type { Chain } from '../config.js';

export interface WalletCompromiseCheckItem {
  description: string;
  status: 'ok' | 'warning' | 'error';
  detail?: string;
}

export interface WalletCompromiseReport {
  chain: Chain;
  address: string | null;
  walletFile: string;
  fileMode?: string;
  items: WalletCompromiseCheckItem[];
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function getStatusPriority(status: WalletCompromiseCheckItem['status']): number {
  switch (status) {
    case 'error': return 3;
    case 'warning': return 2;
    default: return 1;
  }
}

export function formatWalletCompromiseReport(report: WalletCompromiseReport): string {
  const highestStatus = report.items.reduce((acc, item) => Math.max(acc, getStatusPriority(item.status)), 1);
  const summary = highestStatus === 3
    ? 'COMPROMISE DETECTED — immediate action required.'
    : highestStatus === 2
      ? 'Potential compromise indicators found. Review the warnings below.'
      : 'No immediate compromise indicators found.';

  const lines = [
    '**Wallet Compromise Check**',
    `Chain: ${report.chain}`,
    `Address: ${report.address ?? '(unknown)'}`,
    `Wallet file: ${report.walletFile}`,
  ];

  if (report.fileMode) {
    lines.push(`File permissions: ${report.fileMode}`);
  }

  lines.push('', `Summary: ${summary}`, '', '**Findings:**');
  for (const item of report.items) {
    const marker = item.status === 'ok' ? '✅' : item.status === 'warning' ? '⚠️' : '❌';
    lines.push(`- ${marker} ${item.description}${item.detail ? ` — ${item.detail}` : ''}`);
  }

  lines.push('',
    'Recommendations:',
    '- If the wallet file is world-readable or writable, rotate the wallet immediately.',
    '- If the disk address does not match the current session address, restart Franklin after importing a new key.',
    '- Keep your private key offline and never share it with untrusted software.'
  );

  return lines.join('\n');
}

export async function checkWalletCompromise(): Promise<WalletCompromiseReport> {
  const chain = loadChain();
  const {
    loadWallet,
    loadSolanaWallet,
    getWalletAddress,
    getOrCreateWallet,
    getOrCreateSolanaWallet,
    WALLET_FILE_PATH,
    SOLANA_WALLET_FILE_PATH,
  } = await import('@blockrun/llm');

  const walletFile = chain === 'solana' ? SOLANA_WALLET_FILE_PATH : WALLET_FILE_PATH;
  const items: WalletCompromiseCheckItem[] = [];
  let diskKey: string | null = null;
  let diskAddress: string | null = null;
  let currentAddress: string | null = null;

  if (!fs.existsSync(walletFile)) {
    items.push({
      description: 'Wallet file exists on disk',
      status: 'error',
      detail: `Missing wallet file at ${walletFile}`,
    });
    return { chain, address: null, walletFile, items };
  }

  try {
    const stat = fs.lstatSync(walletFile);
    const mode = stat.mode & 0o777;
    const modeString = formatMode(stat.mode);

    if (stat.isSymbolicLink()) {
      items.push({
        description: 'Wallet file is a symbolic link',
        status: 'warning',
        detail: 'Symlinks can hide a redirected key file. Verify this is expected.',
      });
    } else {
      items.push({
        description: 'Wallet file exists and is a regular file',
        status: 'ok',
      });
    }

    if ((mode & 0o077) !== 0) {
      items.push({
        description: 'Wallet file permissions are restrictive',
        status: 'warning',
        detail: `Current permissions are ${modeString}; expected 0600 or stricter`,
      });
    } else {
      items.push({
        description: 'Wallet file permissions are secure',
        status: 'ok',
        detail: `Permissions are ${modeString}`,
      });
    }

    if ((mode & 0o020) !== 0) {
      items.push({
        description: 'Group write permission is set on wallet file',
        status: 'warning',
        detail: `Permissions ${modeString} allow group write access`,
      });
    }
    if ((mode & 0o002) !== 0) {
      items.push({
        description: 'World write permission is set on wallet file',
        status: 'warning',
        detail: `Permissions ${modeString} allow world write access`,
      });
    }
    if ((mode & 0o004) !== 0) {
      items.push({
        description: 'World read permission is set on wallet file',
        status: 'warning',
        detail: `Permissions ${modeString} allow world read access`,
      });
    }

    diskKey = chain === 'solana'
      ? loadSolanaWallet()
      : loadWallet();

    if (!diskKey) {
      items.push({
        description: 'Private key can be read from wallet file',
        status: 'error',
        detail: 'Could not load the private key from disk',
      });
      return { chain, address: null, walletFile, fileMode: formatMode(stat.mode), items };
    }

    if (chain === 'solana') {
      const { solanaPublicKey } = await import('@blockrun/llm');
      diskAddress = await solanaPublicKey(diskKey);
      const current = await getOrCreateSolanaWallet();
      currentAddress = current.address;
    } else {
      const { privateKeyToAccount } = await import('viem/accounts');
      diskAddress = privateKeyToAccount(diskKey as `0x${string}`).address;
      const current = getOrCreateWallet();
      currentAddress = current.address;
    }

    if (diskAddress) {
      items.push({
        description: 'Disk wallet derives a valid address',
        status: 'ok',
        detail: `Address: ${diskAddress}`,
      });
    }

    if (currentAddress && diskAddress && currentAddress !== diskAddress) {
      items.push({
        description: 'Current session wallet does not match the disk wallet',
        status: 'warning',
        detail: `Session: ${currentAddress}, Disk: ${diskAddress}`,
      });
    } else if (currentAddress && diskAddress) {
      items.push({
        description: 'Current session wallet matches the disk wallet',
        status: 'ok',
      });
    }

    return {
      chain,
      address: diskAddress,
      walletFile,
      fileMode: formatMode(stat.mode),
      items,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    items.push({
      description: 'Wallet compromise check encountered an error',
      status: 'error',
      detail: message,
    });
    return { chain, address: null, walletFile, items };
  }
}
