import chalk from 'chalk';
import { Command } from 'commander';
import { checkWalletCompromise, formatWalletCompromiseReport } from '../wallet/compromise.js';

export function buildWalletCommand(): Command {
  const wallet = new Command('wallet');

  wallet
    .description('Manage Franklin wallet — check compromise status, balance, etc.')
    .addCommand(
      new Command('check')
        .description('Check wallet for compromise indicators (permissions, address mismatch, etc.)')
        .action(async () => {
          try {
            const report = await checkWalletCompromise();
            console.log(formatWalletCompromiseReport(report));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Wallet check failed: ${msg}`));
            process.exit(1);
          }
        })
    );

  return wallet;
}