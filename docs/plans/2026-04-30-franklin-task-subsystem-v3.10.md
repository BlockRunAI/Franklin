# Franklin Task Subsystem (v3.10) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Franklin a real long-running-task subsystem. Agent kicks off a detached Bash command, returns a `runId` immediately, the work continues even if `franklin` exits or the user closes their terminal. Status, progress, log tail, cancel, and wait all work via `franklin task <subcmd>`.

**Architecture:** Mirrors the openclaw `src/tasks/` layer, scoped down for a CLI-first single-user product. Three layers:

1. **Persistence** (filesystem JSONL — matches existing `src/session/storage.ts` pattern, no new deps): every task gets a directory under `~/.franklin/tasks/<runId>/` with `meta.json` (TaskRecord), `events.jsonl` (append-only event log), `log.txt` (child process stdout/stderr).
2. **Runner** (`franklin _task-runner <runId>`): hidden subcommand that the agent spawns via `child_process.spawn(..., { detached: true })` + `unref()`. The runner spawns the user's actual command as its own child, pipes stdout/stderr into `log.txt`, writes heartbeat events into `events.jsonl`, finalizes meta.json on exit.
3. **Surface**: a new `Task` agent tool (LLM-facing) and a `franklin task list/tail/wait/cancel` CLI (human-facing). Both read/write the same on-disk shape.

**Tech Stack:** TypeScript ESM, Node 20 `node:child_process` + `node:fs/promises`, no new npm deps. Tests use the existing `node:test` harness in `test/local.mjs`.

**Out of scope for v3.10:** sqlite migration, multi-runtime (acp/cron), notification policy / multi-channel delivery, detached *agent loop* (only detached *Bash* in v3.10 — agent loop in subprocess is v3.11). System task daemon (`franklin daemon`) — runner is per-task self-contained.

**Worktree note:** This plan is saved on `main` after v3.9.6 release. Implementation should run in a dedicated worktree (`git worktree add ../brcc-task-subsystem -b feat/task-subsystem`) so v3.10 can soak before merge.

**Reference:** openclaw repo `src/tasks/task-registry.types.ts` for TaskRecord shape, `src/tasks/detached-task-runtime-contract.ts` for lifecycle interface, `src/tasks/task-status.ts` for terminal-message formatting. We're stripping channel/delivery concerns and keeping the persistence + lifecycle skeleton.

---

## Layer 1: Types and directory layout

### Task 1: TaskRecord type definitions

**Files:**
- Create: `src/tasks/types.ts`
- Test: `test/local.mjs` (append a new `test('TaskRecord types compile and round-trip JSON', ...)` block)

**Step 1: Write the failing test**

Append to `test/local.mjs` (under the existing `test(` blocks, before the final stats):

```js
test('TaskRecord types compile and round-trip JSON', async () => {
  const { isTerminalTaskStatus } = await import('../dist/tasks/types.js');
  assert.equal(isTerminalTaskStatus('succeeded'), true);
  assert.equal(isTerminalTaskStatus('failed'), true);
  assert.equal(isTerminalTaskStatus('cancelled'), true);
  assert.equal(isTerminalTaskStatus('timed_out'), true);
  assert.equal(isTerminalTaskStatus('lost'), true);
  assert.equal(isTerminalTaskStatus('running'), false);
  assert.equal(isTerminalTaskStatus('queued'), false);
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && npm test 2>&1 | grep -E "TaskRecord|fail" | head
```
Expected: `Cannot find module '../dist/tasks/types.js'` or similar.

**Step 3: Write minimal implementation**

`src/tasks/types.ts`:

```ts
/**
 * Task subsystem types. Mirrors openclaw/openclaw src/tasks/task-registry.types.ts
 * with channel/delivery fields stripped — Franklin is CLI-first single-user.
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'lost';

export type TaskRuntime = 'detached-bash';

export type TaskTerminalOutcome = 'succeeded' | 'blocked';

export type TaskEventKind = TaskStatus | 'progress';

export interface TaskEventRecord {
  at: number;
  kind: TaskEventKind;
  summary?: string;
}

export interface TaskRecord {
  runId: string;
  runtime: TaskRuntime;
  label: string;
  command: string;
  workingDir: string;
  pid?: number;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  exitCode?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
}

const TERMINAL = new Set<TaskStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'lost',
]);

export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return TERMINAL.has(s);
}
```

**Step 4: Run test to verify it passes**

```bash
npm run build && npm test 2>&1 | grep -E "TaskRecord|✔|✗" | head
```
Expected: `✔ TaskRecord types compile and round-trip JSON`.

**Step 5: Commit**

```bash
git add src/tasks/types.ts test/local.mjs
git commit -m "feat(tasks): TaskRecord types + isTerminalTaskStatus"
```

---

### Task 2: Task directory paths and creation

