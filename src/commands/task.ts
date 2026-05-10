/**
 * `franklin task` CLI surface — human-facing operations on detached background
 * tasks. Mirrors the on-disk shape under `~/.franklin/tasks/<runId>/` that the
 * runner / store layers maintain. Subcommands grow incrementally over T10–T13:
 *   - list    : recent tasks, newest first
 *   - tail    : print log + status; --follow polls until terminal
 *   - cancel  : SIGTERM the runner pid
 *   - wait    : block until terminal, exit 0/1/2 by outcome
 */

import fs from 'node:fs';
import { Command } from 'commander';
import { listTasks, readTaskMeta } from '../tasks/store.js';
import { reconcileLostTasks } from '../tasks/lost-detection.js';
import { taskLogPath } from '../tasks/paths.js';
import { isTerminalTaskStatus } from '../tasks/types.js';

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function reconcileBestEffort(): void {
  try { reconcileLostTasks(); } catch { /* best-effort */ }
}

export function buildTaskCommand(): Command {
  const cmd = new Command('task').description('Manage long-running detached tasks');

  cmd
    .command('list')
    .description('List recent tasks (newest first)')
    .action(() => {
      reconcileBestEffort();
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log('No tasks. Start one via the Task agent tool.');
        return;
      }
      // Header row matches `franklin content list` shape — verified
      // 2026-05-05 that task list was emitting bare data rows with no
      // column labels, leaving users to guess at the column meaning
      // (`14h19m` could be elapsed-since-start or since-end). The
      // running-vs-terminal age semantics are documented in 3.15.46;
      // the header makes the column itself self-explanatory.
      const idHeader = 'runId';
      const idWidth = Math.max(idHeader.length, ...tasks.map(t => t.runId.length));
      console.log(
        [idHeader.padEnd(idWidth), 'status'.padEnd(10), '  age', 'label'].join('  '),
      );
      const now = Date.now();
      for (const t of tasks) {
        // For a running task, "age" should mean "how long has this been
        // going" — use startedAt (or createdAt). For a terminal task,
        // "age" should mean "how recently did this end" — use endedAt
        // (or lastEventAt). Verified 2026-05-04 on a real machine: a
        // running ETL that had been chewing through 685k files for
        // 13 minutes was displayed as "0s" because the runner's 5s
        // heartbeat keeps lastEventAt fresh — useless signal.
        const isTerminal = isTerminalTaskStatus(t.status);
        const ageRefMs = isTerminal
          ? (t.endedAt ?? t.lastEventAt ?? t.createdAt)
          : (t.startedAt ?? t.createdAt);
        const age = fmtAge(now - ageRefMs);
        console.log(`${t.runId.padEnd(idWidth)}  ${t.status.padEnd(10)}  ${age.padStart(5)}  ${t.label}`);
      }
    });

  cmd
    .command('tail <runId>')
    .description('Print log + current status for a task')
    .option('-f, --follow', 'Poll until task reaches terminal state')
    .action(async (runId: string, opts: { follow?: boolean }) => {
      reconcileBestEffort();
      const meta0 = readTaskMeta(runId);
      if (!meta0) {
        console.error(`No task: ${runId}`);
        process.exit(1);
      }
      let printed = 0;
      const printNew = () => {
        try {
          const buf = fs.readFileSync(taskLogPath(runId));
          if (buf.length > printed) {
            process.stdout.write(buf.subarray(printed));
            printed = buf.length;
          }
        } catch {
          /* log not yet written */
        }
      };
      printNew();
      if (opts.follow) {
        while (true) {
          await new Promise((r) => setTimeout(r, 1000));
          reconcileBestEffort();
          printNew();
          const meta = readTaskMeta(runId);
          if (meta && isTerminalTaskStatus(meta.status)) break;
        }
      }
      const meta = readTaskMeta(runId);
      if (meta) {
        console.log(`\n--- ${meta.status} ---`);
        // Don't reprint terminalSummary: it's a whitespace-collapsed
        // copy of the last ~800 bytes of the log, and we just printed
        // the FULL log via printNew(). Verified 2026-05-04 on a real
        // failed task: the user saw the same lines twice, the second
        // copy as one squashed line, e.g.
        //   [17:43:40] resume state: ... [17:43:40] manifest cached: ...
        // which is harder to read than the multi-line original.
        // exitCode is the only useful extra here (the log doesn't
        // record it explicitly).
        if (meta.exitCode !== undefined) console.log(`exitCode: ${meta.exitCode}`);
      }
    });

  cmd
    .command('wait <runId>')
    .description('Block until task reaches terminal state, then exit')
    .option('--timeout <ms>', 'Max wait, default 30 minutes', '1800000')
    .action(async (runId: string, opts: { timeout: string }) => {
      const cap = parseInt(opts.timeout, 10);
      const t0 = Date.now();
      while (true) {
        reconcileBestEffort();
        const meta = readTaskMeta(runId);
        if (!meta) {
          console.error(`No task: ${runId}`);
          process.exit(1);
        }
        if (isTerminalTaskStatus(meta.status)) {
          console.log(`${meta.status}: ${meta.terminalSummary ?? ''}`);
          process.exit(meta.status === 'succeeded' ? 0 : 1);
        }
        if (Date.now() - t0 > cap) {
          console.error(`Timed out after ${cap}ms; task still ${meta.status}.`);
          process.exit(2);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

  cmd
    .command('cancel <runId>')
    .description('Cancel a running task (SIGTERM to runner)')
    .action((runId: string) => {
      reconcileBestEffort();
      const meta = readTaskMeta(runId);
      if (!meta) {
        console.error(`No task: ${runId}`);
        process.exit(1);
      }
      if (isTerminalTaskStatus(meta.status)) {
        console.log(`Task already ${meta.status}.`);
        return;
      }
      if (typeof meta.pid !== 'number') {
        console.error('Task has no recorded pid (likely still queued).');
        process.exit(1);
      }
      try {
        process.kill(meta.pid, 'SIGTERM');
        console.log(`SIGTERM sent to ${meta.pid}.`);
      } catch (err) {
        console.error(`Could not signal pid ${meta.pid}: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
