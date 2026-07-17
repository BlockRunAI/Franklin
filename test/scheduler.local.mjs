/**
 * Deterministic tests for the durable scheduler (src/scheduler/), the input
 * multiplexer (src/agent/input-queue.ts), and the monitor registry
 * (src/monitors/registry.ts). No network, no wallet, temp HOME.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-sched-test-'));
process.env.HOME = TMP_HOME;

const {
  createScheduledTask, listScheduledTasks, deleteScheduledTask, markFired, saveScheduledTask, schedulerDir,
} = await import('../dist/scheduler/store.js');
const { parseInterval, formatInterval, MAX_LIVE_TASKS } = await import('../dist/scheduler/types.js');
const { startSchedulerService } = await import('../dist/scheduler/service.js');
const { createInputMultiplexer } = await import('../dist/agent/input-queue.js');
const { registerMonitor, sweepMonitors, resetMonitors, listMonitors, MAX_LINES_PER_SWEEP } =
  await import('../dist/monitors/registry.js');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function clearSchedulerDir() {
  fs.rmSync(schedulerDir(), { recursive: true, force: true });
}

// ─── Interval parsing ──────────────────────────────────────────────────────

test('parseInterval handles units and rejects junk', () => {
  assert.equal(parseInterval('90s'), 90);
  assert.equal(parseInterval('5m'), 300);
  assert.equal(parseInterval('2h'), 7200);
  assert.equal(parseInterval('1d'), 86400);
  assert.equal(parseInterval('120'), 120);
  assert.equal(parseInterval('0'), null);
  assert.equal(parseInterval('abc'), null);
  assert.equal(parseInterval('5x'), null);
  assert.equal(formatInterval(300), '5m');
  assert.equal(formatInterval(86400), '1d');
});

// ─── Store ─────────────────────────────────────────────────────────────────

test('store: create clamps interval, one-shot deletes on fire, recurring re-arms', () => {
  clearSchedulerDir();
  const clamped = createScheduledTask({ prompt: 'p', intervalSec: 5, sessionId: 's1' });
  assert.equal(clamped.intervalSec, 60, 'sub-minimum intervals clamp to 60s');

  const oneShot = createScheduledTask({ prompt: 'once', intervalSec: 60, sessionId: 's1', recurring: false });
  markFired(oneShot);
  assert.equal(listScheduledTasks().find(t => t.id === oneShot.id), undefined, 'fired one-shot is deleted');

  const rec = createScheduledTask({ prompt: 'again', intervalSec: 60, sessionId: 's1' });
  const before = rec.nextFireAt;
  const fired = markFired(rec);
  assert.ok(fired.nextFireAt > before - 1, 're-armed');
  assert.equal(fired.firedCount, 1);
  const reloaded = listScheduledTasks().find(t => t.id === rec.id);
  assert.equal(reloaded.firedCount, 1, 'firing persisted');
});

test('store: expired tasks are pruned on list', () => {
  clearSchedulerDir();
  const t = createScheduledTask({ prompt: 'stale', intervalSec: 60, sessionId: 's1' });
  saveScheduledTask({ ...t, expiresAt: Date.now() - 1000 });
  assert.equal(listScheduledTasks().length, 0);
  assert.equal(fs.existsSync(path.join(schedulerDir(), `${t.id}.json`)), false, 'expired file pruned');
});

test('store: live-task cap enforced', () => {
  clearSchedulerDir();
  for (let i = 0; i < MAX_LIVE_TASKS; i++) {
    const r = createScheduledTask({ prompt: `t${i}`, intervalSec: 60, sessionId: 's1' });
    assert.ok(!('error' in r), `task ${i} should create`);
  }
  const overflow = createScheduledTask({ prompt: 'one too many', intervalSec: 60, sessionId: 's1' });
  assert.ok('error' in overflow);
  clearSchedulerDir();
});

// ─── Service ───────────────────────────────────────────────────────────────

test('service: catch-up fires overdue durable tasks at start, skips foreign session-only tasks', () => {
  clearSchedulerDir();
  const overdue = createScheduledTask({ prompt: 'overdue durable', intervalSec: 60, sessionId: 'old-session', fireImmediately: true });
  assert.ok(!('error' in overdue));
  const foreign = createScheduledTask({ prompt: 'foreign session-only', intervalSec: 60, sessionId: 'other-session', durable: false, fireImmediately: true });
  assert.ok(!('error' in foreign));

  const fired = [];
  const svc = startSchedulerService({
    sessionId: 'new-session',
    enqueue: (text) => fired.push(text),
  });
  svc.stop();

  assert.deepEqual(fired, ['overdue durable'], 'durable catches up; foreign session-only does not');
  clearSchedulerDir();
});

test('service: tick fires due tasks once and advances them', () => {
  clearSchedulerDir();
  const t = createScheduledTask({ prompt: 'due now', intervalSec: 60, sessionId: 's1', fireImmediately: true });
  assert.ok(!('error' in t));

  const fired = [];
  const svc = startSchedulerService({ sessionId: 's1', enqueue: (x) => fired.push(x) });
  // Catch-up already fired it; an immediate second tick must not re-fire.
  assert.equal(svc.tick(), 0, 'not due again yet');
  svc.stop();
  assert.equal(fired.length, 1);
  clearSchedulerDir();
});

// ─── Input multiplexer ─────────────────────────────────────────────────────

test('multiplexer: injected input wins while base is parked; user input preserved', async () => {
  let resolveBase;
  const base = () => new Promise((res) => { resolveBase = res; });
  const mux = createInputMultiplexer(base);

  const first = mux.getUserInput();
  mux.enqueue('scheduled prompt');
  assert.equal(await first, 'scheduled prompt', 'queued item preempts parked base');

  const second = mux.getUserInput();
  resolveBase('typed by user');
  assert.equal(await second, 'typed by user', 'pending user input delivered at next boundary');
});

test('multiplexer: drains queue after base EOF, then signals end', async () => {
  const mux = createInputMultiplexer(async () => null);
  mux.enqueue('late item');
  assert.equal(await mux.getUserInput(), 'late item');
  assert.equal(await mux.getUserInput(), null);
});

test('multiplexer: priority enqueue jumps the line; empty strings dropped', async () => {
  const mux = createInputMultiplexer(async () => null);
  mux.enqueue('second');
  mux.enqueue('first', { priority: true });
  mux.enqueue('   ');
  assert.equal(await mux.getUserInput(), 'first');
  assert.equal(await mux.getUserInput(), 'second');
  assert.equal(await mux.getUserInput(), null);
  assert.equal(mux.pending(), 0);
});

// ─── Monitor registry ──────────────────────────────────────────────────────

const TASKS_DIR = path.join(TMP_HOME, '.blockrun', 'tasks');

function fakeTask(runId, { status = 'running', log = '' } = {}) {
  const dir = path.join(TASKS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    runId, runtime: 'detached-bash', label: runId, command: 'true', workingDir: '/tmp',
    status, createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(dir, 'log.txt'), log);
}

function appendLog(runId, text) {
  fs.appendFileSync(path.join(TASKS_DIR, runId, 'log.txt'), text);
}

test('monitor: sweep delivers only fresh lines, applies pattern filter', () => {
  resetMonitors();
  fakeTask('m1', { log: 'alpha 1\nnoise\nalpha 2\n' });
  registerMonitor({ taskRunId: 'm1', label: 'alpha watcher', pattern: /^alpha/ });

  const first = sweepMonitors();
  assert.equal(first.blocks.length, 1);
  assert.match(first.blocks[0], /\[monitor: alpha watcher\]/);
  assert.match(first.blocks[0], /alpha 1\nalpha 2/);
  assert.doesNotMatch(first.blocks[0], /noise/);

  const second = sweepMonitors();
  assert.equal(second.blocks.length, 0, 'no re-delivery of already-swept bytes');

  appendLog('m1', 'alpha 3\n');
  const third = sweepMonitors();
  assert.match(third.blocks[0], /alpha 3/);
  assert.doesNotMatch(third.blocks[0], /alpha 1/);
});

test('monitor: flood auto-pauses with a note', () => {
  resetMonitors();
  const flood = Array.from({ length: MAX_LINES_PER_SWEEP + 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fakeTask('m2', { log: flood });
  registerMonitor({ taskRunId: 'm2', label: 'flooder' });

  const result = sweepMonitors();
  assert.match(result.blocks[0], /auto-paused/);
  const entry = listMonitors().find(m => m.taskRunId === 'm2');
  assert.equal(entry.paused, true);
  assert.equal(sweepMonitors().blocks.length, 0, 'paused monitor delivers nothing');
});

test('monitor: ended task delivers final lines and is removed', () => {
  resetMonitors();
  fakeTask('m3', { status: 'succeeded', log: 'done line\n' });
  registerMonitor({ taskRunId: 'm3', label: 'finisher' });

  const result = sweepMonitors();
  assert.match(result.blocks[0], /done line/);
  assert.match(result.blocks[0], /monitored command ended: succeeded/);
  assert.equal(listMonitors().length, 0, 'ended monitor removed from registry');
});
