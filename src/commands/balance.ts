import chalk from 'chalk';
import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { loadChain, DASHBOARD_URL } from '../config.js';
import { fetchCreditBalance, isKeyMode, loadApiKey, maskApiKey } from '../payments/auth-mode.js';
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
    const credit = await fetchCreditBalance();
    if (credit) {
      console.log(`Account:   ${chalk.dim(credit.accountId)} (${chalk.dim(credit.billingMode)})`);
      // `ungated` means no ceiling, and remaining_usd is legitimately null.
      // Coalescing that to 0 would tell a paying customer they are broke, so
      // branch on the mode rather than on the number.
      if (credit.remainingUsd !== null) {
        const low = credit.remainingUsd < 1;
        console.log(
          `Remaining: ${(low ? chalk.yellow : chalk.green)('$' + credit.remainingUsd.toFixed(4))}` +
          chalk.dim(` of $${credit.grantedUsd.toFixed(2)} granted`)
        );
      } else {
        console.log(`Remaining: ${chalk.dim('no prepaid limit on this account')}`);
      }
      console.log(`Spent:     ${chalk.cyan('$' + credit.spentUsd.toFixed(4))}` + chalk.dim('  (BlockRun, authoritative)'));
      if (credit.blocked) {
        // An append-only code set — show the raw code when it is one we do not
        // know rather than swallowing it.
        const explain: Record<string, string> = {
          ACCOUNT_SUSPENDED: 'this account is suspended',
          CREDIT_LIMIT_REACHED: 'the credit limit has been reached',
          BALANCE_EXHAUSTED: 'the prepaid balance is exhausted',
        };
        const reason = credit.blockedReason
          ? explain[credit.blockedReason] ?? `blocked (${credit.blockedReason})`
          : 'blocked';
        console.log(chalk.red(`\nYour next paid call will be refused — ${reason}.`));
        console.log(chalk.dim(`Top up at ${DASHBOARD_URL}/dashboard.`));
      }
    }

    try {
      const stats = loadStats();
      const spent = stats.totalCostUsd ?? 0;
      const est = stats.totalEstimatedCostUsd ?? 0;
      console.log(
        `Local:     ${chalk.dim((est > 0 ? '~$' : '$') + spent.toFixed(4))}` +
        chalk.dim("  (Franklin's own tally, all time, both pay modes — expected to differ)")
      );
    } catch { /* stats are best-effort */ }

    if (!credit) {
      console.log(chalk.dim(`\nCould not read the credit balance from the gateway.`));
    }
    console.log(chalk.dim(`\nFull activity: ${DASHBOARD_URL}/dashboard`));
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
