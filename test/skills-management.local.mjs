// Real RPC and slash dispatch with an isolated child home. No wallet/model/tool execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseSkill } from '../dist/skills/loader.js';
import { handleSlashCommand } from '../dist/agent/commands.js';
import { Registry } from '../dist/skills/registry.js';

const weather = fs.readFileSync(new URL('./fixtures/openclaw-weather/SKILL.md', import.meta.url), 'utf8');
const md = (name, body = 'Read https://example.com with available HTTP tools. $ARGUMENTS') => `---\nname: ${name}\ndescription: API instructions\n---\n${body}\n`;

test('public OpenClaw weather parses unmodified nested metadata, quoted descriptions and HTTP examples', () => {
  const result = parseSkill(weather);
  assert.ok('skill' in result, JSON.stringify(result));
  assert.equal(result.skill.name, 'weather');
  assert.match(result.skill.body, /curl --fail/);
  assert.equal(parseSkill('---\nname: duplicate\nname: two\ndescription: x\n---\nx').error.startsWith('Invalid YAML'), true);
  assert.equal(parseSkill('---\nname: multiline\ndescription: >\n  Multiple lines\n  supported\n---\nbody').skill.description, 'Multiple lines supported\n');
});

test('real slash dispatch accepts external commands without swallowing a built-in prefix', async () => {
  const parsed = parseSkill(md('moa-weather', 'Use the public weather API.'));
  const registry = Registry.fromLoaded([{ skill: parsed.skill, source: 'user', path: '/fixture/SKILL.md', warnings: [] }]);
  const result = await handleSlashCommand('/moa-weather Reykjavik tomorrow', {
    history: [], config: {}, client: null, sessionId: 'qa', onEvent: () => {}, skillRegistry: registry,
  });
  assert.equal(result.handled, false);
  assert.equal(result.skill.name, 'moa-weather');
  assert.match(result.rewritten, /User request:\nReykjavik tomorrow$/);
});

test('installed API skills traverse real authenticated server, persistence, disabled registry and removal', { timeout: 30000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-skills-rpc-'));
  const workDir = path.join(temp, 'workspace'); fs.mkdirSync(workDir);
  const child = fork(path.resolve('dist/index.js'), ['serve', '--port', '0', '--work-dir', workDir], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOME: temp, USERPROFILE: temp, FRANKLIN_SERVE_TOKEN: 'qa-skills-token', FRANKLIN_SERVE_DISCOVERY: 'off', FRANKLIN_CLOUD_SYNC: 'off', FRANKLIN_CATALOG_OFFLINE: '1' },
  });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
  let socket;
  t.after(() => { socket?.terminate(); child.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server ready timeout: ' + stderr)), 15000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.on('message', (m) => { if (m.type === 'franklin:server-ready') { clearTimeout(timer); resolve(m.port); } });
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=qa-skills-token`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let seq = 0;
  const rpc = (kind, payload) => new Promise((resolve, reject) => {
    const id = String(++seq);
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('RPC timeout: ' + kind)); }, 4000);
    function listener(raw) {
      const m = JSON.parse(String(raw)); if (m.id !== id) return;
      clearTimeout(timer); socket.off('message', listener);
      if (m.kind === 'error') reject(new Error(m.payload.message)); else resolve(m.payload);
    }
    socket.on('message', listener); socket.send(JSON.stringify({ id, kind, payload }));
  });
  const upload = (content) => rpc('skills.upload', { content });
  assert.equal((await upload(weather)).name, 'weather');
  const list = await rpc('skills.list');
  const installed = list.skills.find((s) => s.name === 'weather');
  assert.equal(installed.enabled, true); assert.equal(installed.source, 'user'); assert.equal(installed.removable, true);
  const resolved = await rpc('skills.resolve', { input: '/weather Reykjavik tomorrow' });
  assert.equal(resolved.name, 'weather'); assert.match(resolved.prompt, /User request:\nReykjavik tomorrow$/); assert.match(resolved.prompt, /https:\/\/wttr.in/);
  assert.equal(fs.readFileSync(path.join(temp, '.blockrun/skills/weather/SKILL.md'), 'utf8'), weather);
  await assert.rejects(upload(weather), /already exists/);
  await assert.rejects(upload('not frontmatter'), /frontmatter/);
  await assert.rejects(upload(md('../escape')), /name/);
  await assert.rejects(upload(md('help')), /reserved/);
  await assert.rejects(upload(md('empty', '')), /empty/);
  await assert.rejects(upload('x'.repeat(256 * 1024 + 1)), /256 KiB/);
  await assert.rejects(rpc('skills.toggle', { name: 'weather', enabled: 'false' }), /boolean/);
  await rpc('skills.toggle', { name: 'weather', enabled: false });
  await assert.rejects(rpc('skills.resolve', { input: '/weather Reykjavik tomorrow' }), /disabled/);
  assert.equal((await rpc('skills.list')).skills.find((s) => s.name === 'weather').enabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, '.blockrun/skills-disabled.json'), 'utf8')), ['weather']);
  await rpc('skills.toggle', { name: 'weather', enabled: true });
  assert.equal((await rpc('skills.resolve', { input: '/weather Reykjavik tomorrow' })).name, 'weather');
  await upload(md('local-files', 'Run `python scripts/check.py` with the workspace CSV.'));
  assert.match((await rpc('skills.list')).skills.find((s) => s.name === 'local-files').notes.join(), /supporting files/);
  await upload(md('api-docs', 'Install with npx skills add vendor/api.\n```bash\ncurl https://api.example.com\n```'));
  assert.deepEqual((await rpc('skills.list')).skills.find((s) => s.name === 'api-docs').notes, []);
  await upload(md('url-assets', 'Fetch https://api.example.test/assets/prices with curl.'));
  assert.deepEqual((await rpc('skills.list')).skills.find((s) => s.name === 'url-assets').notes, []);
  const root = path.join(temp, '.blockrun/skills');
  fs.mkdirSync(path.join(temp, 'outside'));
  fs.symlinkSync(path.join(temp, 'outside'), path.join(root, 'linked'));
  await assert.rejects(upload(md('linked')), /already exists/);
  assert.deepEqual(fs.readdirSync(path.join(temp, 'outside')), []);
  const bundled = list.skills.find((s) => s.source === 'bundled');
  assert.ok(bundled); await assert.rejects(rpc('skills.remove', { name: bundled.name }), /Only imported/);
  for (const name of ['weather', 'local-files', 'api-docs', 'url-assets']) await rpc('skills.remove', { name });
  assert.ok(!(await rpc('skills.list')).skills.some((s) => s.source === 'user'));
  assert.ok(!fs.existsSync(path.join(root, 'weather')));
  assert.ok(!fs.existsSync(path.join(temp, '.blockrun/.session')));
  assert.ok(!fs.existsSync(path.join(temp, '.blockrun/.solana-session')));
});
