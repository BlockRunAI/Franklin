/**
 * franklin stats command
 * Display usage statistics and cost savings
 */

import chalk from 'chalk';
import { loadStats, clearStats, getStatsSummary } from '../stats/tracker.js';
import { summarizeSdkSettlements } from '../stats/cost-log.js';

interface StatsOptions {
  clear?: boolean;
  json?: boolean;
}

export function statsCommand(options: StatsOptions): void {
  if (options.clear) {
    clearStats();
    console.log(chalk.green('✓ Statistics cleared'));
    return;
  }

  const { stats, opusCost, saved, savedPct, avgCostPerRequest, period } =
    getStatsSummary();

  // SDK ledger reconciliation. `franklin-stats.json` only captures requests
  // that flowed through Franklin's `recordUsage()` paths (main agent loop +
  // proxy). Helper LLM calls and SDK-internal probes settle x402 payments
  // through `~/.blockrun/cost_log.jsonl` (SDK-owned) — adding it here so
  // the user sees the wire-level total alongside Franklin's recorded one.
  // The gap between the two = recording instrumentation that's still
  // missing from helper paths (analyzeTurn, compaction, evaluator, etc.).
  const statsWindowStartMs = stats.resetAt ?? stats.firstRequest;
  const sdkLedger = summarizeSdkSettlements(
    typeof statsWindowStartMs === 'number'
      ? { sinceMs: statsWindowStartMs }
      : undefined
  );
  const recordedTotal = stats.totalCostUsd;
  const sdkTotal = sdkLedger.totalUsd;
  const gap = sdkTotal - recordedTotal;
  const gapPct = sdkTotal > 0 ? (gap / sdkTotal) * 100 : 0;
  // Bidirectional check. Two distinct gap meanings:
  //   sdkTotal > recordedTotal → helper LLM calls / SDK probes settled
  //     on-chain but bypassed Franklin's recordUsage. The ledger is the
  //     wire truth; recorded total is incomplete.
  //   sdkTotal < recordedTotal → cost_log.jsonl was probably rotated /
  //     truncated since the stats started accumulating. Recorded total is
  //     more complete; the ledger is just the recent slice.
  // Treat any gap > $0.01 OR > 5% (in either direction) as worth flagging.
  const significantGap =
    sdkTotal > 0 && (Math.abs(gap) > 0.01 || Math.abs(gapPct) > 5);

  // JSON output for programmatic access
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...stats,
          computed: {
            opusCost,
            saved,
            savedPct,
            avgCostPerRequest,
            period,
          },
          sdkLedger: {
            path: sdkLedger.path,
            entries: sdkLedger.count,
            totalUsd: sdkTotal,
            byEndpoint: sdkLedger.byEndpoint.slice(0, 10),
            firstTs: sdkLedger.firstTs,
            lastTs: sdkLedger.lastTs,
            sinceMs: statsWindowStartMs ?? null,
          },
          reconciliation: {
            recordedUsd: recordedTotal,
            sdkLedgerUsd: sdkTotal,
            gapUsd: gap,
            gapPct,
            significantGap,
            windowStartMs: statsWindowStartMs ?? null,
          },
        },
        null,
        2
      )
    );
    return;
  }

  // Pretty output
  console.log(chalk.bold('\n📊 Franklin Usage Statistics\n'));
  console.log('─'.repeat(55));

  if (stats.totalRequests === 0 && sdkTotal === 0) {
    console.log(
      chalk.gray('\n  No requests recorded yet. Start using franklin!\n')
    );
    console.log('─'.repeat(55) + '\n');
    return;
  }

  // Overview
  console.log(chalk.bold('\n  Overview') + chalk.gray(` (${period})\n`));
  console.log(
    `    Requests:       ${chalk.cyan(stats.totalRequests.toLocaleString())}`
  );
  console.log(
    `    Recorded Cost:  ${chalk.green('$' + stats.totalCostUsd.toFixed(4))}` +
      chalk.gray('  (franklin-stats.json — main loop + proxy + tools that call recordUsage)')
  );
  if (sdkTotal > 0) {
    const ledgerColor = significantGap ? chalk.yellow : chalk.green;
    console.log(
      `    SDK Ledger:     ${ledgerColor('$' + sdkTotal.toFixed(4))}` +
        chalk.gray(`  (cost_log.jsonl — actual x402 settlements, ${sdkLedger.count} rows)`)
    );
    if (significantGap) {
      const explanation =
        gap > 0
          ? 'helper LLM calls (analyzeTurn / compaction / evaluator / verification / subagent / MoA / etc.) settled on-chain but bypassed recordUsage. SDK ledger is the wire truth.'
          : 'cost_log.jsonl looks rotated or truncated — it covers fewer rows than franklin-stats.json. Recorded total is more complete than the ledger here.';
      console.log(
        chalk.yellow(
          `    ⚠ Gap:          $${Math.abs(gap).toFixed(4)} (${Math.abs(gapPct).toFixed(1)}%) ${gap > 0 ? '↑' : '↓'} — ${explanation}`
        )
      );
    } else {
      console.log(
        chalk.gray(
          `    Gap:            $${gap.toFixed(4)} (${gapPct.toFixed(1)}%)`
        )
      );
    }
  }
  console.log(
    `    Avg per Request: ${chalk.gray('$' + avgCostPerRequest.toFixed(6))}`
  );
  console.log(`    Input Tokens:   ${stats.totalInputTokens.toLocaleString()}`);
  console.log(
    `    Output Tokens:  ${stats.totalOutputTokens.toLocaleString()}`
  );

  if (stats.totalFallbacks > 0) {
    const fallbackPct = (
      (stats.totalFallbacks / stats.totalRequests) *
      100
    ).toFixed(1);
    console.log(
      `    Fallbacks:      ${chalk.yellow(stats.totalFallbacks.toString())} (${fallbackPct}%)`
    );
  }

  // Per-model breakdown
  const modelEntries = Object.entries(stats.byModel);
  if (modelEntries.length > 0) {
    console.log(chalk.bold('\n  By Model\n'));

    // Sort by cost (descending)
    const sorted = modelEntries.sort((a, b) => b[1].costUsd - a[1].costUsd);

    for (const [model, data] of sorted) {
      const pct =
        stats.totalCostUsd > 0
          ? ((data.costUsd / stats.totalCostUsd) * 100).toFixed(1)
          : '0';
      const avgLatency = Math.round(data.avgLatencyMs);

      // Shorten model name if too long
      const displayModel =
        model.length > 35 ? model.slice(0, 32) + '...' : model;

      console.log(`    ${chalk.cyan(displayModel)}`);
      console.log(
        chalk.gray(
          `      ${data.requests} req · $${data.costUsd.toFixed(4)} (${pct}%) · ${avgLatency}ms avg`
        )
      );

      if (data.fallbackCount > 0) {
        console.log(
          chalk.yellow(`      ↳ ${data.fallbackCount} fallback recoveries`)
        );
      }
    }
  }

  // Savings comparison
  console.log(chalk.bold('\n  💰 Savings vs Opus-tier baseline\n'));

  if (opusCost > 0) {
    console.log(
      `    Opus equivalent: ${chalk.gray('$' + opusCost.toFixed(2))}`
    );
    console.log(
      `    Your actual cost:${chalk.green(' $' + stats.totalCostUsd.toFixed(2))}`
    );
    console.log(
      `    ${chalk.green.bold(`Saved: $${saved.toFixed(2)} (${savedPct.toFixed(1)}%)`)}`
    );
  } else {
    console.log(chalk.gray('    Not enough data to calculate savings'));
  }

  // SDK ledger breakdown — surfaces non-chat endpoints (Modal, PM, x.com,
  // exa, etc.) that flow through tools and may not show up in byModel.
  // Only print when the ledger has real data.
  if (sdkLedger.count > 0 && sdkLedger.byEndpoint.length > 0) {
    console.log(chalk.bold('\n  SDK Ledger (top endpoints)\n'));
    for (const e of sdkLedger.byEndpoint.slice(0, 6)) {
      const pct = sdkTotal > 0 ? ((e.costUsd / sdkTotal) * 100).toFixed(1) : '0';
      const display = e.endpoint.length > 40 ? e.endpoint.slice(0, 37) + '...' : e.endpoint;
      console.log(`    ${chalk.cyan(display)}`);
      console.log(
        chalk.gray(
          `      ${e.count} call${e.count === 1 ? '' : 's'} · $${e.costUsd.toFixed(4)} (${pct}%)`
        )
      );
    }
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

      console.log(
        chalk.gray(`    ${time}`) +
          ` ${model}${fallbackMark} ` +
          chalk.green(cost)
      );
    }
  }

  console.log('\n' + '─'.repeat(55));
  console.log(
    chalk.gray('  Run `franklin stats --clear` to reset statistics\n')
  );
}
