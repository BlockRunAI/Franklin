/**
 * runcode stats command
 * Display usage statistics and cost savings
 */
import chalk from 'chalk';
import { clearStats, getStatsSummary } from '../stats/tracker.js';
export function statsCommand(options) {
    if (options.clear) {
        clearStats();
        console.log(chalk.green('✓ Statistics cleared'));
        return;
    }
    const { stats, opusCost, saved, savedPct, avgCostPerRequest, period } = getStatsSummary();
    // JSON output for programmatic access
    if (options.json) {
        console.log(JSON.stringify({
            ...stats,
            computed: {
                opusCost,
                saved,
                savedPct,
                avgCostPerRequest,
                period,
            },
        }, null, 2));
        return;
    }
    // Pretty output
    console.log(chalk.bold('\n📊 runcode Usage Statistics\n'));
    console.log('─'.repeat(55));
    if (stats.totalRequests === 0) {
        console.log(chalk.gray('\n  No requests recorded yet. Start using runcode!\n'));
        console.log('─'.repeat(55) + '\n');
        return;
    }
    // Overview
    console.log(chalk.bold('\n  Overview') + chalk.gray(` (${period})\n`));
    console.log(`    Requests:       ${chalk.cyan(stats.totalRequests.toLocaleString())}`);
    console.log(`    Total Cost:     ${chalk.green('$' + stats.totalCostUsd.toFixed(4))}`);
    console.log(`    Avg per Request:${chalk.gray(' $' + avgCostPerRequest.toFixed(6))}`);
    console.log(`    Input Tokens:   ${stats.totalInputTokens.toLocaleString()}`);
    console.log(`    Output Tokens:  ${stats.totalOutputTokens.toLocaleString()}`);
    if (stats.totalFallbacks > 0) {
        const fallbackPct = ((stats.totalFallbacks / stats.totalRequests) *
            100).toFixed(1);
        console.log(`    Fallbacks:      ${chalk.yellow(stats.totalFallbacks.toString())} (${fallbackPct}%)`);
    }
    // Per-model breakdown
    const modelEntries = Object.entries(stats.byModel);
    if (modelEntries.length > 0) {
        console.log(chalk.bold('\n  By Model\n'));
        // Sort by cost (descending)
        const sorted = modelEntries.sort((a, b) => b[1].costUsd - a[1].costUsd);
        for (const [model, data] of sorted) {
            const pct = stats.totalCostUsd > 0
                ? ((data.costUsd / stats.totalCostUsd) * 100).toFixed(1)
                : '0';
            const avgLatency = Math.round(data.avgLatencyMs);
            // Shorten model name if too long
            const displayModel = model.length > 35 ? model.slice(0, 32) + '...' : model;
            console.log(`    ${chalk.cyan(displayModel)}`);
            console.log(chalk.gray(`      ${data.requests} req · $${data.costUsd.toFixed(4)} (${pct}%) · ${avgLatency}ms avg`));
            if (data.fallbackCount > 0) {
                console.log(chalk.yellow(`      ↳ ${data.fallbackCount} fallback recoveries`));
            }
        }
    }
    // Savings comparison
    console.log(chalk.bold('\n  💰 Savings vs Claude Opus\n'));
    if (opusCost > 0) {
        console.log(`    Opus equivalent: ${chalk.gray('$' + opusCost.toFixed(2))}`);
        console.log(`    Your actual cost:${chalk.green(' $' + stats.totalCostUsd.toFixed(2))}`);
        console.log(`    ${chalk.green.bold(`Saved: $${saved.toFixed(2)} (${savedPct.toFixed(1)}%)`)}`);
    }
    else {
        console.log(chalk.gray('    Not enough data to calculate savings'));
    }
    // Recent activity (last 5 requests)
    if (stats.history.length > 0) {
        console.log(chalk.bold('\n  Recent Activity\n'));
        const recent = stats.history.slice(-5).reverse();
        for (const record of recent) {
            const time = new Date(record.timestamp).toLocaleTimeString();
            const model = record.model.split('/').pop() || record.model;
            const cost = '$' + record.costUsd.toFixed(4);
            const fallbackMark = record.fallback ? chalk.yellow(' ↺') : '';
            console.log(chalk.gray(`    ${time}`) +
                ` ${model}${fallbackMark} ` +
                chalk.green(cost));
        }
    }
    console.log('\n' + '─'.repeat(55));
    console.log(chalk.gray('  Run `runcode stats --clear` to reset statistics\n'));
}
