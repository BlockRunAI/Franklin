import chalk from 'chalk';
import {
  getOrCreateWallet,
  scanWallets,
  getOrCreateSolanaWallet,
  scanSolanaWallets,
} from '@blockrun/llm';
import { type Chain, saveChain } from '../config.js';

export async function setupCommand(chainArg?: string) {
  const chain: Chain =
    chainArg === 'solana' ? 'solana' : 'base';

  if (chain === 'solana') {
    const wallets = scanSolanaWallets();
    if (wallets.length > 0) {
      console.log(chalk.yellow('Solana wallet already exists.'));
      console.log(`Address: ${chalk.cyan(wallets[0].publicKey)}`);
      saveChain('solana');
      return;
    }

    console.log('Creating new Solana wallet...\n');
    const { address, isNew } = await getOrCreateSolanaWallet();

    if (isNew) {
      console.log(chalk.green('Solana wallet created!\n'));
    }
    console.log(`Address: ${chalk.cyan(address)}`);
    console.log(
      `\nSend USDC on Solana to this address to fund your account.`
    );
  } else {
    const wallets = scanWallets();
    if (wallets.length > 0) {
      console.log(chalk.yellow('Wallet already exists.'));
      console.log(`Address: ${chalk.cyan(wallets[0].address)}`);
      saveChain('base');
      return;
    }

    console.log('Creating new wallet...\n');
    const { address, isNew } = getOrCreateWallet();

    if (isNew) {
      console.log(chalk.green('Wallet created!\n'));
    }
    console.log(`Address: ${chalk.cyan(address)}`);
    console.log(
      `\nSend USDC on Base to this address to fund your account.`
    );
  }

  saveChain(chain);
  console.log(
    `Then run ${chalk.bold('brcc start')} to launch Claude Code.\n`
  );
  console.log(chalk.dim(`Chain: ${chain} — saved to ~/.blockrun/`));
}
