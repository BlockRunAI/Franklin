import chalk from 'chalk';
import {
  walletExists,
  generateWallet,
  getPublicKey,
} from '../wallet/manager.js';

export async function setupCommand() {
  if (await walletExists()) {
    const pubkey = await getPublicKey();
    console.log(chalk.yellow('Wallet already exists.'));
    console.log(`Address: ${chalk.cyan(pubkey)}`);
    console.log(
      `\nTo create a new wallet, delete ~/.brcc/wallet.json first.`
    );
    return;
  }

  console.log('Generating new Solana wallet...\n');
  const { publicKey } = await generateWallet();

  console.log(chalk.green('Wallet created!\n'));
  console.log(`Address: ${chalk.cyan(publicKey)}`);
  console.log(`\nSend USDC (Solana) to this address to fund your account.`);
  console.log(`Then run ${chalk.bold('brcc start')} to launch Claude Code.\n`);
  console.log(chalk.dim('Wallet saved to ~/.brcc/wallet.json'));
}
