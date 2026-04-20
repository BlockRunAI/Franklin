/**
 * `franklin telegram` — start the Telegram ingress bot.
 *
 * Designed to run on a server / always-on laptop. Reads the bot token and
 * owner id from env (or falls back to ~/.blockrun/config). Uses trust-mode
 * permissions because the operator is remote — there's no terminal prompt
 * they can answer per tool call. The owner lock in `runTelegramBot` is the
 * real security boundary.
 */

import chalk from 'chalk';
import { loadChain, API_URLS } from '../config.js';
import { assembleInstructions } from '../agent/context.js';
import { allCapabilities } from '../tools/index.js';
import { loadConfig } from './config.js';
import { runTelegramBot } from '../channel/telegram.js';
import { findLatestSessionByChannel } from '../session/storage.js';
import type { AgentConfig } from '../agent/types.js';

interface TelegramCommandOptions {
  model?: string;
  debug?: boolean;
}

export async function telegramCommand(opts: TelegramCommandOptions): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerRaw = process.env.TELEGRAM_OWNER_ID;

  if (!token || !ownerRaw) {
    console.error(chalk.red('Missing Telegram config.'));
    console.error(chalk.dim(
      '\nSet two env vars before running `franklin telegram`:\n' +
      '  TELEGRAM_BOT_TOKEN=<from @BotFather>\n' +
      '  TELEGRAM_OWNER_ID=<your numeric Telegram user id>\n\n' +
      'Tip: message @userinfobot on Telegram to get your user id.',
    ));
    process.exit(1);
  }

  const ownerId = parseInt(ownerRaw, 10);
  if (!Number.isFinite(ownerId) || ownerId <= 0) {
    console.error(chalk.red(`TELEGRAM_OWNER_ID must be a positive integer, got: ${ownerRaw}`));
    process.exit(1);
  }

  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const config = loadConfig();

  // Model: --model flag > config default > free default.
  const model =
    opts.model ||
    config['default-model'] ||
    'nvidia/nemotron-ultra-253b';

  const workingDir = process.cwd();
  const systemInstructions = assembleInstructions(workingDir, model);

  // Resume the most recent session tagged for THIS owner so a process
  // restart doesn't drop the conversation. First run has no prior session
  // and starts fresh. `/new` will lay down a new session ID within the
  // running process; the next restart picks up the newest one again.
  const channelTag = `telegram:${ownerId}`;
  const prior = findLatestSessionByChannel(channelTag);
  if (prior) {
    console.log(chalk.dim(
      `  resuming session ${prior.id} (${prior.messageCount} msgs, ` +
      `last update ${new Date(prior.updatedAt).toLocaleString()})`,
    ));
  }

  const agentConfig: AgentConfig = {
    model,
    apiUrl,
    chain,
    systemInstructions,
    capabilities: allCapabilities,
    workingDir,
    // No interactive terminal for permission prompts — remote operator can't
    // answer y/n per tool. The Telegram owner lock is the security boundary.
    permissionMode: 'trust',
    debug: opts.debug,
    sessionChannel: channelTag,
    resumeSessionId: prior?.id,
  };

  console.log(chalk.bold.cyan('Franklin Telegram bot'));
  console.log(chalk.dim(`  chain: ${chain}`));
  console.log(chalk.dim(`  model: ${model}`));
  console.log(chalk.dim(`  owner: ${ownerId}`));
  console.log(chalk.yellow(
    '  permission mode: trust — every tool the model picks will execute ' +
    'without confirmation. The owner lock is your only gate.\n',
  ));

  // SIGINT → stop the bot cleanly. Wrap runTelegramBot so a second Ctrl-C
  // force-exits if the cleanup path hangs.
  let exitAttempts = 0;
  process.on('SIGINT', () => {
    exitAttempts++;
    if (exitAttempts === 1) {
      console.log(chalk.dim('\nStopping… (press Ctrl-C again to force)'));
    } else {
      process.exit(130);
    }
  });

  try {
    await runTelegramBot(agentConfig, {
      token,
      ownerId,
      log: (line) => console.log(chalk.dim(line)),
    });
  } catch (err) {
    console.error(chalk.red(`Telegram bot failed: ${(err as Error).message}`));
    process.exit(1);
  }
}
