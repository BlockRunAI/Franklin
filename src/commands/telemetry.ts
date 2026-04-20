/**
 * `franklin telemetry` — manage the opt-in local telemetry subsystem.
 *
 * Subcommands:
 *   status   — print whether telemetry is enabled, where the log lives,
 *              and a one-line summary of what's been recorded
 *   enable   — turn on local recording (default is OFF)
 *   disable  — stop future recording; existing data stays on disk
 *   view     — print every record in the log as pretty JSONL so the
 *              user can see exactly what was captured
 *   summary  — aggregate all records into tool-usage histograms so
 *              positioning decisions can be made from real data
 */

import chalk from 'chalk';
import fs from 'node:fs';
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  readConsent,
  readAllRecords,
  telemetryPaths,
} from '../telemetry/store.js';

export async function telemetryCommand(action?: string): Promise<void> {
  const cmd = (action || 'status').toLowerCase();
  switch (cmd) {
    case 'status':
      return statusCmd();
    case 'enable':
    case 'on':
      return enableCmd();
    case 'disable':
    case 'off':
      return disableCmd();
    case 'view':
    case 'log':
      return viewCmd();
    case 'summary':
      return summaryCmd();
    default:
      console.log(chalk.yellow(`Unknown subcommand: ${action}`));
      console.log(chalk.dim('Try: franklin telemetry [status|enable|disable|view|summary]'));
      process.exit(1);
  }
}

function statusCmd(): void {
  const enabled = isTelemetryEnabled();
  const consent = readConsent();
  const records = readAllRecords();

  console.log(chalk.bold('Franklin telemetry'));
  console.log(`  state:      ${enabled ? chalk.green('enabled') : chalk.dim('disabled (default)')}`);
  if (consent.enabledAt) {
    console.log(`  enabled at: ${chalk.dim(new Date(consent.enabledAt).toISOString())}`);
  }
  if (consent.disabledAt && !enabled) {
    console.log(`  disabled at: ${chalk.dim(new Date(consent.disabledAt).toISOString())}`);
  }
  console.log(`  records:    ${chalk.cyan(records.length.toString())} session${records.length === 1 ? '' : 's'} on disk`);
  console.log(`  log file:   ${chalk.dim(telemetryPaths.log)}`);
  console.log();
  console.log(chalk.dim('Telemetry is local-only: no network transmission.'));
  console.log(chalk.dim('Records contain tool-usage counts and cost totals — NOT prompts, tool inputs, tool outputs, paths, or wallet addresses.'));
  console.log();
  console.log(chalk.dim('Commands:'));
  console.log(chalk.dim('  franklin telemetry enable     turn on local recording'));
  console.log(chalk.dim('  franklin telemetry disable    stop future recording (keeps existing data)'));
  console.log(chalk.dim('  franklin telemetry view       print every stored record verbatim'));
  console.log(chalk.dim('  franklin telemetry summary    aggregate tool-usage histograms'));
}

function enableCmd(): void {
  if (isTelemetryEnabled()) {
    console.log(chalk.dim('Telemetry is already enabled.'));
    return;
  }
  setTelemetryEnabled(true);
  console.log(chalk.green('Telemetry enabled.'));
  console.log(chalk.dim('Each session end appends one JSON line to ' + telemetryPaths.log));
  console.log(chalk.dim('Inspect with: franklin telemetry view'));
  console.log(chalk.dim('Disable with: franklin telemetry disable'));
}

function disableCmd(): void {
  if (!isTelemetryEnabled()) {
    console.log(chalk.dim('Telemetry is already disabled.'));
    return;
  }
  setTelemetryEnabled(false);
  console.log(chalk.green('Telemetry disabled. Future sessions will not be recorded.'));
  console.log(chalk.dim('Existing data at ' + telemetryPaths.log + ' is untouched.'));
  console.log(chalk.dim('Delete it manually if you want to clear history.'));
}

function viewCmd(): void {
  const records = readAllRecords();
  if (records.length === 0) {
    console.log(chalk.dim('No telemetry records yet.'));
    if (!isTelemetryEnabled()) {
      console.log(chalk.dim('Telemetry is disabled — enable with: franklin telemetry enable'));
    }
    return;
  }
  for (const r of records) {
    console.log(JSON.stringify(r, null, 2));
    console.log(chalk.dim('─'.repeat(60)));
  }
}

function summaryCmd(): void {
  const records = readAllRecords();
  if (records.length === 0) {
    console.log(chalk.dim('No telemetry records yet.'));
    return;
  }

  const toolCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const driverCounts = new Map<string, number>();
  let totalCost = 0;
  let totalSaved = 0;
  let totalTurns = 0;

  for (const r of records) {
    if (r.toolCallCounts) {
      for (const [tool, n] of Object.entries(r.toolCallCounts)) {
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + n);
      }
    }
    modelCounts.set(r.model, (modelCounts.get(r.model) || 0) + 1);
    driverCounts.set(r.driver, (driverCounts.get(r.driver) || 0) + 1);
    totalCost += r.costUsd;
    totalSaved += r.savedVsOpusUsd;
    totalTurns += r.turns;
  }

  console.log(chalk.bold(`\nFranklin telemetry summary — ${records.length} sessions\n`));
  console.log(`  total turns:        ${totalTurns}`);
  console.log(`  total USDC cost:    $${totalCost.toFixed(4)}`);
  console.log(`  saved vs Opus:      $${totalSaved.toFixed(4)}`);
  console.log();
  console.log(chalk.bold('  Tool usage (session aggregate):'));
  const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedTools.length === 0) {
    console.log(chalk.dim('    (no tool calls recorded)'));
  } else {
    const maxCount = sortedTools[0][1];
    for (const [tool, n] of sortedTools) {
      const bar = '█'.repeat(Math.max(1, Math.round((n / maxCount) * 20)));
      console.log(`    ${tool.padEnd(22)} ${chalk.cyan(bar)} ${n}`);
    }
  }
  console.log();
  console.log(chalk.bold('  Models:'));
  const sortedModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [model, n] of sortedModels) {
    console.log(`    ${model.padEnd(36)} ${n}`);
  }
  console.log();
  console.log(chalk.bold('  Drivers:'));
  for (const [driver, n] of driverCounts.entries()) {
    console.log(`    ${driver.padEnd(22)} ${n}`);
  }
  console.log();
}
