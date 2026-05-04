/**
 * Public spawn surface for the detached task subsystem.
 *
 * `startDetachedTask` is the synchronous entry point used by the `Task`
 * agent tool and by `franklin task` callers. It writes a queued
 * TaskRecord to disk, opens log.txt for stdout/stderr capture, then
 * spawns `franklin _task-runner <runId>` with `detached: true` and
 * unrefs the child so this process can exit without waiting on the
 * task. The runner subprocess takes over from there: it spawns the
 * actual user command, drives heartbeats, and finalizes meta on exit.
 *
 * Performance contract: startDetachedTask must return in <250ms. That
 * is enforced by the integration test in test/local.mjs and is the
 * reason all I/O here is sync — we want one fs write + one spawn, not
 * an async chain that could be interrupted by a slow microtask.
 *
 * CLI path resolution (in priority order):
 *   1. process.env.FRANKLIN_CLI_PATH — escape hatch for tests / dev.
 *   2. STARTUP_CLI_PATH (captured at module load) — absolute path of
 *      the script Node is currently executing. Captured early so it
 *      survives any later chdir; resolved to absolute so it survives
 *      the spawn's `cwd:` override (the bug it fixes — verified
 *      2026-05-04 from a real session: dev-mode `node dist/index.js`
 *      run, then Detach with workingDir=other-repo, child fails with
 *      MODULE_NOT_FOUND on `<other-repo>/dist/index.js`).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeTaskMeta } from './store.js';
import { taskLogPath, ensureTaskDir } from './paths.js';
import type { TaskRecord } from './types.js';

// Captured at module load so it survives later chdir / argv mutation.
// `process.argv[1]` may be relative (`dist/index.js` in dev mode); we
// resolve against process.cwd() at startup which is when the user's
// shell exec'd the bundle. Doing this at call time would be wrong if
// any code chdir'd between startup and the Detach call.
const STARTUP_CLI_PATH: string | undefined = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return undefined;
  try {
    return path.resolve(argv1);
  } catch {
    return argv1;
  }
})();

export interface StartDetachedTaskInput {
  label: string;
  command: string;
  workingDir: string;
}

function resolveCliPath(): string {
  const fromEnv = process.env.FRANKLIN_CLI_PATH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // STARTUP_CLI_PATH is the absolute path resolved at module load —
  // safe to use after `cwd: input.workingDir` redirects the child.
  // npm global installs already give an absolute path; this only
  // matters in dev mode where `node dist/index.js` puts a relative
  // path into argv[1].
  return STARTUP_CLI_PATH || process.argv[1];
}

function generateRunId(): string {
  return `t_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function startDetachedTask(input: StartDetachedTaskInput): string {
  const runId = generateRunId();
  const now = Date.now();

  const record: TaskRecord = {
    runId,
    runtime: 'detached-bash',
    label: input.label,
    command: input.command,
    workingDir: input.workingDir,
    status: 'queued',
    createdAt: now,
  };
  writeTaskMeta(record);

  ensureTaskDir(runId);
  const cliPath = resolveCliPath();
  const logFd = fs.openSync(taskLogPath(runId), 'a');

  // detached + unref + ignore stdin = parent can exit immediately while
  // the child keeps running. The runner reopens its own log handles via
  // the inherited stdout/stderr fds, so we close ours after spawn returns.
  const child = spawn(process.execPath, [cliPath, '_task-runner', runId], {
    cwd: input.workingDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FRANKLIN_TASK_RUN_ID: runId },
  });
  child.unref();

  // The child has duped the fd; closing ours frees the parent's slot.
  // Surface unexpected errors instead of swallowing — a leaked fd here
  // is rare but worth knowing about.
  try {
    fs.closeSync(logFd);
  } catch (err) {
    process.stderr.write(
      `[franklin] startDetachedTask: closing log fd failed: ${(err as Error).message}\n`,
    );
  }

  return runId;
}
