#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';
import { modelsCommand } from './commands/models.js';
import { configCommand } from './commands/config.js';
import { statsCommand } from './commands/stats.js';
import { logsCommand } from './commands/logs.js';
import { daemonCommand } from './commands/daemon.js';
import { initCommand } from './commands/init.js';
import { uninitCommand } from './commands/uninit.js';
import { proxyCommand } from './commands/proxy.js';

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
  .name('0xcode')
  .description(
    '0xcode — AI coding agent powered by 41+ models, pay with USDC.\n\n' +
      'Use /model to switch between models on the fly.'
  )
  .version(version);

program
  .command('setup [chain]')
  .description('Create a new wallet for payments (base or solana)')
  .action((chain) => setupCommand(chain));

program
  .command('start')
  .description('Start the 0xcode agent')
  .option(
    '-m, --model <model>',
    'Model to use (e.g. openai/gpt-5.4, anthropic/claude-sonnet-4.6). Default from config or claude-sonnet-4.6'
  )
  .option('--debug', 'Enable debug logging')
  .option('--trust', 'Trust mode — skip permission prompts for all tools')
  .action((options) => startCommand({ ...options, version }));

program
  .command('proxy')
  .description('Run payment proxy for Claude Code or other tools')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .option(
    '-m, --model <model>',
    'Default model for proxied requests'
  )
  .option('--no-fallback', 'Disable automatic fallback to backup models')
  .option('--debug', 'Enable debug logging')
  .action((options) => proxyCommand({ ...options, version }));

program
  .command('init')
  .description('Configure 0xcode auto-start (writes ~/.claude/settings.json + installs LaunchAgent on macOS)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((options) => initCommand(options));

program
  .command('uninit')
  .description('Remove 0xcode configuration and uninstall LaunchAgent')
  .action(() => uninitCommand());

program
  .command('daemon <action>')
  .description('Manage 0xcode background proxy (start|stop|status)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((action, options) => daemonCommand(action, options));

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
    'Manage 0xcode config (set, get, unset, list)\n' +
      'Keys: default-model, sonnet-model, opus-model, haiku-model, smart-routing'
  )
  .action(configCommand);

program
  .command('stats')
  .description('Show usage statistics and cost savings')
  .option('--clear', 'Clear all statistics')
  .option('--json', 'Output in JSON format')
  .action(statsCommand);

program
  .command('logs')
  .description('View debug logs (start with --debug to enable logging)')
  .option('-f, --follow', 'Follow log output in real time')
  .option('-n, --lines <count>', 'Number of lines to show (default: 50)')
  .option('--clear', 'Delete log file')
  .action(logsCommand);

// Default action: if no subcommand given, run 'start'
const args = process.argv.slice(2);
const knownCommands = program.commands.map(c => c.name());
const firstArg = args[0];

if (!firstArg || (firstArg.startsWith('-') && firstArg !== '-h' && firstArg !== '--help' && firstArg !== '-V' && firstArg !== '--version')) {
  // No subcommand or only flags — treat as 'start' with flags
  const startOpts: Record<string, unknown> = { version };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trust') startOpts.trust = true;
    else if (args[i] === '--debug') startOpts.debug = true;
    else if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      startOpts.model = args[++i];
    }
  }
  startCommand(startOpts as Parameters<typeof startCommand>[0]);
} else {
  program.parse();
}
