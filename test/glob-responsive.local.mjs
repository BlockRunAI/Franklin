// Offline regression: a recursive file search must not block Desktop Skills RPC.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { globCapability } from '../dist/tools/glob.js';

const scope = (workingDir, abortSignal = new AbortController().signal) => ({ workingDir, abortSignal });

test('Skills list responds while a slow recursive Glob is running, and search can be cancelled', { timeout: 20000 }, async (t) => {
  // macOS /var is an alias for /private/var; use one canonical test home so
  // symlink-policy assertions compare the same home path as realpath().
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-skills-glob-')));
  const scan = path.join(temp, 'scan');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(scan); fs.mkdirSync(workspace);
  for (let i = 0; i < 100; i++) {
    fs.mkdirSync(path.join(scan, `directory-${i}`));
    fs.writeFileSync(path.join(scan, `file-${i}.txt`), 'fixture');
  }
  const skillDir = path.join(temp, '.blockrun', 'skills', 'facticity-factcheck');
  fs.mkdirSync(skillDir, { recursive: true });
  const instructions = '---\nname: facticity-factcheck\ndescription: Local response test\n---\nUse the available fact-checking tools.\n';
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), instructions);
  // Synthetic credentials in the isolated child home; no real keys are read.
  const keyFile = path.join(temp, '.blockrun', 'api-key');
  const sshFile = path.join(temp, '.ssh', 'id_rsa');
  fs.mkdirSync(path.dirname(sshFile));
  fs.writeFileSync(keyFile, 'test-only-placeholder'); fs.writeFileSync(sshFile, 'test-only-placeholder');
  fs.symlinkSync(keyFile, path.join(scan, 'wallet-alias.txt'), 'file');
  fs.symlinkSync(sshFile, path.join(scan, 'host-alias.txt'), 'file');
  const child = fork(new URL('./fixtures/skills-during-glob.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: temp, USERPROFILE: temp,
      APPDATA: path.join(temp, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(temp, 'AppData', 'Local'),
      FRANKLIN_TEST_SCAN_ROOT: scan, FRANKLIN_TEST_WORK_DIR: workspace,
      FRANKLIN_SERVE_TOKEN: 'skills-glob-fixture-only', FRANKLIN_CATALOG_OFFLINE: '1',
      FRANKLIN_CLOUD_SYNC: 'off', FRANKLIN_SERVE_DISCOVERY: 'off' },
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const message = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${type} timeout: ${stderr}`)); }, 10000);
    const listener = (value) => { if (value.type === type) { cleanup(); resolve(value); } };
    const exit = (code) => { cleanup(); reject(new Error(`Child exited ${code}: ${stderr}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', listener); child.off('exit', exit); }
    child.on('message', listener); child.once('exit', exit);
  });
  const ready = await message('franklin:server-ready');
  socket = new WebSocket(`ws://127.0.0.1:${ready.port}/agent?token=skills-glob-fixture-only`);
  await once(socket, 'open');
  let seq = 0;
  const rpc = (kind, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const id = `check-${++seq}`;
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error(`Request ${kind} timed out`)); }, timeoutMs);
    function listener(raw) {
      const response = JSON.parse(String(raw));
      if (response.id !== id) return;
      clearTimeout(timer); socket.off('message', listener);
      if (response.kind === 'error') reject(new Error(response.payload.message)); else resolve(response.payload);
    }
    socket.on('message', listener); socket.send(JSON.stringify({ id, kind }));
  });
  assert.ok((await rpc('skills.list')).skills.some((skill) => skill.name === 'facticity-factcheck'));
  const started = message('search-started');
  const finished = message('search-finished');
  let searchFinished = false;
  void finished.then(() => { searchFinished = true; }, () => {});
  child.send({ type: 'start-search' });
  await started;
  // The 100-directory fixture takes >1s. A 500ms deadline makes starvation
  // deterministic without waiting for the renderer's production 30s timeout.
  const during = await rpc('skills.list', 500);
  assert.ok(during.skills.some((skill) => skill.name === 'facticity-factcheck'));
  assert.equal(searchFinished, false, 'Skills responded before the search finished');
  child.send({ type: 'cancel-search' });
  const cancelled = await finished;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.output, /cancel/i);
  assert.ok((await rpc('skills.list')).skills.some((skill) => skill.name === 'facticity-factcheck'));
  // Matching files used to perform synchronous credential realpath checks too.
  const fileStarted = message('file-search-started');
  const fileFinished = message('search-finished');
  child.send({ type: 'start-search', pattern: '*.txt' });
  await fileStarted;
  assert.ok((await rpc('skills.list', 500)).skills.some((skill) => skill.name === 'facticity-factcheck'));
  child.send({ type: 'cancel-search' });
  assert.equal((await fileFinished).result.isError, true);
  const protectedSearch = message('search-finished');
  child.send({ type: 'start-search', pattern: '*alias.txt' });
  assert.match((await protectedSearch).result.output, /^No files matched/);
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), instructions);
});

test('Glob preserves recursive matching, exclusions, symlink-loop handling and newest-first order', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-glob-matches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'nested/scripts', 'node_modules/scripts', '__pycache__/scripts', '.hidden/scripts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'factcheck.py'), 'fixture');
  }
  const older = path.join(root, 'scripts/factcheck.py');
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.symlinkSync(root, path.join(root, 'nested', 'loop'), 'junction');
  const result = await globCapability.execute({ pattern: '**/scripts/factcheck.py' }, scope(root));
  assert.deepEqual(result.output.replace(/\\/g, '/').split('\n'), ['nested/scripts/factcheck.py', 'scripts/factcheck.py']);
});

test('Glob still limits returned matches and reports cancellation before scanning', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-glob-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(root, `file-${i}.txt`), 'fixture');
  const result = await globCapability.execute({ pattern: '*.txt' }, scope(root));
  assert.match(result.output, /limited to 200 results/);
  assert.equal((result.output.match(/file-\d+\.txt/g) || []).length, 200);
  const controller = new AbortController(); controller.abort();
  const cancelled = await globCapability.execute({ pattern: '**/*' }, scope(root, controller.signal));
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.output, /cancel/i);
});