**Files:**
- Create: `src/tasks/paths.ts`
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('task paths: getTasksDir + ensureTaskDir + per-task paths', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { getTasksDir, ensureTaskDir, taskMetaPath, taskEventsPath, taskLogPath } =
    await import('../dist/tasks/paths.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  const orig = process.env.FRANKLIN_HOME;
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const dir = getTasksDir();
    assert.ok(dir.startsWith(fakeHome), `tasks dir under FRANKLIN_HOME: ${dir}`);

    const runId = 'abc12345';
    const taskDir = ensureTaskDir(runId);
    assert.ok(fs.existsSync(taskDir), 'task dir created');
    assert.ok(taskMetaPath(runId).endsWith('meta.json'));
    assert.ok(taskEventsPath(runId).endsWith('events.jsonl'));
    assert.ok(taskLogPath(runId).endsWith('log.txt'));
  } finally {
    if (orig === undefined) delete process.env.FRANKLIN_HOME;
    else process.env.FRANKLIN_HOME = orig;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && npm test 2>&1 | grep "task paths" | head
```
Expected: `Cannot find module '../dist/tasks/paths.js'`.

**Step 3: Write minimal implementation**

`src/tasks/paths.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function franklinHome(): string {
  return process.env.FRANKLIN_HOME || path.join(os.homedir(), '.franklin');
}

export function getTasksDir(): string {
  return path.join(franklinHome(), 'tasks');
}

export function getTaskDir(runId: string): string {
  return path.join(getTasksDir(), runId);
}

export function ensureTaskDir(runId: string): string {
  const dir = getTaskDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function taskMetaPath(runId: string): string {
  return path.join(getTaskDir(runId), 'meta.json');
}

export function taskEventsPath(runId: string): string {
  return path.join(getTaskDir(runId), 'events.jsonl');
}

export function taskLogPath(runId: string): string {
  return path.join(getTaskDir(runId), 'log.txt');
}
```

**Step 4: Run test to verify it passes**

```bash
npm run build && npm test 2>&1 | grep "task paths" | head
```
Expected: `✔ task paths: ...`.

**Step 5: Commit**

```bash
git add src/tasks/paths.ts test/local.mjs
git commit -m "feat(tasks): per-task directory layout under \$FRANKLIN_HOME/tasks"
```

---

## Layer 2: Store (meta + events I/O)

### Task 3: TaskRecord write/read

**Files:**
- Create: `src/tasks/store.ts`
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('task store: writeTaskMeta + readTaskMeta round-trip', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { writeTaskMeta, readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  const orig = process.env.FRANKLIN_HOME;
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = 'r' + Date.now().toString(36);
    const record = {
      runId,
      runtime: 'detached-bash',
      label: 'test',
      command: 'echo hi',
      workingDir: '/tmp',
      status: 'queued',
      createdAt: 1000,
    };
    writeTaskMeta(record);
    const round = readTaskMeta(runId);
    assert.deepEqual(round, record);
    assert.equal(readTaskMeta('does-not-exist'), null);
  } finally {
    if (orig === undefined) delete process.env.FRANKLIN_HOME;
    else process.env.FRANKLIN_HOME = orig;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && npm test 2>&1 | grep "task store: writeTaskMeta" | head
```
Expected: `Cannot find module '../dist/tasks/store.js'`.

**Step 3: Write minimal implementation**

`src/tasks/store.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord, TaskEventRecord } from './types.js';
import {
  ensureTaskDir,
  taskMetaPath,
  taskEventsPath,
  getTasksDir,
  getTaskDir,
} from './paths.js';

export function writeTaskMeta(record: TaskRecord): void {
  ensureTaskDir(record.runId);
  const target = taskMetaPath(record.runId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, target);
}

export function readTaskMeta(runId: string): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(taskMetaPath(runId), 'utf-8')) as TaskRecord;
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm run build && npm test 2>&1 | grep "task store: writeTaskMeta" | head
```
Expected: `✔`.

**Step 5: Commit**

```bash
git add src/tasks/store.ts test/local.mjs
git commit -m "feat(tasks): atomic writeTaskMeta + readTaskMeta"
```

---

### Task 4: Append-only event log + status transition helper

**Files:**
- Modify: `src/tasks/store.ts` (add appendTaskEvent, applyEvent)
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('task store: appendTaskEvent + applyEvent updates meta', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { writeTaskMeta, readTaskMeta, appendTaskEvent, readTaskEvents, applyEvent } =
    await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  const orig = process.env.FRANKLIN_HOME;
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = 'r1';
    writeTaskMeta({
      runId, runtime: 'detached-bash', label: 't', command: 'sleep 0',
      workingDir: '/tmp', status: 'queued', createdAt: 100,
    });

    appendTaskEvent(runId, { at: 200, kind: 'running', summary: 'started' });
    appendTaskEvent(runId, { at: 300, kind: 'progress', summary: '50%' });
    appendTaskEvent(runId, { at: 400, kind: 'succeeded', summary: 'done' });

    const events = readTaskEvents(runId);
    assert.equal(events.length, 3);
    assert.equal(events[0].kind, 'running');
    assert.equal(events[2].kind, 'succeeded');

    // applyEvent: progress event updates lastEventAt + progressSummary
    const after = applyEvent(runId, { at: 500, kind: 'progress', summary: 'more' });
    assert.equal(after.status, 'queued', 'progress does not change status');
    assert.equal(after.progressSummary, 'more');
    assert.equal(after.lastEventAt, 500);

    // applyEvent: terminal event sets endedAt + status + terminalSummary
    const term = applyEvent(runId, { at: 600, kind: 'succeeded', summary: 'wrapped up' });
    assert.equal(term.status, 'succeeded');
    assert.equal(term.endedAt, 600);
    assert.equal(term.terminalSummary, 'wrapped up');
  } finally {
    if (orig === undefined) delete process.env.FRANKLIN_HOME;
    else process.env.FRANKLIN_HOME = orig;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

```bash
npm run build && npm test 2>&1 | grep "appendTaskEvent" | head
```
Expected: `appendTaskEvent is not a function` or similar.

**Step 3: Write the implementation**

Add to `src/tasks/store.ts`:

```ts
export function appendTaskEvent(runId: string, event: TaskEventRecord): void {
  ensureTaskDir(runId);
  fs.appendFileSync(taskEventsPath(runId), JSON.stringify(event) + '\n');
}

export function readTaskEvents(runId: string): TaskEventRecord[] {
  try {
    const raw = fs.readFileSync(taskEventsPath(runId), 'utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as TaskEventRecord);
  } catch {
    return [];
  }
}

import { isTerminalTaskStatus } from './types.js';

export function applyEvent(runId: string, event: TaskEventRecord): TaskRecord {
  const cur = readTaskMeta(runId);
  if (!cur) throw new Error(`applyEvent: no task ${runId}`);
  const next: TaskRecord = { ...cur };
  next.lastEventAt = event.at;
  if (event.summary !== undefined) next.progressSummary = event.summary;

  if (event.kind === 'running' && next.status === 'queued') {
    next.status = 'running';
    next.startedAt = event.at;
  } else if (isTerminalTaskStatus(event.kind as never)) {
    next.status = event.kind as TaskRecord['status'];
    next.endedAt = event.at;
    if (event.summary !== undefined) next.terminalSummary = event.summary;
  }

  appendTaskEvent(runId, event);
  writeTaskMeta(next);
  return next;
}
```

**Step 4: Run test**

```bash
npm run build && npm test 2>&1 | grep "appendTaskEvent" | head
```
Expected: `✔`.

**Step 5: Commit**

```bash
git add src/tasks/store.ts test/local.mjs
git commit -m "feat(tasks): event log + applyEvent state-transition helper"
```

---

### Task 5: List all tasks (for `franklin task list`)

**Files:**
- Modify: `src/tasks/store.ts`
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('task store: listTasks returns all + sorts newest first', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { writeTaskMeta, listTasks } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  const orig = process.env.FRANKLIN_HOME;
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    writeTaskMeta({ runId: 'a', runtime: 'detached-bash', label: 'old', command: 'x',
                    workingDir: '/tmp', status: 'succeeded', createdAt: 100 });
    writeTaskMeta({ runId: 'b', runtime: 'detached-bash', label: 'mid', command: 'x',
                    workingDir: '/tmp', status: 'running', createdAt: 200 });
    writeTaskMeta({ runId: 'c', runtime: 'detached-bash', label: 'new', command: 'x',
                    workingDir: '/tmp', status: 'queued', createdAt: 300 });

    const tasks = listTasks();
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map(t => t.runId), ['c', 'b', 'a']);
  } finally {
    if (orig === undefined) delete process.env.FRANKLIN_HOME;
    else process.env.FRANKLIN_HOME = orig;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

```bash
npm run build && npm test 2>&1 | grep "listTasks" | head
```

**Step 3: Implement**

Add to `src/tasks/store.ts`:

```ts
export function listTasks(): TaskRecord[] {
  let entries: string[];
  try { entries = fs.readdirSync(getTasksDir()); } catch { return []; }
  const out: TaskRecord[] = [];
  for (const name of entries) {
    const meta = readTaskMeta(name);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/tasks/store.ts test/local.mjs
git commit -m "feat(tasks): listTasks (newest first)"
```

---

## Layer 3: Lost-task detection

### Task 6: PID liveness check + reconcileLostTasks

**Files:**
- Create: `src/tasks/lost-detection.ts`
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('lost-detection: running task with dead pid → marked lost', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { writeTaskMeta, readTaskMeta } = await import('../dist/tasks/store.js');
  const { reconcileLostTasks } = await import('../dist/tasks/lost-detection.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  const orig = process.env.FRANKLIN_HOME;
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    // Status=running, pid=999999 (almost certainly dead)
    writeTaskMeta({
      runId: 'lost1', runtime: 'detached-bash', label: 'x', command: 'x',
      workingDir: '/tmp', status: 'running', createdAt: 100,
      startedAt: 100, pid: 999999,
    });
    // Status=running, pid=current process (alive)
    writeTaskMeta({
      runId: 'alive1', runtime: 'detached-bash', label: 'y', command: 'y',
      workingDir: '/tmp', status: 'running', createdAt: 200,
      startedAt: 200, pid: process.pid,
    });
    // Status=succeeded, should be ignored
    writeTaskMeta({
      runId: 'done1', runtime: 'detached-bash', label: 'z', command: 'z',
      workingDir: '/tmp', status: 'succeeded', createdAt: 50,
    });

    reconcileLostTasks();

    assert.equal(readTaskMeta('lost1').status, 'lost');
    assert.equal(readTaskMeta('alive1').status, 'running');
    assert.equal(readTaskMeta('done1').status, 'succeeded');
  } finally {
    if (orig === undefined) delete process.env.FRANKLIN_HOME;
    else process.env.FRANKLIN_HOME = orig;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

`src/tasks/lost-detection.ts`:

```ts
import { listTasks, applyEvent } from './store.js';

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
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
    applyEvent(t.runId, {
      at: now,
      kind: 'lost',
      summary: 'Backing process not found — task may have been killed externally.',
    });
    n++;
  }
  return n;
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/tasks/lost-detection.ts test/local.mjs
git commit -m "feat(tasks): reconcileLostTasks via PID liveness check"
```

---

## Layer 4: The hidden runner subcommand

### Task 7: `franklin _task-runner <runId>` skeleton

**Files:**
- Create: `src/tasks/runner.ts`
- Modify: `src/index.ts` (register hidden subcommand)
- Test: append to `test/local.mjs`

The runner is what actually executes the user's command, after being spawned detached by the parent. It reads `meta.json`, spawns the command, pipes output to `log.txt`, writes events, finalizes on exit.

**Step 1: Write the failing test**

This is an integration test — run the built CLI, expect it to execute a one-shot command and finalize:

```js
test('runner: executes command, writes log, finalizes status=succeeded', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { writeTaskMeta, readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = 'runner-test-' + Date.now().toString(36);
    writeTaskMeta({
      runId, runtime: 'detached-bash',
      label: 'echo hi',
      command: 'printf hello-from-runner',
      workingDir: process.cwd(),
      status: 'queued', createdAt: Date.now(),
    });

    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync(process.execPath, [cli, '_task-runner', runId], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `runner exit: ${result.stderr}`);

    const meta = readTaskMeta(runId);
    assert.equal(meta.status, 'succeeded');
    assert.equal(meta.exitCode, 0);
    assert.ok(meta.startedAt);
    assert.ok(meta.endedAt);

    const log = fs.readFileSync(path.join(fakeHome, 'tasks', runId, 'log.txt'), 'utf-8');
    assert.match(log, /hello-from-runner/);
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

```bash
npm run build && npm test 2>&1 | grep "runner: executes" | head
```
Expected: command not found / unknown subcommand.

**Step 3: Implement runner**

`src/tasks/runner.ts`:

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readTaskMeta, applyEvent, writeTaskMeta } from './store.js';
import { taskLogPath, ensureTaskDir } from './paths.js';

export async function runDetachedTask(runId: string): Promise<number> {
  const meta = readTaskMeta(runId);
  if (!meta) {
    process.stderr.write(`runner: no task ${runId}\n`);
    return 2;
  }

  ensureTaskDir(runId);
  const logFd = fs.openSync(taskLogPath(runId), 'a');
  const startedAt = Date.now();
  writeTaskMeta({ ...meta, pid: process.pid, status: 'running', startedAt, lastEventAt: startedAt });
  applyEvent(runId, { at: startedAt, kind: 'running', summary: 'runner started' });

  const child = spawn('bash', ['-lc', meta.command], {
    cwd: meta.workingDir,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FRANKLIN_TASK_RUN_ID: runId },
  });

  // Heartbeat: every 5s while child is alive, refresh lastEventAt so
  // observers see "still going."
  const heartbeat = setInterval(() => {
    const cur = readTaskMeta(runId);
    if (!cur) return;
    writeTaskMeta({ ...cur, lastEventAt: Date.now() });
  }, 5_000);

  return await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      clearInterval(heartbeat);
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      const endedAt = Date.now();
      const log = (() => {
        try { return fs.readFileSync(taskLogPath(runId), 'utf-8'); } catch { return ''; }
      })();
      const tail = log.slice(-500).replace(/\s+/g, ' ').trim();
      const exitCode = typeof code === 'number' ? code : (signal ? 128 : 1);
      const status = exitCode === 0 ? 'succeeded' : 'failed';
      const cur = readTaskMeta(runId);
      if (cur) {
        writeTaskMeta({ ...cur, exitCode });
      }
      applyEvent(runId, {
        at: endedAt, kind: status,
        summary: tail || (status === 'succeeded' ? 'completed' : `exited with code ${exitCode}`),
      });
      resolve(exitCode);
    });
  });
}
```

Add to `src/index.ts` (alongside other `.command(...)` registrations — keep it hidden by adding `.helpOption(false)` if needed, but a vanilla command is fine since the underscore prefix signals private):

```ts
import { runDetachedTask } from './tasks/runner.js';

// ... after other commands ...
program
  .command('_task-runner <runId>')
  .description('(internal) execute a detached task by runId')
  .action(async (runId: string) => {
    const code = await runDetachedTask(runId);
    process.exit(code);
  });
```

**Step 4: Run test**

```bash
npm run build && npm test 2>&1 | grep "runner: executes" | head
```
Expected: `✔`.

**Step 5: Commit**

```bash
git add src/tasks/runner.ts src/index.ts test/local.mjs
git commit -m "feat(tasks): _task-runner subcommand executes detached commands"
```

---

### Task 8: Runner failure path

**Files:**
- Test only: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('runner: nonzero exit → status=failed + tail captured', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { writeTaskMeta, readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = 'fail-test-' + Date.now().toString(36);
    writeTaskMeta({
      runId, runtime: 'detached-bash',
      label: 'fail', command: 'echo oops; exit 17',
      workingDir: process.cwd(),
      status: 'queued', createdAt: Date.now(),
    });
    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync(process.execPath, [cli, '_task-runner', runId], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome }, timeout: 10_000,
    });
    assert.equal(result.status, 17, 'runner propagates exit code');

    const meta = readTaskMeta(runId);
    assert.equal(meta.status, 'failed');
    assert.equal(meta.exitCode, 17);
    assert.match(meta.terminalSummary, /oops/);
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test (should pass already if runner is correct)**

```bash
npm run build && npm test 2>&1 | grep "runner: nonzero" | head
```
If FAIL: read the actual meta state; the fix is in `src/tasks/runner.ts` exit-code propagation.

**Step 3:** N/A if pass. If fail, fix runner exit code mapping.

**Step 4–5: Commit**

```bash
git add test/local.mjs
git commit -m "test(tasks): runner failure-path coverage"
```

---

## Layer 5: Detached spawn helper

### Task 9: `startDetachedTask` — the public spawn surface

**Files:**
- Create: `src/tasks/spawn.ts`
- Test: append to `test/local.mjs`

This is what the `Task` agent tool and any caller uses. It writes the queued meta, spawns `franklin _task-runner <runId>` detached + unrefed, returns the runId without blocking.

**Step 1: Write the failing test**

```js
test('startDetachedTask: returns runId immediately, child completes async', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { startDetachedTask } = await import('../dist/tasks/spawn.js');
  const { readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const t0 = Date.now();
    const runId = startDetachedTask({
      label: 'sleep-then-write',
      command: 'sleep 0.3; printf detached-ok > out.txt',
      workingDir: fakeHome,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `startDetachedTask returned in ${elapsed}ms (should be <250)`);

    // Initial meta exists
    const meta = readTaskMeta(runId);
    assert.ok(meta);
    assert.equal(meta.status === 'queued' || meta.status === 'running', true);

    // Wait for completion
    await new Promise(r => setTimeout(r, 1500));
    const final = readTaskMeta(runId);
    assert.equal(final.status, 'succeeded');
    assert.ok(fs.existsSync(path.join(fakeHome, 'out.txt')), 'child wrote output');
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

`src/tasks/spawn.ts`:

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeTaskMeta } from './store.js';
import { taskLogPath, ensureTaskDir } from './paths.js';
import type { TaskRecord } from './types.js';

export interface StartDetachedTaskInput {
  label: string;
  command: string;
  workingDir: string;
}

export function startDetachedTask(input: StartDetachedTaskInput): string {
  const runId = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
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

  // Resolve our own CLI entry. dist/index.js is the published binary;
  // when running via `npm test` from source we resolve relative to
  // process.cwd(); the env var FRANKLIN_CLI_PATH wins for tests / dev.
  const cliPath = process.env.FRANKLIN_CLI_PATH
    ?? path.resolve(process.cwd(), 'dist', 'index.js');

  ensureTaskDir(runId);
  const logFd = fs.openSync(taskLogPath(runId), 'a');
  const child = spawn(process.execPath, [cliPath, '_task-runner', runId], {
    cwd: input.workingDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FRANKLIN_TASK_RUN_ID: runId },
  });
  child.unref();
  try { fs.closeSync(logFd); } catch { /* ignore */ }
  return runId;
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/tasks/spawn.ts test/local.mjs
git commit -m "feat(tasks): startDetachedTask spawns _task-runner detached + unrefed"
```

---

## Layer 6: CLI surface

### Task 10: `franklin task list`

**Files:**
- Create: `src/commands/task.ts` (will grow with subcommands)
- Modify: `src/index.ts` (register `task` parent command)
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('cli: franklin task list prints recent tasks', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { writeTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    writeTaskMeta({ runId: 't1', runtime: 'detached-bash', label: 'first',
                    command: 'true', workingDir: '/tmp', status: 'succeeded',
                    createdAt: 100 });
    writeTaskMeta({ runId: 't2', runtime: 'detached-bash', label: 'second',
                    command: 'true', workingDir: '/tmp', status: 'running',
                    createdAt: 200 });

    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync(process.execPath, [cli, 'task', 'list'], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr.toString());
    const out = result.stdout.toString();
    assert.match(out, /t2/);
    assert.match(out, /t1/);
    assert.match(out, /running/);
    assert.match(out, /succeeded/);
    assert.ok(out.indexOf('t2') < out.indexOf('t1'), 'newest first');
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

`src/commands/task.ts`:

```ts
import { Command } from 'commander';
import { listTasks } from '../tasks/store.js';
import { reconcileLostTasks } from '../tasks/lost-detection.js';

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function buildTaskCommand(): Command {
  const cmd = new Command('task').description('Manage long-running detached tasks');

  cmd.command('list')
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

  return cmd;
}
```

`src/index.ts`:

```ts
import { buildTaskCommand } from './commands/task.js';
// ...
program.addCommand(buildTaskCommand());
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/commands/task.ts src/index.ts test/local.mjs
git commit -m "feat(cli): franklin task list"
```

---

### Task 11: `franklin task tail <runId>`

**Files:**
- Modify: `src/commands/task.ts`
- Test: append to `test/local.mjs`

`tail` should: print existing log + final meta if terminal, OR print existing log + follow if running.

For v3.10 keep it dead simple — print the current log + current status. `--follow / -f` flag does naive 1-second polling.

**Step 1: Write the failing test**

```js
test('cli: franklin task tail <runId> prints log + status', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { writeTaskMeta } = await import('../dist/tasks/store.js');
  const { ensureTaskDir, taskLogPath } = await import('../dist/tasks/paths.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = 'tail-test';
    writeTaskMeta({ runId, runtime: 'detached-bash', label: 'tail',
                    command: 'true', workingDir: '/tmp',
                    status: 'succeeded', createdAt: 100, endedAt: 200,
                    terminalSummary: 'all good' });
    ensureTaskDir(runId);
    fs.writeFileSync(taskLogPath(runId), 'line1\nline2\n');

    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync(process.execPath, [cli, 'task', 'tail', runId], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr.toString());
    const out = result.stdout.toString();
    assert.match(out, /line1/);
    assert.match(out, /line2/);
    assert.match(out, /succeeded/);
    assert.match(out, /all good/);
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

Add to `src/commands/task.ts`:

```ts
import fs from 'node:fs';
import { readTaskMeta } from '../tasks/store.js';
import { taskLogPath } from '../tasks/paths.js';
import { isTerminalTaskStatus } from '../tasks/types.js';

// inside buildTaskCommand:
cmd.command('tail <runId>')
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
          process.stdout.write(buf.slice(printed));
          printed = buf.length;
        }
      } catch { /* log not yet */ }
    };
    printNew();
    if (opts.follow) {
      while (true) {
        await new Promise(r => setTimeout(r, 1000));
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
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/commands/task.ts test/local.mjs
git commit -m "feat(cli): franklin task tail <runId> [--follow]"
```

---

### Task 12: `franklin task cancel <runId>`

**Files:**
- Modify: `src/commands/task.ts`
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('cli: franklin task cancel <runId> kills running task', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { startDetachedTask } = await import('../dist/tasks/spawn.js');
  const { readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = startDetachedTask({
      label: 'sleep-long', command: 'sleep 30', workingDir: fakeHome,
    });
    // Wait briefly so runner records its own pid
    await new Promise(r => setTimeout(r, 800));

    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const result = spawnSync(process.execPath, [cli, 'task', 'cancel', runId], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr.toString());

    // Give runner a moment to finalize
    await new Promise(r => setTimeout(r, 1500));
    const meta = readTaskMeta(runId);
    assert.ok(['cancelled', 'failed', 'lost'].includes(meta.status), `status: ${meta.status}`);
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

Cancel needs two parts:
1. The CLI sends SIGTERM to the runner pid + flips status to `cancelled` if runner is unresponsive.
2. The runner needs a SIGTERM handler that flushes a `cancelled` event and kills its child.

Add to `src/tasks/runner.ts` (inside `runDetachedTask`, after creating `child`):

```ts
const onSigterm = () => {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  applyEvent(runId, {
    at: Date.now(), kind: 'cancelled',
    summary: 'Cancelled via SIGTERM',
  });
  setTimeout(() => process.exit(130), 500);
};
process.on('SIGTERM', onSigterm);
process.on('SIGINT', onSigterm);
```

Add to `src/commands/task.ts`:

```ts
cmd.command('cancel <runId>')
  .description('Cancel a running task (SIGTERM to runner)')
  .action((runId: string) => {
    const meta = readTaskMeta(runId);
    if (!meta) { console.error(`No task: ${runId}`); process.exit(1); }
    if (isTerminalTaskStatus(meta.status)) {
      console.log(`Task already ${meta.status}.`);
      return;
    }
    if (typeof meta.pid !== 'number') {
      console.error('Task has no recorded pid (likely still queued).');
      process.exit(1);
    }
    try { process.kill(meta.pid, 'SIGTERM'); console.log(`SIGTERM sent to ${meta.pid}.`); }
    catch (err) {
      console.error(`Could not signal pid ${meta.pid}: ${(err as Error).message}`);
      process.exit(1);
    }
  });
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/tasks/runner.ts src/commands/task.ts test/local.mjs
git commit -m "feat(tasks+cli): SIGTERM-based cancel"
```

---

### Task 13: `franklin task wait <runId>`

**Files:**
- Modify: `src/commands/task.ts`
- Test: append to `test/local.mjs`

`wait` blocks until the task hits a terminal state, prints terminalSummary, exits 0/1 by status.

**Step 1: Write the failing test**

```js
test('cli: franklin task wait <runId> blocks until terminal', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { startDetachedTask } = await import('../dist/tasks/spawn.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const runId = startDetachedTask({
      label: 'short', command: 'sleep 0.5; echo done',
      workingDir: fakeHome,
    });

    const cli = path.join(process.cwd(), 'dist', 'index.js');
    const t0 = Date.now();
    const result = spawnSync(process.execPath, [cli, 'task', 'wait', runId], {
      env: { ...process.env, FRANKLIN_HOME: fakeHome }, timeout: 10_000,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.status, 0, result.stderr.toString());
    assert.ok(elapsed >= 400, `wait actually waited (${elapsed}ms)`);
    assert.match(result.stdout.toString(), /succeeded/);
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

```ts
cmd.command('wait <runId>')
  .description('Block until task reaches terminal state, then exit')
  .option('--timeout <ms>', 'Max wait, default 30 minutes', '1800000')
  .action(async (runId: string, opts: { timeout: string }) => {
    const cap = parseInt(opts.timeout, 10);
    const t0 = Date.now();
    while (true) {
      const meta = readTaskMeta(runId);
      if (!meta) { console.error(`No task: ${runId}`); process.exit(1); }
      if (isTerminalTaskStatus(meta.status)) {
        console.log(`${meta.status}: ${meta.terminalSummary ?? ''}`);
        process.exit(meta.status === 'succeeded' ? 0 : 1);
      }
      if (Date.now() - t0 > cap) {
        console.error(`Timed out after ${cap}ms; task still ${meta.status}.`);
        process.exit(2);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  });
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/commands/task.ts test/local.mjs
git commit -m "feat(cli): franklin task wait <runId> [--timeout ms]"
```

---

## Layer 7: The agent-facing tool

### Task 14: `Task` capability — LLM-facing tool

**Files:**
- Create: `src/tools/task.ts`
- Modify: `src/tools/index.ts` (register the tool)
- Test: append to `test/local.mjs`

**Step 1: Write the failing test**

```js
test('Task tool: kicks off detached task, returns runId in output', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { taskCapability } = await import('../dist/tools/task.js');
  const { readTaskMeta } = await import('../dist/tasks/store.js');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-tasks-'));
  process.env.FRANKLIN_HOME = fakeHome;
  try {
    const result = await taskCapability.execute(
      { label: 'tool-test', command: 'echo done > marker.txt' },
      { workingDir: fakeHome, abortSignal: new AbortController().signal },
    );
    assert.ok(!result.isError, result.output);
    const m = result.output.match(/runId: (\S+)/);
    assert.ok(m, `output missing runId: ${result.output}`);
    const runId = m[1];

    // Poll up to 5s for completion
    for (let i = 0; i < 50; i++) {
      const meta = readTaskMeta(runId);
      if (meta && (meta.status === 'succeeded' || meta.status === 'failed')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const final = readTaskMeta(runId);
    assert.equal(final.status, 'succeeded');
    assert.ok(fs.existsSync(path.join(fakeHome, 'marker.txt')));
  } finally {
    delete process.env.FRANKLIN_HOME;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
```

**Step 2: Run test, verify fail**

**Step 3: Implement**

`src/tools/task.ts`:

```ts
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { startDetachedTask } from '../tasks/spawn.js';

interface TaskInput {
  label: string;
  command: string;
}

async function execute(
  input: Record<string, unknown>,
  ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { label, command } = input as unknown as TaskInput;
  if (!label || !command) {
    return { output: 'Error: label and command are required', isError: true };
  }
  const runId = startDetachedTask({ label, command, workingDir: ctx.workingDir });
  return {
    output:
      `Detached task started.\n` +
      `runId: ${runId}\n` +
      `label: ${label}\n` +
      `command: ${command}\n\n` +
      `Inspect with:\n` +
      `  franklin task tail ${runId} --follow\n` +
      `  franklin task wait ${runId}\n` +
      `  franklin task cancel ${runId}\n`,
  };
}

export const taskCapability: CapabilityHandler = {
  spec: {
    name: 'Task',
    description:
      "Run a Bash command as a detached background task. Returns immediately " +
      "with a runId. The command continues even if Franklin exits or the user " +
      "closes their terminal. Use this for any iteration over more than ~20 " +
      "items, large data fetches, paginated API loops, or anything you'd " +
      "otherwise loop on turn-by-turn (which would burn turns and trip " +
      "timeouts). The agent's job is to design and orchestrate, not to be " +
      "the for-loop. Pair with a script that writes a checkpoint file so " +
      "progress survives restarts. Tail logs with `franklin task tail " +
      "<runId> --follow` and check completion with `franklin task wait " +
      "<runId>`.",
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short human-readable label, e.g. "scrape stargazers"' },
        command: { type: 'string', description: 'Bash command to run. Will be executed via `bash -lc`.' },
      },
      required: ['label', 'command'],
    },
  },
  execute,
  concurrent: true,
};
```

Register in `src/tools/index.ts` alongside the other capabilities (find where `bashCapability` etc. are exported and add `taskCapability` to the same surface).

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add src/tools/task.ts src/tools/index.ts test/local.mjs
git commit -m "feat(tools): Task capability — agent kicks off detached background work"
```

---

## Layer 8: System prompt update

### Task 15: Update tool-patterns guidance to reference the Task tool

**Files:**
- Modify: `src/agent/context.ts:getToolPatternsSection` (replace v3.9.6's nudge with concrete Task-tool guidance)

**Step 1: Read the current section**

The relevant block is the `Long-running iteration (>20 items)` bullet added in v3.9.6.

**Step 2: Replace the bullet**

Edit `src/agent/context.ts`:

```diff
-- **Long-running iteration (>20 items)**: Do NOT loop in the agent (one tool call per item burns turns and trips timeouts on the 21st item). Instead: Write a script (Node/Bash/Python), have it iterate with a checkpoint file (\`./.franklin/<task>.checkpoint.json\` storing cursor + processedCount), then Bash it once. The agent re-engages only on errors or completion. Pattern fits paginated APIs, batch enrichment, large CSV emit, anything where the loop body is deterministic. The agent's job is to design and orchestrate, not to be the for-loop.
++ **Long-running iteration (>20 items)**: Use the **Task** tool, not turn-by-turn loops. Write a script that iterates and persists a checkpoint file (e.g. \`./.franklin/<task>.checkpoint.json\` with cursor + processedCount), then start it via Task — \`{ label: "scrape stargazers", command: "node fetch.mjs" }\`. Task returns a runId immediately and the work continues even if Franklin exits. Inspect with \`franklin task tail <runId> --follow\` / \`task wait <runId>\` / \`task cancel <runId>\`. The agent's job is to design and orchestrate, not to be the for-loop. Pattern fits paginated APIs, batch enrichment, large CSV emit, anything where the loop body is deterministic.
```

**Step 3: Build and run full suite**

```bash
npm run build && npm test 2>&1 | tail -8
```
Expected: 239+ tests pass.

**Step 4: Commit**

```bash
git add src/agent/context.ts
git commit -m "feat(prompt): point long-task guidance at the new Task tool"
```

---

## Layer 9: Release

### Task 16: Bump version, write CHANGELOG, ship

**Files:**
- Modify: `package.json` → 3.10.0
- Modify: `CHANGELOG.md` (prepend new entry)

**Step 1: Bump version**

```ts
// package.json
"version": "3.10.0",
```

**Step 2: CHANGELOG entry**

Prepend:

```markdown
## 3.10.0 — Detached background tasks (Task tool + `franklin task` CLI)

The agent's job is to design and orchestrate. The for-loop is somebody
else's problem. v3.10 adds that somebody.

### What's new

- New **Task** agent tool: `{ label, command }` → detached Bash child
  process spawned via `franklin _task-runner <runId>`. Returns a
  `runId` immediately. Survives the parent Franklin process — close
  your terminal, the work continues.
- New **`franklin task`** CLI surface:
  - `task list` — newest first, with status + age
  - `task tail <runId> [--follow]` — print log + final status
  - `task wait <runId> [--timeout ms]` — block until terminal
  - `task cancel <runId>` — SIGTERM the runner
- Persistence under `~/.franklin/tasks/<runId>/` (no new dependencies):
  `meta.json` (TaskRecord), `events.jsonl` (append-only event log),
  `log.txt` (child stdout/stderr).
- Lazy lost-task detection — `task list` checks `process.kill(pid, 0)`
  on still-`running` tasks and marks them `lost` if the backing pid
  is gone.
- System prompt updated to point long-task guidance at the new tool.

### Why

Franklin used to drag the LLM through every iteration of long work
(40k stargazer enrichment, large refactors, multi-page scrapes), one
tool call per item. That burned turns, hit TTFB walls (v3.9.6 raised
those defaults to 180s as a bandaid), and tied the work's life to the
foreground session.

The Task tool inverts that: the LLM writes a script, hands it to
`Task`, gets a runId, and is free. The script does the iteration with
a checkpoint file. Franklin restarts have no effect on the work.

### Out of scope (deliberate)

- `acp` / cron / multi-runtime — only `detached-bash` for now.
  Detached *agent loop* in subprocess is v3.11.
- sqlite migration — flat JSONL/JSON mirrors `src/session/storage.ts`,
  good enough for thousands of tasks. Switch if `task list` ever
  takes >100ms.
- Notification policy / multi-channel delivery — CLI-first single-user
  product polls. Add when we wire up Telegram/Discord adapters.

Reference: openclaw/openclaw `src/tasks/`. We took the persistence +
lifecycle skeleton, dropped channel/delivery and multi-runtime.
```

**Step 3: Build, run all tests**

```bash
npm run build && npm test 2>&1 | tail -8
```
Expected: all green.

**Step 4: Commit, tag, push, publish**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release v3.10.0 — detached background tasks (Task tool + franklin task CLI)"
git tag v3.10.0
git push origin main && git push origin v3.10.0
npm publish --access public
```

**Step 5: Verify**

```bash
rtk proxy curl -sS 'https://registry.npmjs.org/@blockrun%2Ffranklin/latest' | python3 -c "import sys,json; d=json.load(sys.stdin); print('latest =', d.get('version'))"
```
Expected: `latest = 3.10.0`.

---

## Verification checklist (post-implementation)

Before shipping v3.10.0, run a real-world soak:

- [ ] Spawn a 5-minute task (`sleep 300; echo done`), `kill -9` the parent franklin, verify `franklin task list` still shows it as `running`, then verify the task completes after 5 min and `task tail` shows `succeeded`.
- [ ] Spawn a failing task (`exit 17`), verify `task list` shows `failed`, `task tail` includes the stderr tail.
- [ ] Spawn a task, immediately `task cancel`, verify status flips to `cancelled` within 2s.
- [ ] Spawn a task, kill its runner pid externally, run `task list`, verify it transitions to `lost`.
- [ ] In an interactive Franklin session with GLM-5.1, ask it to "scrape my repo's stargazers and write a CSV with email + crypto-experience flag." Verify it writes a script and uses the Task tool — not 40k tool calls.
- [ ] `npm test` — 239 pre-existing tests pass + ~12 new tests pass.

---

## Risk notes

- **Detached spawn on Windows**: `child.unref()` semantics differ; we ship Node 20+ on macOS/Linux primarily. If a Windows user reports orphan-child issues, switch to `windowsHide: true, detached: true` and document the gap.
- **`bash -lc` portability**: requires bash. macOS default zsh is fine because we explicitly invoke `bash`. If a user has no bash (rare on dev machines), Task fails with a clear "spawn bash ENOENT" error.
- **Disk usage**: tasks accumulate under `~/.franklin/tasks/`. v3.10 does not auto-clean. Add a `task gc` subcommand in v3.10.1 if disk usage complaints surface. Manual workaround: `rm -rf ~/.franklin/tasks/<old-runId>`.
- **PID reuse**: in theory the OS could reuse a dead pid for another process; lost-detection would then incorrectly say "still alive." Window is small and v3.10's lost-detection is best-effort. v3.11 can add a `pidStartTime` cross-check.
