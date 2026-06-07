/**
 * `franklin slack` — start the Slack ingress bot.
 *
 * Designed to run on a server / always-on laptop. Reads the bot token, app
 * token, and the user allowlist from env (or ~/.blockrun/config). Uses
 * trust-mode permissions because the operator is remote — there's no terminal
 * prompt they can answer per tool call. The `SLACK_ALLOWED_USERS` allowlist in
 * `runSlackBot` is the real security boundary, mirroring Telegram's owner lock.
 */

import chalk from 'chalk';
import { loadChain, API_URLS } from '../config.js';
import { assembleInstructions } from '../agent/context.js';
import { allCapabilities } from '../tools/index.js';
import { loadMcpConfig } from '../mcp/config.js';
import { connectMcpServers, disconnectMcpServers } from '../mcp/client.js';
import { loadConfig } from './config.js';
import { runSlackBot } from '../channel/slack.js';
import { findLatestSessionByChannel } from '../session/storage.js';
import type { AgentConfig } from '../agent/types.js';

interface SlackCommandOptions {
  model?: string;
  debug?: boolean;
}

export async function slackCommand(opts: SlackCommandOptions): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const allowedRaw = process.env.SLACK_ALLOWED_USERS;

  if (!botToken || !appToken || !allowedRaw) {
    console.error(chalk.red('Missing Slack config.'));
    console.error(chalk.dim(
      '\nSet three env vars before running `franklin slack`:\n' +
      '  SLACK_BOT_TOKEN=<xoxb-… Bot User OAuth token>\n' +
      '  SLACK_APP_TOKEN=<xapp-… app-level token with connections:write>\n' +
      '  SLACK_ALLOWED_USERS=<comma-separated Slack user ids, e.g. U01ABC,U02DEF>\n\n' +
      'Socket Mode must be enabled on the app, and the bot must be invited to\n' +
      'the channel (/invite @your-bot). Find a user id via their profile →\n' +
      '⋮ → Copy member ID.',
    ));
    process.exit(1);
  }

  const allowedUsers = new Set(
    allowedRaw.split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (allowedUsers.size === 0) {
    console.error(chalk.red('SLACK_ALLOWED_USERS is empty — that would deny everyone.'));
    process.exit(1);
  }

  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const config = loadConfig();

  const model =
    opts.model ||
    config['default-model'] ||
    'nvidia/qwen3-coder-480b';

  const workingDir = process.cwd();
  const systemInstructions = assembleInstructions(workingDir, model);

  // Connect MCP servers (Notion, etc.) so the bot exposes their tools — mirrors
  // what `franklin start` does. Without this the bot only has built-in tools.
  const mcpConfig = loadMcpConfig(workingDir);
  let mcpTools: typeof allCapabilities = [];
  const mcpServerCount = Object.keys(mcpConfig.mcpServers).filter(
    (k) => !mcpConfig.mcpServers[k].disabled,
  ).length;
  if (mcpServerCount > 0) {
    try {
      mcpTools = await connectMcpServers(mcpConfig, opts.debug);
      if (mcpTools.length > 0) {
        console.log(chalk.dim(`  MCP:    ${mcpTools.length} tools from ${mcpServerCount} server(s)`));
      }
    } catch (err) {
      console.error(chalk.yellow(`  MCP error: ${(err as Error).message}`));
    }
  }

  // Resume the most recent session tagged for THIS workspace bot so a process
  // restart doesn't drop the conversation. MVP v1 keeps one shared session per
  // bot (see channel/slack.ts), so the channel tag is workspace-scoped.
  const channelTag = 'slack:shared';
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
    capabilities: [...allCapabilities, ...mcpTools],
    workingDir,
    // No interactive terminal for permission prompts — remote operator can't
    // answer y/n per tool. The Slack allowlist is the security boundary.
    permissionMode: 'trust',
    debug: opts.debug,
    sessionChannel: channelTag,
    resumeSessionId: prior?.id,
  };

  console.log(chalk.bold.cyan('Franklin Slack bot'));
  console.log(chalk.dim(`  chain: ${chain}`));
  console.log(chalk.dim(`  model: ${model}`));
  console.log(chalk.dim(`  allowed users: ${allowedUsers.size}`));
  console.log(chalk.yellow(
    '  permission mode: trust — every tool the model picks will execute ' +
    'without confirmation. The allowlist is your only gate.\n',
  ));

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
    await runSlackBot(agentConfig, {
      botToken,
      appToken,
      allowedUsers,
      debug: opts.debug,
      log: (line) => console.log(chalk.dim(line)),
    });
  } catch (err) {
    console.error(chalk.red(`Slack bot failed: ${(err as Error).message}`));
    process.exit(1);
  } finally {
    disconnectMcpServers().catch(() => {});
  }
}
