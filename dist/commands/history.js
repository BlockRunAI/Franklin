import chalk from 'chalk';
import { loadStats } from '../stats/tracker.js';
export function historyCommand(options) {
    const { history } = loadStats();
    const limit = Math.min(parseInt(options.n || '20', 10), history.length);
    console.log(chalk.bold(`
📜 Last ${limit} Requests\n`));
    console.log('─'.repeat(55));
    if (history.length === 0) {
        console.log(chalk.gray('\n  No history recorded yet.\n'));
        console.log('─'.repeat(55) + '\n');
        return;
    }
    const recent = history.slice(-limit).reverse();
    for (const record of recent) {
        const time = new Date(record.timestamp).toLocaleString();
        const model = record.model.split('/').pop() || record.model;
        const cost = '$' + record.costUsd.toFixed(5);
        const tokens = `${record.inputTokens}+${record.outputTokens}`.padEnd(10);
        const latency = `${record.latencyMs}ms`.padEnd(8);
        const fallbackMark = record.fallback ? chalk.yellow(' ↺') : '';
        console.log(chalk.gray(`[${time}]`) +
            ` ${model.padEnd(20)}${fallbackMark} ` +
            chalk.cyan(tokens) +
            chalk.magenta(latency) +
            chalk.green(cost));
    }
    console.log('\n' + '─'.repeat(55));
    console.log(chalk.gray(`  Showing ${limit} of ${history.length} total records.`));
    console.log(chalk.gray('  Run `runcode stats` for more detailed statistics.\n'));
}
