import chalk from 'chalk';
import {
  getOrCreateWallet,
  scanWallets,
  getOrCreateSolanaWallet,
  scanSolanaWallets,
} from '@blockrun/llm';
import { type Chain, saveChain, DASHBOARD_URL } from '../config.js';
import { isKeyMode, loadApiKey, maskApiKey } from '../payments/auth-mode.js';

export async function setupCommand(chainArg?: string) {
  // Solana is the default chain; `franklin setup base` opts into Base.
  const chain: Chain =
    chainArg === 'base' ? 'base' : 'solana';

  // A configured key already pays for everything, so creating a wallet here
  // would be busywork the user did not ask for. Say so and stop, rather than
  // silently making a second credential they will never fund.
  if (isKeyMode()) {
    const key = loadApiKey();
    console.log(chalk.green('Already set up with an API key.'));
    console.log(`Key: ${chalk.cyan(key ? maskApiKey(key) : 'unknown')}`);
    console.log(chalk.dim(`\nTop up at ${DASHBOARD_URL}/dashboard, then run \`franklin start\`.`));
    console.log(chalk.dim('Want a USDC wallet as well? Run `franklin logout` first, then `franklin setup`.'));
    return;
  }

  if (chain === 'solana') {
    const wallets = scanSolanaWallets();
    if (wallets.length > 0) {
      console.log(chalk.yellow('Solana wallet already exists.'));
      console.log(`Address: ${chalk.cyan(wallets[0].publicKey)}`);
      console.log(chalk.dim('\nNext steps:'));
      console.log(chalk.dim('  franklin start        — start coding'));
      console.log(chalk.dim('  franklin balance      — check USDC balance'));
      console.log(chalk.dim('  franklin start -m free — use free models (no USDC needed)'));
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
      console.log(chalk.dim('\nNext steps:'));
      console.log(chalk.dim('  franklin start        — start coding'));
      console.log(chalk.dim('  franklin balance      — check USDC balance'));
      console.log(chalk.dim('  franklin start -m free — use free models (no USDC needed)'));
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
    `Then run ${chalk.bold('franklin start')} to begin.\n`
  );
  console.log(chalk.dim(`Chain: ${chain} — saved to ~/.blockrun/`));
  console.log(
    chalk.dim(`\nPrefer a prepaid balance to a wallet? Sign up at ${DASHBOARD_URL},`)
  );
  console.log(chalk.dim('then run `franklin login brk_live_...` — no crypto required.'));
}
