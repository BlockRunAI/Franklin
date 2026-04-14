/**
 * franklin panel — launch the local web dashboard.
 */

import chalk from 'chalk';
import { createPanelServer } from '../panel/server.js';

export async function panelCommand(options: { port?: string }): Promise<void> {
  const requestedPort = parseInt(options.port || '3100', 10);

  // Handle port-in-use by trying up to 10 subsequent ports.
  const tryListen = (port: number, attempt: number): void => {
    const server = createPanelServer(port);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        console.log(chalk.yellow(`  Port ${port} busy — trying ${port + 1}...`));
        tryListen(port + 1, attempt + 1);
        return;
      }
      console.error(chalk.red(`\n  Panel failed to start: ${err.message}`));
      if (err.code === 'EADDRINUSE') {
        console.error(chalk.dim(`  All ports from ${requestedPort} to ${requestedPort + 9} are busy.`));
        console.error(chalk.dim(`  Try: franklin panel --port 4000`));
      }
      process.exit(1);
    });

    server.listen(port, () => {
      console.log('');
      console.log(chalk.bold('  Franklin Panel'));
      console.log(chalk.dim(`  http://localhost:${port}`));
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop.'));
      console.log('');

      // Try to open browser
      const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      import('node:child_process').then(({ exec }) => {
        exec(`${open} http://localhost:${port}`);
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
