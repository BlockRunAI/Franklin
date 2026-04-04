/**
 * Proxy-only mode — runs the BlockRun payment proxy for other tools (e.g. Claude Code).
 * The proxy translates requests and handles x402 payments so Claude Code can use any model.
 */

import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { createProxy } from '../proxy/server.js';
import { loadChain, API_URLS, DEFAULT_PROXY_PORT } from '../config.js';
import { loadConfig } from './config.js';
import { printBanner } from '../banner.js';

interface ProxyOptions {
  port?: string;
  model?: string;
  fallback?: boolean;
  debug?: boolean;
  version?: string;
}

export async function proxyCommand(options: ProxyOptions) {
  const version = options.version ?? '1.0.0';
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const fallbackEnabled = options.fallback !== false;
  const config = loadConfig();

  const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
  if (isNaN(port) || port < 1 || port > 65535) {
    console.log(chalk.red(`Invalid port: ${options.port}. Must be 1-65535.`));
    process.exit(1);
  }

  const model = options.model || config['default-model'];

  if (chain === 'solana') {
    const wallet = await getOrCreateSolanaWallet();
    if (wallet.isNew) {
      console.log(chalk.yellow('No Solana wallet found — created a new one.'));
      console.log(`Address: ${chalk.cyan(wallet.address)}`);
      console.log(
        `\nSend USDC on Solana to this address, then run ${chalk.bold('runcode proxy')} again.\n`
      );
      return;
    }

    printBanner(version);
    console.log(`Mode:     ${chalk.bold('proxy')}`);
    console.log(`Chain:    ${chalk.magenta('solana')}`);
    console.log(`Wallet:   ${chalk.cyan(wallet.address)}`);
    if (model) console.log(`Model:    ${chalk.green(model)}`);
    console.log(`Fallback: ${fallbackEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
    console.log(`Proxy:    ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`Backend:  ${chalk.dim(apiUrl)}\n`);

    const server = createProxy({
      port,
      apiUrl,
      chain: 'solana',
      modelOverride: model,
      debug: options.debug,
      fallbackEnabled,
    });
    launchProxy(server, port, options.debug);
  } else {
    const wallet = getOrCreateWallet();
    if (wallet.isNew) {
      console.log(chalk.yellow('No wallet found — created a new one.'));
      console.log(`Address: ${chalk.cyan(wallet.address)}`);
      console.log(
        `\nSend USDC on Base to this address, then run ${chalk.bold('runcode proxy')} again.\n`
      );
      return;
    }

    printBanner(version);
    console.log(`Mode:     ${chalk.bold('proxy')}`);
    console.log(`Chain:    ${chalk.magenta('base')}`);
    console.log(`Wallet:   ${chalk.cyan(wallet.address)}`);
    if (model) console.log(`Model:    ${chalk.green(model)}`);
    console.log(`Fallback: ${fallbackEnabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
    console.log(`Proxy:    ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`Backend:  ${chalk.dim(apiUrl)}\n`);

    const server = createProxy({
      port,
      apiUrl,
      chain: 'base',
      modelOverride: model,
      debug: options.debug,
      fallbackEnabled,
    });
    launchProxy(server, port, options.debug);
  }
}

function launchProxy(
  server: ReturnType<typeof createProxy>,
  port: number,
  debug?: boolean
) {
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`Port ${port} is already in use. Try a different port with --port.`));
    } else {
      console.error(chalk.red(`Server error: ${err.message}`));
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(chalk.green(`✓ Proxy running on port ${port}`));
    console.log(chalk.dim(`  Usage tracking: ~/.blockrun/runcode-stats.json`));
    if (debug) console.log(chalk.dim(`  Debug log:      ~/.blockrun/runcode-debug.log`));
    console.log(chalk.dim(`  Run 'runcode stats' to view statistics\n`));

    console.log('Set this in your shell to use with Claude Code:\n');
    console.log(
      chalk.bold(`  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`)
    );
    console.log(
      chalk.bold(`  export ANTHROPIC_AUTH_TOKEN=x402-proxy-handles-auth`)
    );
    console.log(`\nThen run ${chalk.bold('claude')} in another terminal.`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
