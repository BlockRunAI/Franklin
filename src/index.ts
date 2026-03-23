#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';
import { modelsCommand } from './commands/models.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name('brcc')
  .description(
    'BlockRun Claude Code — run Claude Code with any model, pay with USDC.\n\n' +
      'Use /model inside Claude Code to switch between models on the fly.'
  )
  .version('0.5.0');

program
  .command('setup [chain]')
  .description('Create a new wallet for payments (base or solana)')
  .action((chain) => setupCommand(chain));

program
  .command('start')
  .description('Start proxy and launch Claude Code')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .option(
    '-m, --model <model>',
    'Default model (e.g. openai/gpt-5.4, anthropic/claude-sonnet-4.6)'
  )
  .option('--no-launch', 'Start proxy only, do not launch Claude Code')
  .option('--debug', 'Enable debug logging')
  .action(startCommand);

program
  .command('models')
  .description('List available models and pricing')
  .action(modelsCommand);

program
  .command('balance')
  .description('Check wallet USDC balance')
  .action(balanceCommand);

program
  .command('config <action> [key] [value]')
  .description(
    'Manage brcc config (set, get, unset, list)\n' +
      'Keys: default-model, sonnet-model, opus-model, haiku-model, smart-routing'
  )
  .action(configCommand);

program.parse();
