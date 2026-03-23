import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { getOrCreateWallet, getOrCreateSolanaWallet } from '@blockrun/llm';
import { createProxy } from '../proxy/server.js';
import { loadChain, API_URLS, DEFAULT_PROXY_PORT } from '../config.js';

interface StartOptions {
  port?: string;
  launch?: boolean;
}

export async function startCommand(options: StartOptions) {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];

  if (chain === 'solana') {
    const wallet = await getOrCreateSolanaWallet();
    if (wallet.isNew) {
      console.log(
        chalk.yellow('No Solana wallet found — created a new one.')
      );
      console.log(`Address: ${chalk.cyan(wallet.address)}`);
      console.log(
        `\nSend USDC on Solana to this address, then run ${chalk.bold('brcc start')} again.\n`
      );
      return;
    }

    const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
    const shouldLaunch = options.launch !== false;

    console.log(chalk.bold('brcc — BlockRun Claude Code\n'));
    console.log(`Chain:   ${chalk.magenta('solana')}`);
    console.log(`Wallet:  ${chalk.cyan(wallet.address)}`);
    console.log(`Proxy:   ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`Backend: ${chalk.dim(apiUrl)}\n`);

    const server = createProxy({ port, apiUrl, chain: 'solana' });
    launchServer(server, port, shouldLaunch);
  } else {
    const wallet = getOrCreateWallet();
    if (wallet.isNew) {
      console.log(chalk.yellow('No wallet found — created a new one.'));
      console.log(`Address: ${chalk.cyan(wallet.address)}`);
      console.log(
        `\nSend USDC on Base to this address, then run ${chalk.bold('brcc start')} again.\n`
      );
      return;
    }

    const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
    const shouldLaunch = options.launch !== false;

    console.log(chalk.bold('brcc — BlockRun Claude Code\n'));
    console.log(`Chain:   ${chalk.magenta('base')}`);
    console.log(`Wallet:  ${chalk.cyan(wallet.address)}`);
    console.log(`Proxy:   ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log(`Backend: ${chalk.dim(apiUrl)}\n`);

    const server = createProxy({ port, apiUrl, chain: 'base' });
    launchServer(server, port, shouldLaunch);
  }
}

function launchServer(
  server: ReturnType<typeof createProxy>,
  port: number,
  shouldLaunch: boolean
) {
  server.listen(port, () => {
    console.log(chalk.green(`Proxy running on port ${port}\n`));

    if (shouldLaunch) {
      console.log('Starting Claude Code...\n');

      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDE_ACCESS_TOKEN;
      delete cleanEnv.CLAUDE_OAUTH_TOKEN;

      const claude = spawn('claude', ['--api-key-auth'], {
        stdio: 'inherit',
        env: {
          ...cleanEnv,
          ANTHROPIC_BASE_URL: `http://localhost:${port}/api`,
          ANTHROPIC_API_KEY: 'sk-ant-api03-brcc-proxy-00000000000000000000000000000000000000000000-00000000000000',
        },
      });

      claude.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log(
            chalk.red('\nClaude Code not found. Install it first:')
          );
          console.log(
            chalk.dim('  npm install -g @anthropic-ai/claude-code')
          );
        } else {
          console.error('Failed to start Claude Code:', err.message);
        }
        server.close();
        process.exit(1);
      });

      claude.on('exit', (code) => {
        server.close();
        process.exit(code ?? 0);
      });
    } else {
      console.log('Proxy-only mode. Set this in your shell:\n');
      console.log(
        chalk.bold(
          `  export ANTHROPIC_BASE_URL=http://localhost:${port}/api`
        )
      );
      console.log(chalk.bold(`  export ANTHROPIC_API_KEY=sk-ant-api03-brcc-proxy-00000000000000000000000000000000000000000000-00000000000000`));
      console.log(
        `\nThen run ${chalk.bold('claude')} in another terminal.`
      );
    }
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close();
    process.exit(0);
  });
}
