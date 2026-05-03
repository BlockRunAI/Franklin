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
 *   2. <package-dist>/index.js — resolved RELATIVE TO this module's own
 *      file location via import.meta.url. The previous implementation
 *      used `path.resolve(process.cwd(), 'dist', 'index.js')`, which
 *      assumes the user is invoking Franklin from the package root.
 *      In practice agents and the VS Code extension run with cwd set to
 *      the user's working directory (e.g. /Users/<x>/Desktop/project),
 *      so the spawned task tried to load
 *      `/Users/<x>/Desktop/project/dist/index.js` and crashed with
 *      "Cannot find module". Resolving against import.meta.url makes
 *      the lookup independent of where the user invoked from.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeTaskMeta } from './store.js';
import { taskLogPath, ensureTaskDir } from './paths.js';
import type { TaskRecord } from './types.js';

export interface StartDetachedTaskInput {
  label: string;
  command: string;
  workingDir: string;
}

function resolveCliPath(): string {
  // Strategy chain — first existing path wins. Two real-world deploys to
  // satisfy: (1) standalone CLI install where spawn.js lives at
  // dist/tasks/spawn.js, (2) VS Code extension where spawn.js is bundled
  // INTO out/extension.cjs by esbuild, so import.meta.url points at the
  // bundle, not the original source file.
  const candidates: string[] = [];

  // (1) Explicit override — extension sets this on activate() once it
  //     knows where @blockrun/franklin is npm-installed in its sandbox.
  const fromEnv = process.env.FRANKLIN_CLI_PATH;
  if (fromEnv && fromEnv.length > 0) candidates.push(fromEnv);

  // (2) npm-aware resolution — works for global CLI installs and any
  //     context where @blockrun/franklin is reachable through node's
  //     module resolution. createRequire works in both ESM and bundled
  //     CJS contexts.
  try {
    const { createRequire } = require('node:module') as typeof import('node:module');
    const req = createRequire(import.meta.url);
    candidates.push(req.resolve('@blockrun/franklin'));
  } catch { /* not all bundlers preserve createRequire — fall through */ }

  // (3) Relative to this module's own URL — works for the standalone
  //     CLI install (spawn.js at dist/tasks/spawn.js → dist/index.js).
  //     In bundled extension contexts this resolves to the bundle's
  //     directory, which is wrong, but harmless if (1) or (2) hit first.
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(path.resolve(path.dirname(here), '..', 'index.js'));
  } catch { /* import.meta absent — skip */ }

  // (4) Last-ditch cwd-based — the original buggy behavior, kept as a
  //     final fallback so resolveCliPath never throws even in the most
  //     stripped-down bundler output.
  candidates.push(path.resolve(process.cwd(), 'dist', 'index.js'));

  // Return the first candidate that actually exists on disk. If none
  // exist, return the highest-priority one anyway so the spawn fails
  // with an explicit "Cannot find module" instead of silently using
  // a stale path.
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* try next */ }
  }
  return candidates[0];
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
