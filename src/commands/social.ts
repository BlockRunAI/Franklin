/**
 * franklin social <action>
 *
 * Native X bot subsystem. No MCP, no plugin SDK, no external CLI deps.
 * Ships as part of the core npm package; only runtime dep is playwright-core,
 * which is lazy-imported so startup stays fast.
 *
 * Actions:
 *   setup     — install chromium via playwright, write default config
 *   login x   — open browser to x.com and wait for user to log in; save state
 *   run       — search X, generate drafts, post (requires --live) or dry-run
 *   stats     — show posted/skipped/drafted counts and total cost
 *   config    — open ~/.blockrun/social-config.json for manual editing
 */

import chalk from 'chalk';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  loadConfig as loadSocialConfig,
  saveConfig as saveSocialConfig,
  isConfigReady,
  CONFIG_PATH,
  type SocialConfig,
} from '../social/config.js';
import { SocialBrowser, SOCIAL_PROFILE_DIR } from '../social/browser.js';
import { runX, type RunResult } from '../social/x.js';
import { getStats } from '../social/db.js';
import { loadChain, API_URLS } from '../config.js';
import { loadConfig as loadAppConfig } from './config.js';

export interface SocialCommandOptions {
  dryRun?: boolean;
  live?: boolean;
  model?: string;
  debug?: boolean;
}

/**
 * Entry point wired from src/index.ts as `franklin social [action] [arg]`.
 */
export async function socialCommand(
  action: string | undefined,
  arg: string | undefined,
  options: SocialCommandOptions
): Promise<void> {
  switch (action) {
    case undefined:
    case 'help':
      printHelp();
      return;
    case 'setup':
      await setupCommand();
      return;
    case 'login':
      await loginCommand(arg);
      return;
    case 'run':
      await runCommand(options);
      return;
    case 'stats':
      statsCommand();
      return;
    case 'config':
      configCommand(arg);
      return;
    default:
      console.log(chalk.red(`Unknown social action: ${action}`));
      printHelp();
      process.exitCode = 1;
  }
}

// ─── help ──────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log('');
  console.log(chalk.bold('  franklin social') + chalk.dim(' — native X bot (no MCP, no plugin deps)'));
  console.log('');
  console.log('  Actions:');
  console.log(`    ${chalk.cyan('setup')}       Install chromium, create default config`);
  console.log(`    ${chalk.cyan('login x')}     Open browser to x.com, save login state`);
  console.log(`    ${chalk.cyan('run')}         Search X, generate + (optionally) post replies`);
  console.log(`                ${chalk.dim('--dry-run  (default) generate drafts, do NOT post')}`);
  console.log(`                ${chalk.dim('--live     actually post to X')}`);
  console.log(`                ${chalk.dim('-m <model> override the AI model')}`);
  console.log(`    ${chalk.cyan('stats')}       Show posted / drafted / skipped totals`);
  console.log(`    ${chalk.cyan('config')}      Print the path to the config file (or pass edit)`);
  console.log('');
  console.log(`  Config:  ${chalk.dim(CONFIG_PATH)}`);
  console.log(`  Profile: ${chalk.dim(SOCIAL_PROFILE_DIR)}`);
  console.log('');
  console.log('  Typical first-run flow:');
  console.log(`    ${chalk.cyan('$')} franklin social setup`);
  console.log(`    ${chalk.cyan('$')} franklin social config edit     ${chalk.dim('# set handle, products, queries')}`);
  console.log(`    ${chalk.cyan('$')} franklin social login x         ${chalk.dim('# log in once; cookies persist')}`);
  console.log(`    ${chalk.cyan('$')} franklin social run             ${chalk.dim('# dry-run, preview drafts')}`);
  console.log(`    ${chalk.cyan('$')} franklin social run --live      ${chalk.dim('# actually post')}`);
  console.log('');
}

// ─── setup ────────────────────────────────────────────────────────────────

async function setupCommand(): Promise<void> {
  console.log(chalk.bold('\n  Franklin social — setup\n'));

  // 1. Install chromium via playwright CLI (ships with playwright-core)
  console.log(chalk.dim('  Installing chromium for the social browser…'));
  console.log(chalk.dim('  (~150MB, one-time download to ~/.cache/ms-playwright)\n'));
  await runChild('npx', ['playwright', 'install', 'chromium']);

  // 2. Ensure profile dir exists
  if (!fs.existsSync(SOCIAL_PROFILE_DIR)) {
    fs.mkdirSync(SOCIAL_PROFILE_DIR, { recursive: true });
    console.log(chalk.green(`  ✓ Created Chrome profile at ${SOCIAL_PROFILE_DIR}`));
  }

  // 3. Write default config if missing
  const config = loadSocialConfig();
  saveSocialConfig(config);  // touches file so the user can edit
  console.log(chalk.green(`  ✓ Config ready at ${CONFIG_PATH}`));

  console.log('');
  console.log(chalk.bold('  Next steps:'));
  console.log(`    1. ${chalk.cyan('franklin social config edit')}    edit handle, products, search queries`);
  console.log(`    2. ${chalk.cyan('franklin social login x')}        log in to x.com (once — cookies persist)`);
  console.log(`    3. ${chalk.cyan('franklin social run')}            dry-run to preview drafts`);
  console.log('');
}

// ─── login ─────────────────────────────────────────────────────────────────

