/**
 * franklin panel — launch the local web dashboard.
 */

import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { createPanelServer } from '../panel/server.js';
import { BLOCKRUN_DIR } from '../config.js';

export async function panelCommand(options: { port?: string }): Promise<void> {
  const requestedPort = parseInt(options.port || '3100', 10);

  // Handle port-in-use by trying up to 20 subsequent ports silently.
  // Only log when we finally bind (or fail completely) — no per-attempt spam.
  const MAX_ATTEMPTS = 20;
  const tryListen = (port: number, attempt: number): void => {
    const server = createPanelServer(port);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
        tryListen(port + 1, attempt + 1);
        return;
      }
      console.error(chalk.red(`\n  Panel failed to start: ${err.message}`));
      if (err.code === 'EADDRINUSE') {
        console.error(chalk.dim(`  All ports from ${requestedPort} to ${requestedPort + MAX_ATTEMPTS - 1} are busy.`));
        console.error(chalk.dim(`  Try: franklin panel --port 4000`));
      }
      process.exit(1);
    });

    // Bind to loopback only — the panel exposes wallet secrets on /api/wallet/secret
    // and a write-capable /api/wallet/import. Never expose these on a LAN.
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      // Mirror what start.ts does for the auto-panel — persist the bound
      // URL so any concurrent `franklin start` agent can read /#wallet
      // off the same file. Without this, a user who disables panel
      // autostart and runs `franklin panel` separately would still get
      // the hardcoded 3100 default in the agent prompt.
      try {
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        fs.writeFileSync(path.join(BLOCKRUN_DIR, 'panel-url'), url, 'utf8');
      } catch { /* best-effort */ }

      console.log('');
      console.log(chalk.bold('  Franklin Panel'));
      console.log(chalk.dim(`  ${url}`) +
        (port !== requestedPort ? chalk.yellow(`  (fell back from ${requestedPort})`) : ''));
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop.'));
      console.log('');

      // Try to open browser
      const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      import('node:child_process').then(({ exec }) => {
        exec(`${open} ${url}`);
      }).catch(() => {});
    });

    // Graceful shutdown
    const shutdown = () => {
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };

  // Catch unexpected crashes with a useful message rather than a stack trace
  process.on('uncaughtException', (err) => {
    console.error(chalk.red(`\n  Panel crashed: ${err.message}`));
    console.error(chalk.dim('  Open an issue: https://github.com/BlockRunAI/Franklin/issues'));
    process.exit(1);
  });

  tryListen(requestedPort, 0);
}
