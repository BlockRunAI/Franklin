import chalk from 'chalk';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { loadChain, DASHBOARD_URL } from '../config.js';
import { isKeyMode, loadApiKey, maskApiKey } from '../payments/auth-mode.js';
import { loadStats } from '../stats/tracker.js';

export async function balanceCommand() {
  const chain = loadChain();

  // API-key mode settles against a prepaid credit balance. The gateway exposes
  // no key-scoped balance or usage endpoint, so there is no number to print
  // that would be true — report what is known (the key works, what Franklin
  // has spent locally) and send the user to the authority for the rest, rather
  // than inventing a figure.
  if (isKeyMode()) {
    const key = loadApiKey();
    console.log(`Pay mode:  ${chalk.green('api-key')}`);
    console.log(`Key:       ${chalk.cyan(key ? maskApiKey(key) : 'unknown')}`);
    try {
      const stats = loadStats();
      const spent = stats.totalCostUsd ?? 0;
      const est = stats.totalEstimatedCostUsd ?? 0;
      console.log(
        `Spent:     ${chalk.yellow((est > 0 ? '~$' : '$') + spent.toFixed(4))}` +
        chalk.dim('  (Franklin\'s local tally, all time)')
      );
    } catch { /* stats are best-effort */ }
    console.log(
      chalk.dim(`\nCredit balance and full activity: ${DASHBOARD_URL}/dashboard`)
    );
    console.log(
      chalk.dim('Franklin cannot read the credit balance — the gateway exposes no endpoint for it.')
    );
    console.log(chalk.dim('To spend from a USDC wallet instead: franklin --wallet, or franklin logout.'));
    return;
  }

  try {
    if (chain === 'solana') {
      const client = await setupAgentSolanaWallet({ silent: true });
      const address = await client.getWalletAddress();
      const balance = await client.getBalance();

      console.log(`Chain:  ${chalk.magenta('solana')}`);
      console.log(`Wallet: ${chalk.cyan(address)}`);
      console.log(
        `USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`
      );

      if (balance === 0) {
        console.log(
          chalk.dim(`\nSend USDC on Solana to ${address} to get started.`)
        );
      }
    } else {
      const client = setupAgentWallet({ silent: true });
      const address = client.getWalletAddress();
      const balance = await client.getBalance();

      console.log(`Chain:  ${chalk.magenta('base')}`);
      console.log(`Wallet: ${chalk.cyan(address)}`);
      console.log(
        `USDC Balance: ${chalk.green(`$${balance.toFixed(2)}`)}`
      );

      if (balance === 0) {
        console.log(
          chalk.dim(`\nSend USDC on Base to ${address} to get started.`)
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('ENOENT') || msg.includes('wallet') || msg.includes('key')) {
      console.log(chalk.red('No wallet found. Run `franklin setup` first.'));
    } else {
      console.log(chalk.red(`Error checking balance: ${msg || 'unknown error'}`));
    }
    process.exit(1);
  }
}
