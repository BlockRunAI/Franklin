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

export function buildTaskCommand(): Command {
  const cmd = new Command('task').description('Manage long-running detached tasks');

  cmd
    .command('list')
    .description('List recent tasks (newest first)')
    .action(() => {
      reconcileLostTasks();
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log('No tasks. Start one via the Task agent tool.');
        return;
      }
      const now = Date.now();
      for (const t of tasks) {
        const age = fmtAge(now - (t.lastEventAt ?? t.createdAt));
        console.log(`${t.runId}  ${t.status.padEnd(10)}  ${age.padStart(5)}  ${t.label}`);
      }
    });

  cmd
    .command('tail <runId>')
    .description('Print log + current status for a task')
    .option('-f, --follow', 'Poll until task reaches terminal state')
    .action(async (runId: string, opts: { follow?: boolean }) => {
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
          printNew();
          const meta = readTaskMeta(runId);
          if (meta && isTerminalTaskStatus(meta.status)) break;
        }
      }
      const meta = readTaskMeta(runId);
      if (meta) {
        console.log(`\n--- ${meta.status} ---`);
        if (meta.terminalSummary) console.log(meta.terminalSummary);
      }
    });

  cmd
    .command('cancel <runId>')
    .description('Cancel a running task (SIGTERM to runner)')
    .action((runId: string) => {
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
