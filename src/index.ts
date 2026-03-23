#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';

const program = new Command();

program
  .name('brcc')
  .description(
    'BlockRun Claude Code — run Claude Code with any model, pay with USDC'
  )
  .version('0.1.0');

program
  .command('setup [chain]')
  .description('Create a new wallet for payments (base or solana)')
  .action((chain) => setupCommand(chain));

program
  .command('start')
  .description('Start proxy and launch Claude Code')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .option('--no-launch', 'Start proxy only, do not launch Claude Code')
  .action(startCommand);

program
  .command('balance')
  .description('Check wallet USDC balance')
  .action(balanceCommand);

program.parse();
