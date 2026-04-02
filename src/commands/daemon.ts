import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { BLOCKRUN_DIR, DEFAULT_PROXY_PORT } from '../config.js';

const PID_FILE = path.join(BLOCKRUN_DIR, 'runcode.pid');
const LOG_FILE = path.join(BLOCKRUN_DIR, 'runcode-debug.log');

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function daemonCommand(action: string, options: { port?: string }) {
  const port = parseInt(options.port || String(DEFAULT_PROXY_PORT));

  switch (action) {
    case 'start': {
      const existing = readPid();
      if (existing && isRunning(existing)) {
        console.log(chalk.yellow(`runcode daemon already running (PID ${existing})`));
        console.log(chalk.dim(`  Proxy: http://localhost:${port}/api`));
        return;
      }

      // Find runcode binary
      let runcodeBin: string;
      try {
        runcodeBin = execSync('which runcode', { encoding: 'utf-8' }).trim();
      } catch {
        console.log(chalk.red('runcode binary not found in PATH.'));
        return;
      }

      fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });

      const child = spawn(runcodeBin, ['proxy', '--port', String(port)], {
        detached: true,
        stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')],
      });
      child.unref();

      fs.writeFileSync(PID_FILE, String(child.pid));
      console.log(chalk.green(`✓ runcode daemon started (PID ${child.pid})`));
      console.log(chalk.dim(`  Proxy: http://localhost:${port}/api`));
      console.log(chalk.dim(`  Logs:  ${LOG_FILE}`));
      break;
    }

    case 'stop': {
      const pid = readPid();
      if (!pid) {
        console.log(chalk.yellow('No runcode daemon found.'));
        return;
      }
      if (!isRunning(pid)) {
        fs.unlinkSync(PID_FILE);
        console.log(chalk.yellow(`Daemon PID ${pid} not running — cleaned up.`));
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(PID_FILE);
        console.log(chalk.green(`✓ runcode daemon stopped (PID ${pid})`));
      } catch (e) {
        console.log(chalk.red(`Failed to stop daemon: ${(e as Error).message}`));
      }
      break;
    }

    case 'status': {
      const pid = readPid();
      if (!pid) {
        console.log(chalk.dim('runcode daemon: not running'));
        return;
      }
      if (isRunning(pid)) {
        console.log(chalk.green(`✓ runcode daemon running`));
        console.log(`  PID:   ${chalk.bold(pid)}`);
        console.log(`  Proxy: ${chalk.cyan(`http://localhost:${port}/api`)}`);
        console.log(chalk.dim(`  Logs:  ${LOG_FILE}`));
      } else {
        fs.unlinkSync(PID_FILE);
        console.log(chalk.yellow('runcode daemon: not running (stale PID cleaned up)'));
      }
      break;
    }

    default:
      console.log(chalk.red(`Unknown daemon action: ${action}`));
      console.log('Usage: runcode daemon <start|stop|status>');
  }
}
