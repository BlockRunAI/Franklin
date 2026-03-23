import chalk from 'chalk';
import { getOrCreateWallet, scanWallets } from '@blockrun/llm';

export async function setupCommand() {
  const wallets = scanWallets();
  if (wallets.length > 0) {
    console.log(chalk.yellow('Wallet already exists.'));
    console.log(`Address: ${chalk.cyan(wallets[0].address)}`);
    return;
  }

  console.log('Creating new wallet...\n');
  const { address, isNew } = getOrCreateWallet();

  if (isNew) {
    console.log(chalk.green('Wallet created!\n'));
  }
  console.log(`Address: ${chalk.cyan(address)}`);
  console.log(`\nSend USDC on Base to this address to fund your account.`);
  console.log(
    `Then run ${chalk.bold('brcc start')} to launch Claude Code.\n`
  );
  console.log(chalk.dim('Wallet saved to ~/.blockrun/'));
}
