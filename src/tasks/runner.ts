/**
 * Detached task runner. The hidden `_task-runner <runId>` subcommand of the
 * `franklin` CLI dispatches into this module, which is what actually executes
 * the user's command in the detached child process.
 *
 * Lifecycle (per task):
 *   1. Read meta.json. Bail with exit code 2 if it's gone.
 *   2. Open log.txt for append, record our own pid + status=running, emit
 *      a `running` event.
 *   3. Spawn `bash -lc <command>` with stdout/stderr piped to log.txt.
 *   4. Heartbeat every 5s: just refresh meta.lastEventAt so observers can see
 *      "still going."
 *   5. On child exit (or spawn error), close the log fd, finalize meta with
 *      exitCode + status (`succeeded` if 0, `failed` otherwise), emit a
 *      terminal event whose summary is the last 500 chars of log.
 *
 * Defensive style: we re-read meta inside the heartbeat and on exit because
 * a concurrent `franklin task cancel` (or external `rm -rf`) can vanish the
 * task dir mid-flight. Every fs operation is best-effort.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readTaskMeta, applyEvent, writeTaskMeta } from './store.js';
import { taskLogPath, ensureTaskDir } from './paths.js';
import type { TaskStatus } from './types.js';

const HEARTBEAT_MS = 5_000;
const TAIL_BYTES = 500;

function safeCloseFd(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}

function readLogTail(runId: string): string {
  try {
    const buf = fs.readFileSync(taskLogPath(runId), 'utf-8');
    return buf.slice(-TAIL_BYTES).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export async function runDetachedTask(runId: string): Promise<number> {
  const meta = readTaskMeta(runId);
  if (!meta) {
    process.stderr.write(`runner: no task ${runId}\n`);
    return 2;
  }

  ensureTaskDir(runId);
  const logFd = fs.openSync(taskLogPath(runId), 'a');
  let logFdClosed = false;
  const closeLog = () => {
    if (logFdClosed) return;
    logFdClosed = true;
    safeCloseFd(logFd);
  };

  const startedAt = Date.now();
  writeTaskMeta({
    ...meta,
    pid: process.pid,
    status: 'running',
    startedAt,
    lastEventAt: startedAt,
  });
  applyEvent(runId, { at: startedAt, kind: 'running', summary: 'runner started' });

  // `finalized` guards against the rare case where the heartbeat timer
  // already fired but its callback is still on the event-loop queue at
  // the moment finalize() runs — without this flag, a heartbeat write
  // could land *after* the terminal event and clobber lastEventAt /
  // status. We flip it before clearInterval so any pending callback
  // bails on its first line.
  let finalized = false;

  // Heartbeat: every 5s while child is alive, refresh lastEventAt so
  // observers see "still going." If the meta has been deleted out from
  // under us (someone rm'd the task dir), skip silently — no need to
  // re-create a stub.
  const heartbeat = setInterval(() => {
    if (finalized) return;
    const cur = readTaskMeta(runId);
    if (!cur) return;
    try {
      writeTaskMeta({ ...cur, lastEventAt: Date.now() });
    } catch (err) {
      process.stderr.write(
        `[franklin] runner heartbeat: ${(err as Error).message}\n`,
      );
    }
  }, HEARTBEAT_MS);

  // Best-effort finalize. Used by both the normal exit path and the spawn
  // error path. Always closes the log fd and clears the heartbeat.
  // If `finalized` is already true (cancel path beat us to it), bail —
  // we would otherwise overwrite the on-disk `cancelled` terminal state
  // with `failed` after `child.kill('SIGTERM')` causes child.on('exit').
  const finalize = (
    exitCode: number,
    status: Extract<TaskStatus, 'succeeded' | 'failed'>,
    fallbackSummary: string,
  ): void => {
    if (finalized) return;
    finalized = true;
    clearInterval(heartbeat);
    closeLog();
    const endedAt = Date.now();
    const tail = readLogTail(runId);
    const cur = readTaskMeta(runId);
    if (cur) {
      try {
        writeTaskMeta({ ...cur, exitCode });
      } catch (err) {
        process.stderr.write(
          `[franklin] runner finalize writeTaskMeta: ${(err as Error).message}\n`,
        );
      }
      try {
        applyEvent(runId, {
          at: endedAt,
          kind: status,
          summary: tail || fallbackSummary,
        });
      } catch (err) {
        process.stderr.write(
          `[franklin] runner finalize applyEvent: ${(err as Error).message}\n`,
        );
      }
    } else {
      // Meta vanished mid-run. Nothing to finalize. Surface for ops, exit clean.
      process.stderr.write(
        `[franklin] runner: meta for ${runId} disappeared before finalize\n`,
      );
    }
  };

  const child = spawn('bash', ['-lc', meta.command], {
    cwd: meta.workingDir,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FRANKLIN_TASK_RUN_ID: runId },
  });

  // Cancel path: parent CLI sends SIGTERM (or user hits Ctrl-C). We must
  // (a) flip `finalized` BEFORE the soon-to-fire child.exit handler runs so
  //     it short-circuits and doesn't write status=failed,
  // (b) clear the heartbeat for the same reason,
  // (c) kill the child (SIGTERM) so the bash process actually dies,
  // (d) applyEvent('cancelled') so the on-disk terminal state is correct,
  // (e) close the log fd,
  // (f) exit 130 (the canonical Ctrl-C / SIGTERM exit code) on a small delay
  //     so any in-flight fs writes flush.
  const onSignal = () => {
    if (finalized) return;
    finalized = true;
    clearInterval(heartbeat);
    try {
      child.kill('SIGTERM');
    } catch {
      /* child may already be gone */
    }
    closeLog();
    try {
      applyEvent(runId, {
        at: Date.now(),
        kind: 'cancelled',
        summary: 'Cancelled via SIGTERM',
      });
    } catch (err) {
      process.stderr.write(
        `[franklin] runner cancel applyEvent: ${(err as Error).message}\n`,
      );
    }
    setTimeout(() => process.exit(130), 500);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const settle = (code: number) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    child.on('error', (err) => {
      // Spawn itself failed — bash not on $PATH, EACCES, etc. Make sure we
      // close the log fd, finalize the task, and exit.
      const exitCode = 1;
      finalize(exitCode, 'failed', `spawn error: ${err.message}`);
      settle(exitCode);
    });

    child.on('exit', (code, signal) => {
      const exitCode =
        typeof code === 'number' ? code : signal ? 128 : 1;
      const status: 'succeeded' | 'failed' =
        exitCode === 0 ? 'succeeded' : 'failed';
      finalize(
        exitCode,
        status,
        status === 'succeeded' ? 'completed' : `exited with code ${exitCode}`,
      );
      settle(exitCode);
    });
  });
}
