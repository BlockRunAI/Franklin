import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';

const LOG_FILE = path.join(BLOCKRUN_DIR, 'franklin-debug.log');
const ARCHIVE_LOG_FILE = path.join(BLOCKRUN_DIR, 'franklin-debug.log.1');
const LEGACY_LOG_FILE = path.join(BLOCKRUN_DIR, 'runcode-debug.log');

export function logsCommand(options: {
  follow?: boolean;
  lines?: string;
  clear?: boolean;
}) {
  if (options.clear) {
    let cleared = false;
    try { fs.unlinkSync(LOG_FILE); cleared = true; } catch { /* may not exist */ }
    try { fs.unlinkSync(ARCHIVE_LOG_FILE); cleared = true; } catch { /* may not exist */ }
    if (cleared) console.log(chalk.green('Logs cleared.'));
    else console.log(chalk.dim('No log file to clear.'));
    return;
  }

  // Migrate legacy log file
  if (!fs.existsSync(LOG_FILE) && fs.existsSync(LEGACY_LOG_FILE)) {
    try { fs.renameSync(LEGACY_LOG_FILE, LOG_FILE); } catch { /* best effort */ }
  }

  // Logger now self-rotates on write (in src/logger.ts). The previous
  // in-place "slice off the first half" rotation here was destructive
  // — every invocation that crossed 10 MB silently dropped half the
  // history. With self-rotation in place this command no longer needs
  // to mutate the file at all; it just stitches the archive + live
  // log for display.

  if (!fs.existsSync(LOG_FILE) && !fs.existsSync(ARCHIVE_LOG_FILE)) {
    console.log(chalk.dim('No logs yet. Start franklin with --debug to enable logging:'));
    console.log(chalk.bold('  franklin start --debug'));
    return;
  }

  const parsed = parseInt(options.lines || '50', 10);
  const tailLines = isNaN(parsed) ? 50 : Math.max(1, Math.min(10000, parsed));

  if (options.follow) {
    // Tail -f mode: print last N lines then watch for changes
    printLastLines(tailLines);
    console.log(chalk.dim('--- watching for new entries (ctrl+c to stop) ---'));

    let lastSize = fs.statSync(LOG_FILE).size;
    const watcher = setInterval(() => {
      try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > lastSize) {
          const fd = fs.openSync(LOG_FILE, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          process.stdout.write(buf.toString('utf-8'));
          lastSize = stat.size;
        } else if (stat.size < lastSize) {
          // File was rotated/cleared
          lastSize = 0;
        }
      } catch {
        /* file may have been deleted */
      }
    }, 500);

    process.on('SIGINT', () => {
      clearInterval(watcher);
      process.exit(0);
    });
  } else {
    printLastLines(tailLines);
  }
}

function printLastLines(n: number) {
  try {
    // Logger self-rotates to franklin-debug.log.1 when the live log
    // crosses 10MB. Stitch the archive on first so requests for "last N"
    // can span the rotation boundary — without this, immediately after
    // a rotation `franklin logs --lines 1000` would show only whatever
    // lines have been written since rotation, even though the archive
    // is sitting right next to it.
    const archive = fs.existsSync(ARCHIVE_LOG_FILE) ? fs.readFileSync(ARCHIVE_LOG_FILE, 'utf-8') : '';
    const live = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf-8') : '';
    const lines = (archive + live).split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - n);
    const slice = lines.slice(start);

    if (start > 0) {
      console.log(chalk.dim(`... (${start} earlier entries, use --lines to see more)`));
    }

    for (const line of slice) {
      // Colorize timestamps
      const colored = line.replace(
        /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/,
        chalk.dim('[$1]')
      );
      console.log(colored);
    }
  } catch {
    console.log(chalk.dim('Could not read log file.'));
  }
}
