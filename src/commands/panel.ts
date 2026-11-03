/**
 * franklin panel — launch the local web dashboard.
 */

import chalk from 'chalk';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createPanelServer, writePanelUrlFile, PANEL_URL_FILE } from '../panel/server.js';

/**
 * Open a URL in the default browser without going through a shell: the URL
 * carries the panel token and `?`/`#`, which a shell would glob or cut.
 */
export function openInBrowser(url: string): void {
  const onError = () => { /* headless box: the terminal still shows the link */ };
  if (process.platform === 'darwin') execFile('open', [url], onError);
  else if (process.platform === 'win32') {
    // `start` treats its first quoted argument as a window title.
    execFile('cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }, onError);
  } else execFile('xdg-open', [url], onError);
}

/**
 * `franklin panel --open [section]`: open the panel that is already running
 * (started by `franklin` or `franklin panel`) at an optional #section. The
 * agent uses this for the wallet page, so the token never enters a prompt
 * or a transcript: nothing here prints the token-bearing URL.
 */
async function openRunningPanel(section: string): Promise<void> {
  if (section && !/^[a-z0-9-]+$/i.test(section)) {
    console.error(chalk.red(`  Unknown panel section: ${section}`));
    process.exit(1);
  }
  let launch = '';
  try { launch = fs.readFileSync(PANEL_URL_FILE, 'utf8').trim(); } catch { /* none */ }
  let alive = false;
  if (/^http:\/\/localhost:\d+\/\?token=[0-9a-f]{64}$/.test(launch)) {
    try {
      const res = await fetch(launch, { signal: AbortSignal.timeout(1500) });
      alive = res.status === 200; // 401 means a different panel process owns the port now
      await res.body?.cancel();
    } catch { alive = false; }
  }
  if (!alive) {
    console.error(chalk.yellow('  No running Franklin panel found. Start one with: franklin panel'));
    process.exit(1);
  }
  openInBrowser(section ? `${launch}#${section}` : launch);
  const port = new URL(launch).port;
  console.log(`  Opened the Franklin panel${section ? ` (${section})` : ''} on localhost:${port}.`);
}

export async function panelCommand(options: { port?: string; open?: string | boolean }): Promise<void> {
  if (options.open !== undefined) {
    await openRunningPanel(typeof options.open === 'string' ? options.open : '');
    return;
  }
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
      // Persist the launch URL (0600) so `franklin panel --open wallet`,
      // which the agent runs for funding, finds this panel's port and token.
      const url = writePanelUrlFile(port);

      console.log('');
      console.log(chalk.bold('  Franklin Panel'));
      console.log(chalk.dim(`  ${url}`) +
        (port !== requestedPort ? chalk.yellow(`  (fell back from ${requestedPort})`) : ''));
      console.log('');
      console.log(chalk.dim('  Press Ctrl+C to stop.'));
      console.log('');

      openInBrowser(url);
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
