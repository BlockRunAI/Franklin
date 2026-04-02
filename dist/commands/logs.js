import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';
const LOG_FILE = path.join(BLOCKRUN_DIR, '0xcode-debug.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB auto-rotate threshold
export function logsCommand(options) {
    if (options.clear) {
        try {
            fs.unlinkSync(LOG_FILE);
            console.log(chalk.green('Logs cleared.'));
        }
        catch {
            console.log(chalk.dim('No log file to clear.'));
        }
        return;
    }
    if (!fs.existsSync(LOG_FILE)) {
        console.log(chalk.dim('No logs yet. Start 0xcode with --debug to enable logging:'));
        console.log(chalk.bold('  0xcode start --debug'));
        return;
    }
    // Auto-rotate: if file is over threshold, keep only last half
    try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_LOG_SIZE) {
            const content = fs.readFileSync(LOG_FILE, 'utf-8');
            const lines = content.split('\n');
            const half = lines.slice(Math.floor(lines.length / 2));
            fs.writeFileSync(LOG_FILE, half.join('\n'));
            console.log(chalk.dim(`(Rotated log — was ${(stat.size / 1024 / 1024).toFixed(1)}MB)`));
        }
    }
    catch { /* ignore rotation errors */ }
    const tailLines = parseInt(options.lines || '50', 10);
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
                }
                else if (stat.size < lastSize) {
                    // File was rotated/cleared
                    lastSize = 0;
                }
            }
            catch {
                /* file may have been deleted */
            }
        }, 500);
        process.on('SIGINT', () => {
            clearInterval(watcher);
            process.exit(0);
        });
    }
    else {
        printLastLines(tailLines);
    }
}
function printLastLines(n) {
    try {
        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        const start = Math.max(0, lines.length - n);
        const slice = lines.slice(start);
        if (start > 0) {
            console.log(chalk.dim(`... (${start} earlier entries, use --lines to see more)`));
        }
        for (const line of slice) {
            // Colorize timestamps
            const colored = line.replace(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/, chalk.dim('[$1]'));
            console.log(colored);
        }
    }
    catch {
        console.log(chalk.dim('Could not read log file.'));
    }
}
