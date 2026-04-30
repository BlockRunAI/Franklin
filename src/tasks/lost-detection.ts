/**
 * Lost-task detection.
 *
 * For every task currently in `running` or `queued`, check whether its recorded
 * pid is still alive via `process.kill(pid, 0)`. If the pid is gone, the
 * runner crashed or was killed externally; flip status to `lost` so observers
 * (CLI list, agent prompt) stop misreporting it as in-flight.
 *
 * EPERM means the pid exists but we don't have permission to signal it —
 * treat that as alive. ESRCH (or anything else) means dead.
 *
 * Best-effort: PID reuse can lie. v3.10's contract is "lazy reconciliation
 * on `task list`"; v3.11 may add a pidStartTime cross-check.
 */

import { listTasks, applyEvent } from './store.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function reconcileLostTasks(now: number = Date.now()): number {
  let n = 0;
  for (const t of listTasks()) {
    if (t.status !== 'running' && t.status !== 'queued') continue;
    if (typeof t.pid !== 'number') continue;
    if (isPidAlive(t.pid)) continue;
    try {
      applyEvent(t.runId, {
        at: now,
        kind: 'lost',
        summary: 'Backing process not found — task may have been killed externally.',
      });
      n++;
    } catch (err) {
      // Meta could vanish mid-reconcile (e.g. the task dir was deleted out from
      // under us) — log and continue with the next task. One bad task should
      // not abort the whole sweep.
      process.stderr.write(
        `[franklin] reconcileLostTasks: skipping ${t.runId}: ${(err as Error).message}\n`,
      );
    }
  }
  return n;
}
