#!/usr/bin/env node
/**
 * Regression test for the v3.10.0 Detach cwd-resolution bug.
 *
 * Old code: `path.resolve(process.cwd(), 'dist', 'index.js')`
 * → tried to load <user-project>/dist/index.js → "Cannot find module"
 * → spawned _task-runner crashed at import time
 * → task stayed `queued` forever
 *
 * New code: resolves from `import.meta.url` (the spawn.js file's own
 * location), independent of where the user invokes Franklin from.
 *
 * This test reproduces the bug condition by chdir'ing OUT of the package
 * root before calling startDetachedTask, then verifies the spawned
 * runner actually started (status != 'queued' shortly after spawn).
 *
 * Cost: $0 — runs `sleep 1` in the spawned task, no Modal / x402.
 *
 * Run: node scripts/test-detach-cwd.mjs
 */

import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startDetachedTask } from '../dist/tasks/spawn.js';
import { readTaskMeta } from '../dist/tasks/store.js';

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('\nDetach cwd-resolution regression');
console.log('---------------------------------');

// Move cwd OUT of the Franklin package root, into a directory that has
// NO dist/index.js. The old code would resolve `${cwd}/dist/index.js`
// here and fail.
const fakeUserProject = fs.mkdtempSync(path.join(tmpdir(), 'franklin-regress-'));
const originalCwd = process.cwd();
process.chdir(fakeUserProject);
console.log(`  cwd set to: ${fakeUserProject}`);
console.log(`  (no dist/index.js exists here — old code would fail)\n`);

try {
  const runId = startDetachedTask({
    label: 'regression test',
    command: 'sleep 1; echo done',
    workingDir: fakeUserProject,
  });
  check(`startDetachedTask returned a runId`, typeof runId === 'string' && runId.length > 0);

  // Give the spawned _task-runner up to 3s to actually start. The
  // runner's first action on startup is to flip status from 'queued'
  // to 'running' (or terminal if the command is fast). With the bug,
  // the runner crashes at import time and status stays 'queued'.
  let meta;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    meta = readTaskMeta(runId);
    if (meta && meta.status !== 'queued') break;
  }

  check(`runner actually started (status != 'queued')`, meta?.status !== 'queued',
    `final status was '${meta?.status ?? 'null'}'`);

  // The `sleep 1` command should complete cleanly within a couple
  // seconds. Wait for terminal state.
  for (let i = 0; i < 50; i++) {
    if (meta && (meta.status === 'succeeded' || meta.status === 'failed')) break;
    await sleep(100);
    meta = readTaskMeta(runId);
  }

  check(`task reached terminal state`,
    meta?.status === 'succeeded' || meta?.status === 'failed',
    `final status was '${meta?.status ?? 'null'}'`);

  // Cleanup test artifact
  try {
    fs.rmSync(`${process.env.HOME}/.blockrun/tasks/${runId}`, { recursive: true, force: true });
  } catch { /* ignore */ }
} finally {
  process.chdir(originalCwd);
  try { fs.rmSync(fakeUserProject, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? '\x1b[32mRegression test passed.\x1b[0m' : `\x1b[31m${failures} check(s) failed.\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