async function loginCommand(platform: string | undefined): Promise<void> {
  if (platform !== 'x') {
    console.log(chalk.red(`Only "x" is supported. Usage: franklin social login x`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold('\n  Opening x.com for login…\n'));
  console.log(chalk.dim('  A Chrome window will open. Log in to your X account,'));
  console.log(chalk.dim('  then close the window when done. Cookies will persist'));
  console.log(chalk.dim(`  at ${SOCIAL_PROFILE_DIR}\n`));

  const browser = new SocialBrowser({ headless: false });
  try {
    await browser.launch();
    await browser.open('https://x.com/login');
    console.log(chalk.yellow('  Waiting for you to log in and close the browser…'));
    await browser.waitForClose();
    console.log(chalk.green('\n  ✓ Browser closed — session state saved.'));
    console.log(chalk.dim(`  Next: franklin social config edit  (then: franklin social run)\n`));
  } catch (err) {
    console.error(chalk.red(`  ✗ ${(err as Error).message}`));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── run ───────────────────────────────────────────────────────────────────

async function runCommand(options: SocialCommandOptions): Promise<void> {
  let config: SocialConfig;
  try {
    config = loadSocialConfig();
  } catch (err) {
    console.error(chalk.red(`  ✗ Config error: ${(err as Error).message}`));
    console.error(chalk.dim(`  Run: franklin social setup`));
    process.exitCode = 1;
    return;
  }

  const ready = isConfigReady(config);
  if (!ready.ready) {
    console.error(chalk.red(`  ✗ Config not ready: ${ready.reason}`));
    console.error(chalk.dim(`  Edit: ${CONFIG_PATH}`));
    process.exitCode = 1;
    return;
  }

  const dryRun = !options.live;  // --live overrides default dry-run
  const mode = dryRun ? 'DRY-RUN' : chalk.bold.red('LIVE');

  console.log('');
  console.log(chalk.bold(`  franklin social run ${chalk.dim(`(${mode})`)}\n`));
  console.log(`  Handle:   ${chalk.cyan(config.handle)}`);
  console.log(`  Products: ${config.products.map((p) => p.name).join(', ')}`);
  console.log(`  Queries:  ${config.x.search_queries.length}`);
  console.log(`  Daily:    ${config.x.daily_target} posts`);
  console.log('');

  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const appConfig = loadAppConfig();
  const model =
    options.model || appConfig['default-model'] || 'nvidia/nemotron-ultra-253b';

  console.log(chalk.dim(`  Model: ${model}`));
  console.log('');

  let result: RunResult;
  try {
    result = await runX({
      config,
      model,
      apiUrl,
      chain,
      dryRun,
      debug: options.debug,
      onProgress: (msg) => process.stdout.write(msg + '\n'),
    });
  } catch (err) {
    console.error(chalk.red(`\n  ✗ Run failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(chalk.bold('  Run summary:'));
  console.log(`    Considered:   ${result.considered}`);
  console.log(`    Dedup skips:  ${chalk.dim(result.dedupSkipped)}`);
  console.log(`    AI SKIPs:     ${chalk.dim(result.llmSkipped)}`);
  console.log(`    Drafted:      ${chalk.green(result.drafted)}`);
  if (!dryRun) {
    console.log(`    Posted:       ${chalk.green.bold(result.posted)}`);
    console.log(`    Failed:       ${result.failed > 0 ? chalk.red(result.failed) : 0}`);
  }
  console.log(`    LLM cost:     ${chalk.yellow('$' + result.totalCost.toFixed(4))}`);
  console.log('');
}

// ─── stats ─────────────────────────────────────────────────────────────────

function statsCommand(): void {
  const s = getStats('x');
  console.log('');
  console.log(chalk.bold('  franklin social stats — X'));
  console.log('');
  console.log(`    Total events:   ${s.total}`);
  console.log(`    ✓ Posted:       ${chalk.green(s.posted)}  ${s.today > 0 ? chalk.dim(`(${s.today} today)`) : ''}`);
  console.log(`    ≡ Drafted:      ${s.drafted}`);
  console.log(`    · Skipped (AI): ${chalk.dim(s.skipped)}`);
  console.log(`    ✗ Failed:       ${s.failed > 0 ? chalk.red(s.failed) : 0}`);
  console.log(`    Total LLM cost: ${chalk.yellow('$' + s.totalCost.toFixed(4))}`);
  if (Object.keys(s.byProduct).length > 0) {
    console.log('');
    console.log('    By product:');
    for (const [name, count] of Object.entries(s.byProduct)) {
      console.log(`      ${name.padEnd(20)} ${count}`);
    }
  }
  console.log('');
}

// ─── config ────────────────────────────────────────────────────────────────

function configCommand(subAction: string | undefined): void {
  if (!subAction || subAction === 'path') {
    console.log(CONFIG_PATH);
    return;
  }
  if (subAction === 'show' || subAction === 'print') {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(chalk.yellow(`  Config not found at ${CONFIG_PATH}`));
      console.log(chalk.dim(`  Run: franklin social setup`));
      return;
    }
    console.log(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return;
  }
  if (subAction === 'edit' || subAction === 'open') {
    if (!fs.existsSync(CONFIG_PATH)) {
      loadSocialConfig();  // writes the default file
    }
    const editor = process.env.EDITOR || (process.platform === 'darwin' ? 'open' : 'vi');
    const args = editor === 'open' ? ['-t', CONFIG_PATH] : [CONFIG_PATH];
    const child = spawn(editor, args, { stdio: 'inherit' });
    child.on('close', () => {
      console.log(chalk.dim(`\n  Saved to ${CONFIG_PATH}`));
    });
    return;
  }
  console.log(chalk.red(`  Unknown config subaction: ${subAction}`));
  console.log(chalk.dim(`  Try: path, show, edit`));
}

// ─── helpers ───────────────────────────────────────────────────────────────

function runChild(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
