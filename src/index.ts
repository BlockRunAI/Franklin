#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';
import { modelsCommand } from './commands/models.js';
import { configCommand } from './commands/config.js';
import { statsCommand } from './commands/stats.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let version = '0.9.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));
  version = pkg.version || version;
} catch { /* use default */ }

const program = new Command();

program
  .name('brcc')
  .description(
    'BlockRun Claude Code — run Claude Code with any model, pay with USDC.\n\n' +
      'Use /model inside Claude Code to switch between models on the fly.'
  )
  .version(version);

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
  .option('--no-fallback', 'Disable automatic fallback to backup models')
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

program
  .command('stats')
  .description('Show usage statistics and cost savings')
  .option('--clear', 'Clear all statistics')
  .option('--json', 'Output in JSON format')
  .action(statsCommand);

program.parse();
