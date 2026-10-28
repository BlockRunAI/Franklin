// Validate the shipped runtime outside the checkout: no ancestor node_modules,
// user credentials, inference or trading. Runs with Electron's embedded Node.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qa = await fs.mkdtemp(path.join(os.tmpdir(), 'franklin-packaged-runtime-'));
const mac = process.platform === 'darwin';
const source = process.env.FRANKLIN_TEST_PACKAGE_DIR || path.join(desktop, 'release', mac ? 'mac-arm64/Franklin.app' : 'win-unpacked');
const staged = path.join(qa, mac ? 'Franklin.app' : 'app');
await fs.cp(source, staged, { recursive: true, verbatimSymlinks: true });
const exe = mac ? path.join(staged, 'Contents/MacOS/Franklin') : path.join(staged, 'Franklin.exe');
const asar = mac ? path.join(staged, 'Contents/Resources/app.asar') : path.join(staged, 'resources/app.asar');
await fs.access(exe);
const updaterProbe = path.join(qa, 'updater-probe.cjs');
await fs.writeFile(updaterProbe, `
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const fs = require('node:fs');
const requireApp = createRequire(${JSON.stringify(path.join(asar, 'package.json'))});
const updater = requireApp('electron-updater');
assert.equal(typeof updater.MacUpdater, 'function');
assert.equal(typeof updater.NsisUpdater, 'function');
const yaml = requireApp('yaml');
const config = yaml.parse(fs.readFileSync(${JSON.stringify(path.join(path.dirname(asar), 'app-update.yml'))}, 'utf8'));
assert.equal(config.provider, 'generic');
assert.equal(config.channel, 'latest');
assert.match(config.url, /^https:\\/\\/github\\.com\\/BlockRunAI\\/Franklin\\/releases\\/download\\/desktop-v/);
console.log('PASS isolated packaged updater dependency graph and metadata');
`);
await new Promise((resolve, reject) => {
  const probe = spawn(exe, [updaterProbe], {
    cwd: qa, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: qa, USERPROFILE: qa, TMP: qa, TEMP: qa, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; probe.stdout.on('data', data => { output += data; }); probe.stderr.on('data', data => { output += data; });
  probe.once('error', reject); probe.once('exit', code => code === 0 ? (console.log(output.trim()), resolve()) : reject(new Error(output)));
});
const workspace = path.join(qa, 'workspace'); await fs.mkdir(workspace);
const token = 'qa-packaged-runtime-only';
const child = spawn(exe, [path.join(asar, 'franklin-agent/dist/index.js'), 'serve', '--port', '0', '--work-dir', workspace], {
  cwd: workspace,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TMP: qa, TEMP: qa, TMPDIR: qa, HOME: qa, USERPROFILE: qa,
    ELECTRON_RUN_AS_NODE: '1', FRANKLIN_SERVE_TOKEN: token,
    FRANKLIN_SERVE_DISCOVERY: 'off', FRANKLIN_CLOUD_SYNC: 'off', FRANKLIN_CATALOG_OFFLINE: '1',
    FRANKLIN_DESKTOP_WORKSPACE_BOUNDARY: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let log = ''; child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
let socket;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged server ready timeout\n' + log)), 25000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Packaged server exited ${code}\n${log}`)); });
    child.on('message', (msg) => { if (msg.type === 'franklin:server-ready') { clearTimeout(timer); resolve(msg.port); } });
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let seq = 0;
  const rpc = (kind, payload) => new Promise((resolve, reject) => {
    assert.ok(kind.startsWith('skills.'), 'Only zero-cost Skills management is permitted');
    const id = String(++seq);
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('RPC timeout: ' + kind)); }, 5000);
    function listener(raw) {
      const msg = JSON.parse(String(raw)); if (msg.id !== id) return;
      clearTimeout(timer); socket.off('message', listener);
      if (msg.kind === 'error') reject(new Error(msg.payload.message)); else resolve(msg.payload);
    }
    socket.on('message', listener); socket.send(JSON.stringify({ id, kind, payload }));
  });
  const before = await rpc('skills.list'); assert.ok(before.skills.some((s) => s.name === 'budget-grill'));
  const content = await fs.readFile(path.join(desktop, '../../test/fixtures/openclaw-weather/SKILL.md'), 'utf8');
  assert.equal((await rpc('skills.upload', { content })).name, 'weather');
  assert.ok((await rpc('skills.list')).skills.some((s) => s.name === 'weather' && s.source === 'user'));
  assert.match((await rpc('skills.resolve', { input: '/weather Reykjavik tomorrow' })).prompt, /User request:\nReykjavik tomorrow$/);
  await rpc('skills.toggle', { name: 'weather', enabled: false });
  await assert.rejects(rpc('skills.resolve', { input: '/weather Reykjavik' }), /disabled/);
  await rpc('skills.remove', { name: 'weather' });
  assert.ok(!(await rpc('skills.list')).skills.some((s) => s.name === 'weather'));
  const result = { platform: process.platform, packageSource: source, stagedOutsideCheckout: true,
    passed: ['runtime startup', 'bundled registry', 'public API Skill import', 'list refresh', 'slash resolution', 'persistent disable', 'removal'], inferenceSends: 0 };
  await fs.writeFile(path.join(qa, 'results.json'), JSON.stringify(result, null, 2));
  console.log('PASS isolated packaged runtime: ' + JSON.stringify(result));
  console.log('Evidence: ' + qa);
} finally {
  socket?.terminate();
  child.kill();
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
}
