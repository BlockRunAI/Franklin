import { spawn } from 'node:child_process';
import chalk from 'chalk';
import {
  walletExists,
  loadWallet,
  getPublicKey,
} from '../wallet/manager.js';
import { createProxy } from '../proxy/server.js';
import { DEFAULT_API_URL, DEFAULT_PROXY_PORT } from '../config.js';

interface StartOptions {
  port?: string;
  launch?: boolean;
}

export async function startCommand(options: StartOptions) {
  if (!(await walletExists())) {
    console.log(chalk.red('No wallet found. Run `brcc setup` first.'));
    process.exit(1);
  }

  const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));
  const shouldLaunch = options.launch !== false;
  const keypair = await loadWallet();
  const pubkey = await getPublicKey();

  console.log(chalk.bold('brcc — BlockRun Claude Code\n'));
  console.log(`Wallet:  ${chalk.cyan(pubkey)}`);
  console.log(`Proxy:   ${chalk.cyan(`http://localhost:${port}`)}`);
  console.log(`Backend: ${chalk.dim(DEFAULT_API_URL)}\n`);

  const server = createProxy({ port, keypair, apiUrl: DEFAULT_API_URL });

  server.listen(port, () => {
    console.log(chalk.green(`Proxy running on port ${port}\n`));

    if (shouldLaunch) {
      console.log('Starting Claude Code...\n');

      const claude = spawn('claude', [], {
        stdio: 'inherit',
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://localhost:${port}/api`,
          ANTHROPIC_API_KEY: 'brcc',
        },
      });

      claude.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log(chalk.red('\nClaude Code not found. Install it first:'));
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
      console.log(chalk.bold(`  export ANTHROPIC_API_KEY=brcc`));
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
