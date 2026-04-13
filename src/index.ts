#!/usr/bin/env node

// Global error handlers — catch unhandled rejections/exceptions before they crash silently
process.on('unhandledRejection', (reason) => {
  console.error(`\x1b[31mUnhandled error: ${reason instanceof Error ? reason.message : String(reason)}\x1b[0m`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`);
  process.exit(1);
});

import { Command } from 'commander';
import { flushStats } from './stats/tracker.js';

// Ensure stats are flushed on any exit
process.on('exit', () => flushStats());
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

import { VERSION as version } from './config.js';

const program = new Command();

program
  .name('franklin')
  .description(
    'Franklin — The AI agent with a wallet.\n\n' +
      'While others chat, Franklin spends — turning your USDC into real work.\n\n' +
      'Pay per action in USDC on Base or Solana. No subscriptions. No accounts.'
  )
  .version(version);

program
  .command('setup [chain]')
  .description('Create a new wallet for payments (base or solana)')
  .action((chain) => setupCommand(chain));

program
  .command('start')
  .description('Start the runcode agent')
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
  .description('Configure runcode auto-start (writes ~/.claude/settings.json + installs LaunchAgent on macOS)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((options) => initCommand(options));

program
  .command('uninit')
  .description('Remove runcode configuration and uninstall LaunchAgent')
  .action(() => uninitCommand());

program
  .command('daemon <action>')
  .description('Manage runcode background proxy (start|stop|status)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((action, options) => daemonCommand(action, options));

program
  .command('panel')
  .description('Open the Franklin dashboard (localhost:3100)')
  .option('-p, --port <port>', 'Dashboard port', '3100')
  .action(async (options: { port?: string }) => {
    const { panelCommand } = await import('./commands/panel.js');
    await panelCommand(options);
  });

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
    'Manage runcode config (set, get, unset, list)\n' +
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

program
  .command('insights')
  .description('Show rich usage insights — cost breakdown, trends, projections')
  .option('-d, --days <n>', 'Window size in days (default: 30)', '30')
  .action(async (opts: { days?: string }) => {
    const { generateInsights, formatInsights } = await import('./stats/insights.js');
    const days = parseInt(opts.days ?? '30', 10) || 30;
    const report = generateInsights(days);
    process.stdout.write(formatInsights(report, days));
  });

program
  .command('search <query>')
  .description('Search past sessions by keyword (use quotes for phrases)')
  .option('-l, --limit <n>', 'Max results to show (default: 10)', '10')
  .option('-m, --model <substring>', 'Filter by model name substring')
  .action(async (query: string, opts: { limit?: string; model?: string }) => {
    const { searchSessions, formatSearchResults } = await import('./session/search.js');
    const limit = parseInt(opts.limit ?? '10', 10) || 10;
    const matches = searchSessions(query, { limit, model: opts.model });
    process.stdout.write(formatSearchResults(matches, query));
  });

// ─── franklin social (native X bot) ───────────────────────────────────────
// First-class subcommand. Handles setup / login / run / stats / config
// subactions. No plugin SDK, no MCP — everything lives in src/social/.
program
  .command('social [action] [arg]')
  .description('Native X bot — franklin social setup | login x | run | stats | config')
  .option('--dry-run', 'Generate drafts without posting (default for run)')
  .option('--live', 'Actually post to X (overrides dry-run default)')
  .option('-m, --model <model>', 'Override the model used for reply generation')
  .option('--debug', 'Enable debug logging')
  .action(async (
    action: string | undefined,
    arg: string | undefined,
    opts: { dryRun?: boolean; live?: boolean; model?: string; debug?: boolean }
  ) => {
    const { socialCommand } = await import('./commands/social.js');
    await socialCommand(action, arg, opts);
  });

// Plugin commands — dynamically registered from discovered plugins.
// Core stays plugin-agnostic: this loop adds a command for each installed plugin.
// Note: `social` is now a first-class native command above and NOT loaded as a
// plugin (the bundled social plugin was retired in v3.2.0 in favour of the
// src/social/ subsystem).
{
  const { loadAllPlugins, listWorkflowPlugins } = await import('./plugins/registry.js');
  await loadAllPlugins();
  for (const lp of listWorkflowPlugins()) {
    const { manifest } = lp;
    // Skip any plugin whose id collides with a built-in command (e.g. social)
    if (manifest.id === 'social') continue;
    program
      .command(`${manifest.id} [action]`)
      .description(manifest.description)
      .option('--dry', 'Dry run — preview without side effects')
      .option('--debug', 'Enable debug logging')
      .action(async (action: string, opts: { dry?: boolean; debug?: boolean }) => {
        const { pluginCommand } = await import('./commands/plugin.js');
        await pluginCommand(manifest.id, action, { dryRun: opts.dry, debug: opts.debug });
      });
  }
}

program
  .command('migrate')
  .description('Import data from other AI tools (Claude Code, Cline, Cursor)')
  .action(async () => {
    const { migrateCommand } = await import('./commands/migrate.js');
    await migrateCommand();
  });

program
  .command('plugins')
  .description('List installed plugins')
  .action(async () => {
    const { listAvailablePlugins } = await import('./commands/plugin.js');
    listAvailablePlugins();
  });

// Default action: if no subcommand given, run 'start'
const args = process.argv.slice(2);
const firstArg = args[0];
const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-V', '--version']);
const START_ONLY_FLAGS = new Set(['--trust', '--debug', '-m', '--model']);

function hasAnyFlag(argv: string[], flags: Set<string>): boolean {
  return argv.some(arg => flags.has(arg));
}

function hasStartOnlyFlag(argv: string[]): boolean {
  return argv.some(arg => START_ONLY_FLAGS.has(arg));
}

// Handle chain shortcuts: `runcode solana` or `runcode base`
if (firstArg === 'solana' || firstArg === 'base') {
  if (hasAnyFlag(args, HELP_FLAGS)) {
    program.parse(['node', 'franklin', 'start', '--help']);
  }
  if (hasAnyFlag(args, VERSION_FLAGS)) {
    console.log(version);
    process.exit(0);
  }
  const { saveChain } = await import('./config.js');
  saveChain(firstArg as 'base' | 'solana');
  const startOpts: Record<string, unknown> = { version };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--trust') startOpts.trust = true;
    else if (args[i] === '--debug') startOpts.debug = true;
    else if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      startOpts.model = args[++i];
    }
  }
  await startCommand(startOpts as Parameters<typeof startCommand>[0]);
  process.exit(0);
} else if (!firstArg || firstArg.startsWith('-')) {
  if (hasAnyFlag(args, HELP_FLAGS) && hasStartOnlyFlag(args)) {
    program.parse(['node', 'franklin', 'start', '--help']);
  }
  if (hasAnyFlag(args, VERSION_FLAGS) && hasStartOnlyFlag(args)) {
    console.log(version);
    process.exit(0);
  }
  if (hasAnyFlag(args, HELP_FLAGS) || hasAnyFlag(args, VERSION_FLAGS)) {
    program.parse();
  }
  // No subcommand or only flags — treat as 'start' with flags
  const startOpts: Record<string, unknown> = { version };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trust') startOpts.trust = true;
    else if (args[i] === '--debug') startOpts.debug = true;
    else if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      startOpts.model = args[++i];
    }
  }
  await startCommand(startOpts as Parameters<typeof startCommand>[0]);
  process.exit(0);
} else {
  program.parse();
}
