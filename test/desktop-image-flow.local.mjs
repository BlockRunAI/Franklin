/** Desktop image integration: real serve socket + agent loop, fake loopback
 * gateway only. A child process gets a disposable HOME/USERPROFILE and no
 * inherited credentials. No live wallet, account, model or service is used. */
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
    // Catalog refreshes and optional background services must never escape
    // this fixture. Return promptly so a network outage cannot hide a failure.
    return Response.json({ error: 'External network disabled by test fixture' }, { status: 503 });
  };
  const { API_URLS } = await import('../dist/config.js');
  API_URLS.base = gateway.origin;
  const { startServer } = await import('../dist/serve/server.js');
  await startServer({ port: 0, workDir: process.env.FRANKLIN_TEST_WORKDIR, debug: false });
} else {
  test("Desktop images survive the real serve queue, agent loop and gateway serialization", { timeout: 45_000 }, async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-desktop-auto-'));
    const home = path.join(temp, 'home');
    const workDir = path.join(temp, 'workspace');
    fs.mkdirSync(home);
    fs.mkdirSync(workDir);
    const requests = [];

    const gateway = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only the fake messages endpoint is available' }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      requests.push(payload);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (kind, data) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      event('message_start', { message: { usage: { input_tokens: 5, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Image received.' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      event('message_stop', {});
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    });

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
        FRANKLIN_SERVE_DISCOVERY: 'off',
        FRANKLIN_CLOUD_SYNC: 'off',
        FRANKLIN_NO_AUDIT: '1',
        FRANKLIN_NO_PERSIST: '1',
        FRANKLIN_NO_EXPERIENCE: '1',
      },
    });
    let diagnostics = '';
    child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
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
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await once(socket, 'open');
    t.after(() => socket.terminate());
    let sequence = 0;
    async function turn(model, text, attachments) {
      const id = `auto-routing-${++sequence}`;
      const events = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`turn timeout: ${diagnostics}`)), 10_000);
        const onMessage = raw => {
          const message = JSON.parse(raw.toString());
          if (message.id !== id) return;
          events.push(message);
          if (message.kind === 'agent.error' || message.kind === 'error') finish(new Error(message.payload?.message ?? 'Agent error'));
          else if (message.kind === 'agent.done') finish();
        };
        function finish(error) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          if (error) reject(error); else resolve();
        }
        socket.on('message', onMessage);
        socket.send(JSON.stringify({ id, kind: 'agent.send', payload: { sessionId: null, convId: 'desktop-auto', model, text, attachments } }));
      });
      return events.filter(event => event.kind === 'agent.text').map(event => event.payload.text).join('');
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=';
    const attachments = [{path:`data:image/png;base64,${png}`}];
    const latestUser = () => requests.at(-1).messages.filter(m => m.role === 'user').at(-1);
    const assertImage = () => assert.ok(latestUser().content.some(part => part.type === 'image' && part.source.data === png));
    assert.match(await turn('anthropic/claude-haiku-4.5', 'Describe this screenshot.', attachments), /Image received/);
    assertImage();
    await turn('anthropic/claude-haiku-4.5', '/retry');
    assertImage();
    await turn('anthropic/claude-haiku-4.5', '', attachments);
    assertImage();
    assert.ok(latestUser().content.some(part => part.type === 'text' && part.text.includes('Describe the attached image')));
    await turn('anthropic/claude-haiku-4.5', 'Say hello.');
    const content = latestUser().content;
    assert.ok(typeof content === 'string' || !content.some(part => part.type === 'image'));
    const count = requests.length;
    await assert.rejects(turn('anthropic/claude-haiku-4.5', 'test', [{path:'/etc/passwd'}]), /Attach a PNG/);
    assert.equal(requests.length, count, 'invalid images must not trigger a model request');
  });
}
