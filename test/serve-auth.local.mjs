/** `franklin serve` authentication: real serve socket + agent loop, fake
 * loopback gateway only. The child gets a disposable HOME and no inherited
 * credentials; no live wallet, account, model or service is used.
 *
 * Regression for GHSA-wfcc-mrqp-668m / GHSA-25q2-mmr5-c394 item 2: serve used
 * to accept any local socket when FRANKLIN_SERVE_TOKEN was unset, and any
 * socket holding an askId could approve another socket's tool prompt. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === '--fixture') {
  const gateway = new URL(process.env.FRANKLIN_TEST_GATEWAY);
  assert.equal(gateway.hostname, '127.0.0.1');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === gateway.origin) return nativeFetch(input, init);
    return Response.json({ error: 'External network disabled by test fixture' }, { status: 503 });
  };
  const { API_URLS } = await import('../dist/config.js');
  API_URLS.base = gateway.origin;
  const { startServer } = await import('../dist/serve/server.js');
  await startServer({ port: 0, workDir: process.env.FRANKLIN_TEST_WORKDIR, debug: false });
} else {
  /** Fake gateway: first turn asks for one Bash call, the follow-up ends the turn. */
  function fakeGateway(command) {
    return http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only the fake messages endpoint is available' }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      const last = payload.messages.at(-1);
      const answeringTool = Array.isArray(last?.content) && last.content.some(part => part.type === 'tool_result');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (kind, data) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      if (answeringTool) {
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      } else {
        event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: 'Bash', input: {} } });
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
      }
      event('message_stop', {});
      res.end('data: [DONE]\n\n');
    });
  }

  /** Start the fixture serve process. `token` undefined = launcher supplies none. */
  async function startServe(t, { token, discovery = true, command = 'true' } = {}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-serve-auth-'));
    const home = path.join(temp, 'home');
    const workDir = path.join(temp, 'workspace');
    fs.mkdirSync(home);
    fs.mkdirSync(workDir);
    const gateway = fakeGateway(command);
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const child = fork(SELF, ['--fixture'], {
      cwd: ROOT,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        RUNCODE_CHAIN: 'base',
        FRANKLIN_TEST_GATEWAY: `http://127.0.0.1:${gateway.address().port}`,
        FRANKLIN_TEST_WORKDIR: workDir,
        FRANKLIN_DESKTOP_WORKSPACE_BOUNDARY: '1',
        ...(token ? { FRANKLIN_SERVE_TOKEN: token } : {}),
        FRANKLIN_SERVE_DISCOVERY: discovery ? 'on' : 'off',
        FRANKLIN_CLOUD_SYNC: 'off',
        FRANKLIN_NO_AUDIT: '1',
        FRANKLIN_NO_PERSIST: '1',
        FRANKLIN_NO_EXPERIENCE: '1',
      },
    });
    let stdout = '';
    let diagnostics = '';
    child.stdout.on('data', chunk => { stdout += chunk; diagnostics = (diagnostics + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve readiness timeout: ${diagnostics}`)), 10_000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`serve exited (${code}): ${diagnostics}`)); });
      child.on('message', message => {
        if (message?.type === 'franklin:server-ready') {
          clearTimeout(timer);
          resolve(message.port);
        }
      });
    });
    // The discovery file and the stdout notice are written right after the
    // ready message; wait for the notice so both are in place.
    const deadline = Date.now() + 5000;
    while (!/Clients authenticate|Connect with:/.test(stdout) && token === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { port, home, workDir, stdout: () => stdout, diagnostics: () => diagnostics };
  }

  /** Resolve 'open' or the HTTP status the upgrade was refused with. */
  function tryConnect(url, headers = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.once('open', () => { ws.terminate(); resolve('open'); });
      ws.once('unexpected-response', (_req, res) => { ws.terminate(); resolve(res.statusCode); });
      ws.once('error', () => resolve('error'));
    });
  }

  test('serve with no launcher token mints one: tokenless and localhost-page sockets are refused', { timeout: 30_000 }, async (t) => {
    const { port, home, stdout } = await startServe(t);
    const base = `ws://127.0.0.1:${port}/agent`;
    assert.equal(await tryConnect(base), 401, 'a local client with no Origin and no token must be refused');
    assert.equal(await tryConnect(base, { Origin: 'http://localhost:5173' }), 401, 'a page on a local dev server must be refused');
    assert.equal(await tryConnect(`${base}?token=guess`), 401);

    const serveUrlFile = path.join(home, '.blockrun', 'serve-url');
    const discovered = new URL(fs.readFileSync(serveUrlFile, 'utf8'));
    const token = discovered.searchParams.get('token');
    assert.ok(token && token.length >= 40, 'serve-url must carry the minted token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(serveUrlFile).mode & 0o777, 0o600);
    assert.equal(await tryConnect(discovered.toString()), 'open', 'the discovered URL authenticates');
    assert.ok(!stdout().includes(token), 'with discovery on, the token is not printed');
    assert.match(stdout(), /per-start token/);

    // /file is fail-closed as well: an unsigned path is refused.
    const file = await fetch(`http://127.0.0.1:${port}/file?path=${encodeURIComponent(path.join(home, 'x.png'))}`);
    assert.equal(file.status, 403);
  });

  test('serve with discovery off prints the tokenised URL to its own terminal only', { timeout: 30_000 }, async (t) => {
    const { port, stdout } = await startServe(t, { discovery: false });
    const match = /Connect with: (ws:\/\/127\.0\.0\.1:\d+\/agent\?token=\S+)/.exec(stdout());
    assert.ok(match, 'the starting terminal must get a way in');
    assert.equal(await tryConnect(match[1]), 'open');
    assert.equal(await tryConnect(`ws://127.0.0.1:${port}/agent`), 401);
  });

  test('a permission ask can only be answered by the socket it was sent to', { timeout: 45_000 }, async (t) => {
    const token = 'serve-auth-fixture-token-only';
    const command = 'echo approved > approved.txt';
    const { port, workDir, diagnostics } = await startServe(t, { token, command });
    const url = `ws://127.0.0.1:${port}/agent?token=${token}`;
    const owner = new WebSocket(url);
    const other = new WebSocket(url);
    await Promise.all([once(owner, 'open'), once(other, 'open')]);
    t.after(() => { owner.terminate(); other.terminate(); });

    const request = (socket, id, kind, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} timeout: ${diagnostics()}`)), 10_000);
      const onMessage = raw => {
        const message = JSON.parse(raw.toString());
        if (message.id !== id || message.kind !== 'response') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message.payload);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ id, kind, payload }));
    });

    const turnId = 'turn-1';
    const ask = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`permissionAsk timeout: ${diagnostics()}`)), 15_000);
      owner.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.id !== turnId) return;
        if (message.kind === 'agent.error' || message.kind === 'error') { clearTimeout(timer); reject(new Error(message.payload?.message)); }
        if (message.kind === 'agent.permissionAsk') { clearTimeout(timer); resolve(message.payload); }
      });
    });
    const done = new Promise(resolve => owner.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id === turnId && message.kind === 'agent.done') resolve();
    }));
    owner.send(JSON.stringify({ id: turnId, kind: 'agent.send', payload: { sessionId: null, convId: 'serve-auth', model: 'anthropic/claude-haiku-4.5', text: 'Run the command.' } }));
    const { askId, toolName } = await ask;
    assert.equal(toolName, 'Bash');

    // Another authenticated socket holding the askId cannot approve it.
    assert.deepEqual(await request(other, 'hijack', 'agent.permissionResponse', { askId, decision: 'always' }), { ok: false });
    assert.equal(fs.existsSync(path.join(workDir, 'approved.txt')), false);

    // The socket that started the turn still can.
    assert.deepEqual(await request(owner, 'approve', 'agent.permissionResponse', { askId, decision: 'yes' }), { ok: true });
    await done;
    assert.equal(fs.readFileSync(path.join(workDir, 'approved.txt'), 'utf8').trim(), 'approved');
  });
}
