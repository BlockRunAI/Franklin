/**
 * Deterministic local tests (no live model dependency).
 * These should run fast and reliably in CI/local environments.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unwatchFile, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const DIST = new URL('../dist/index.js', import.meta.url).pathname;

function runCli(prompt = '', { cwd, timeoutMs = 15_000, args, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', args ?? [DIST, '--model', 'zai/glm-5.1', '--trust'], {
      cwd: cwd ?? tmpdir(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.stdin.write(prompt + '\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function listenOnRandomPort(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error(`Unexpected server address: ${String(address)}`);
  }
  return address.port;
}

test('cli startup prints banner and model line without model call', { timeout: 20_000 }, async () => {
  const result = await runCli('/exit');
  assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
  // The tagline line under the FRANKLIN block letters — present in both
  // side-by-side and text-only layouts. Also uniquely identifies our banner
  // vs. any other CLI that might print "Franklin" somewhere.
  assert.ok(
    result.stdout.includes('blockrun.ai') &&
    result.stdout.includes('The AI agent with a wallet'),
    `Missing banner tagline.\nstdout:\n${result.stdout}`
  );
  assert.ok(result.stdout.includes('Wallet:'), `Missing wallet line.\nstdout:\n${result.stdout}`);
  assert.ok(result.stderr.includes('Model:'), `Missing model line.\nstderr:\n${result.stderr}`);
});

test('flags-only start options still honor --help without launching the agent', async () => {
  const result = await runCli('', {
    args: [DIST, '--model', 'zai/glm-5.1', '--help'],
  });

  assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
  assert.ok(result.stdout.includes('Usage: franklin start [options]'), `Expected start help.\nstdout:\n${result.stdout}`);
  assert.ok(!result.stdout.includes('blockrun.ai'), `Help path should not print startup banner.\nstdout:\n${result.stdout}`);
});

test('flags-only start options still honor --version without launching the agent', async () => {
  const result = await runCli('', {
    args: [DIST, '--model', 'zai/glm-5.1', '--version'],
  });

  assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, `Expected plain version output.\nstdout:\n${result.stdout}`);
  assert.ok(!result.stdout.includes('blockrun.ai'), `Version path should not print startup banner.\nstdout:\n${result.stdout}`);
});

test('chain shortcut --help does not mutate saved chain or launch the agent', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'rc-chain-help-'));
  const chainFile = join(fakeHome, '.blockrun', 'payment-chain');

  try {
    const result = await runCli('', {
      args: [DIST, 'base', '--help'],
      env: { HOME: fakeHome },
    });

    assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('Usage: franklin start [options]'), `Expected start help.\nstdout:\n${result.stdout}`);
    assert.ok(!existsSync(chainFile), `Help path should not persist chain config at ${chainFile}`);
    assert.ok(!result.stdout.includes('blockrun.ai'), `Help path should not print startup banner.\nstdout:\n${result.stdout}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('chain shortcut --version does not mutate saved chain or launch the agent', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'rc-chain-version-'));
  const chainFile = join(fakeHome, '.blockrun', 'payment-chain');

  try {
    const result = await runCli('', {
      args: [DIST, 'solana', '--version'],
      env: { HOME: fakeHome },
    });

    assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, `Expected plain version output.\nstdout:\n${result.stdout}`);
    assert.ok(!existsSync(chainFile), `Version path should not persist chain config at ${chainFile}`);
    assert.ok(!result.stdout.includes('blockrun.ai'), `Version path should not print startup banner.\nstdout:\n${result.stdout}`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('panel server serves dashboard HTML and stats JSON', async () => {
  const panelUrl = new URL('../dist/panel/server.js', import.meta.url);
  const { createPanelServer } = await import(`${panelUrl.href}?t=${Date.now()}`);
  const server = createPanelServer(0);
  const port = await listenOnRandomPort(server);

  try {
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(htmlRes.status, 200, `Expected dashboard HTML, got ${htmlRes.status}`);
    const html = await htmlRes.text();
    assert.ok(html.includes('<title>Franklin Panel</title>'), 'Missing panel title in HTML');
    assert.ok(html.includes('Overview'), 'Missing Overview section in HTML');

    const statsRes = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(statsRes.status, 200, `Expected stats JSON, got ${statsRes.status}`);
    const stats = await statsRes.json();
    assert.equal(typeof stats.totalRequests, 'number');
    assert.equal(typeof stats.totalCostUsd, 'number');
    assert.equal(typeof stats.byModel, 'object');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    unwatchFile(join(homedir(), '.blockrun', 'runcode-stats.json'));
  }
});

test('proxy server handles OPTIONS and local model switching without backend calls', async () => {
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'rc-proxy-home-'));
  const proxyUrl = new URL('../dist/proxy/server.js', import.meta.url);

  let server;
  try {
    process.env.HOME = fakeHome;
    const { createProxy } = await import(`${proxyUrl.href}?t=${Date.now()}`);
    server = createProxy({
      port: 0,
      apiUrl: 'http://127.0.0.1:9',
      chain: 'base',
      modelOverride: 'zai/glm-5.1',
      fallbackEnabled: false,
    });
    const port = await listenOnRandomPort(server);

    const optionsRes = await fetch(`http://127.0.0.1:${port}/api/messages`, { method: 'OPTIONS' });
    assert.equal(optionsRes.status, 200, `Expected OPTIONS 200, got ${optionsRes.status}`);

    const switchRes = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'use sonnet' }],
      }),
    });
    assert.equal(switchRes.status, 200, `Expected switch response 200, got ${switchRes.status}`);
    const payload = await switchRes.json();
    assert.equal(payload.model, 'anthropic/claude-sonnet-4.6');
    assert.ok(
      payload.content?.[0]?.text?.includes('Switched to **anthropic/claude-sonnet-4.6**'),
      `Unexpected switch payload: ${JSON.stringify(payload)}`
    );
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('write capability allows files under system temp directory', async () => {
  const { writeCapability } = await import('../dist/tools/write.js');
  const target = join(tmpdir(), `rc-local-write-${Date.now()}.txt`);
  try {
    const result = await writeCapability.execute(
      { file_path: target, content: 'LOCAL_WRITE_OK' },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal }
    );
    assert.equal(result.isError, undefined, `Write returned error: ${result.output}`);
    assert.ok(existsSync(target), `Expected file to exist: ${target}`);
    assert.equal(readFileSync(target, 'utf8'), 'LOCAL_WRITE_OK');
  } finally {
    rmSync(target, { force: true });
  }
});

test('session storage falls back to temp dir when HOME is not writable', async () => {
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'rc-home-ro-'));
  const fallbackDir = join(tmpdir(), 'runcode', 'sessions');

  try {
    mkdirSync(fakeHome, { recursive: true });
    chmodSync(fakeHome, 0o500); // read+execute, no write
    const storageHref = new URL('../dist/session/storage.js', import.meta.url).href;
    const script = `
      const storage = await import(${JSON.stringify(storageHref)} + '?t=' + Date.now());
      const sessionId = storage.createSessionId();
      storage.appendToSession(sessionId, { role: 'user', content: 'fallback-check' });
      storage.updateSessionMeta(sessionId, {
        model: 'local/test',
        workDir: process.cwd(),
        turnCount: 1,
        messageCount: 1,
      });
      console.log(JSON.stringify({ sessionId }));
    `;

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('node', ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: fakeHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`session storage subprocess failed (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
      proc.on('error', reject);
    });

    const { sessionId } = JSON.parse(result.stdout.trim());
    const jsonl = join(fallbackDir, `${sessionId}.jsonl`);
    const meta = join(fallbackDir, `${sessionId}.meta.json`);
    assert.ok(existsSync(jsonl), `Expected fallback session file at ${jsonl}`);
    assert.ok(existsSync(meta), `Expected fallback session meta at ${meta}`);

    rmSync(jsonl, { force: true });
    rmSync(meta, { force: true });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    chmodSync(fakeHome, 0o700);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('interactive session persists tool exchanges for resume', { timeout: 20_000 }, async () => {
  const beforeIds = new Set((await import('../dist/session/storage.js')).listSessions().map((s) => s.id));
  let requestCount = 0;

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    requestCount++;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (requestCount === 1) {
      send('message_start', { message: { usage: { input_tokens: 12, output_tokens: 0 } } });
      send('content_block_start', { content_block: { type: 'tool_use', id: 'tool_echo_1', name: 'Echo' } });
      send('content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"text":"persist me"}' } });
      send('content_block_stop', {});
      send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
      send('message_stop', {});
    } else {
      const payload = JSON.parse(raw);
      const messages = payload.messages || [];
      const toolResultSeen = messages.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'tool_result' && String(part.content).includes('echo:persist me'))
      );
      assert.ok(toolResultSeen, 'Expected follow-up request to include tool_result history');

      send('message_start', { message: { usage: { input_tokens: 24, output_tokens: 0 } } });
      send('content_block_start', { content_block: { type: 'text', text: '' } });
      send('content_block_delta', { delta: { type: 'text_delta', text: 'final answer' } });
      send('content_block_stop', {});
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
      send('message_stop', {});
    }

    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Expected HTTP server address');
  const apiUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { interactiveSession } = await import('../dist/agent/loop.js');
    const { listSessions, loadSessionHistory, getSessionFilePath } = await import('../dist/session/storage.js');

    const capability = {
      spec: {
        name: 'Echo',
        description: 'Echo back the provided text',
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      async execute(input) {
        return { output: `echo:${input.text}` };
      },
      concurrent: false,
    };

    let calls = 0;
    await interactiveSession(
      {
        model: 'local/test-model',
        apiUrl,
        chain: 'base',
        systemInstructions: ['You are a test harness.'],
        capabilities: [capability],
        workingDir: process.cwd(),
        permissionMode: 'trust',
      },
      async () => {
        calls++;
        return calls === 1 ? 'use the echo tool' : null;
      },
      () => {}
    );

    const created = listSessions().find((session) => !beforeIds.has(session.id));
    assert.ok(created, 'Expected a new persisted session');

    const restored = loadSessionHistory(created.id);
    assert.equal(restored.length, 4, `Expected full transcript with tool exchange.\n${JSON.stringify(restored, null, 2)}`);
    assert.equal(restored[0].role, 'user');
    assert.equal(restored[1].role, 'assistant');
    assert.equal(restored[2].role, 'user');
    assert.equal(restored[3].role, 'assistant');
    assert.ok(
      Array.isArray(restored[2].content) &&
      restored[2].content.some((part) => part.type === 'tool_result' && String(part.content).includes('echo:persist me')),
      'Expected persisted tool_result in session transcript'
    );

    const sessionFile = getSessionFilePath(created.id);
    rmSync(sessionFile, { force: true });
    rmSync(join(dirname(sessionFile), `${created.id}.meta.json`), { force: true });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('bash capability reports user abort distinctly from timeout', async () => {
  const { bashCapability } = await import('../dist/tools/bash.js');
  const controller = new AbortController();

  const resultPromise = bashCapability.execute(
    { command: 'sleep 5' },
    { workingDir: process.cwd(), abortSignal: controller.signal }
  );

  setTimeout(() => controller.abort(), 50);
  const result = await resultPromise;

  assert.equal(result.isError, true, `Expected aborted command to be treated as an error.\n${result.output}`);
  assert.ok(result.output.includes('aborted by user'), `Expected abort wording.\n${result.output}`);
  assert.ok(!result.output.includes('timeout after'), `Abort should not be mislabeled as timeout.\n${result.output}`);
});

test('webfetch cache key includes max_length to avoid stale truncated responses', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Expected HTTP server address');
  const url = `http://127.0.0.1:${address.port}/data`;

  try {
    const { webFetchCapability } = await import('../dist/tools/webfetch.js');
    const ctx = { workingDir: process.cwd(), abortSignal: new AbortController().signal };

    const short = await webFetchCapability.execute({ url, max_length: 5 }, ctx);
    const full = await webFetchCapability.execute({ url, max_length: 128 }, ctx);

    assert.ok(short.output.includes('01234'), `Expected truncated body in first fetch.\n${short.output}`);
    assert.ok(full.output.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), `Expected full body in second fetch.\n${full.output}`);
    assert.equal(hits, 2, 'Expected separate fetches for distinct max_length values');
    assert.ok(!full.output.includes('(cached)'), 'Second fetch should not reuse the smaller cached response');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('stats tracker falls back to temp dir when HOME is not writable', async () => {
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'rc-home-stats-ro-'));

  try {
    mkdirSync(fakeHome, { recursive: true });
    chmodSync(fakeHome, 0o500);
    const trackerUrl = new URL('../dist/stats/tracker.js', import.meta.url).href;
    const script = `
      const tracker = await import(${JSON.stringify(trackerUrl)});
      tracker.recordUsage('local/test', 10, 5, 0.01, 123);
      tracker.flushStats();
      console.log(tracker.getStatsFilePath());
    `;

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('node', ['--input-type=module', '-e', script], {
        env: { ...process.env, HOME: fakeHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`tracker subprocess failed (${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
      proc.on('error', reject);
    });

    const statsFile = result.stdout.trim();
    assert.equal(statsFile, join(tmpdir(), 'runcode', 'runcode-stats.json'));
    assert.ok(existsSync(statsFile), `Expected fallback stats file at ${statsFile}`);

    rmSync(statsFile, { force: true });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    chmodSync(fakeHome, 0o700);
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('slash /search rewrites to codebase search prompt', async () => {
  const { handleSlashCommand } = await import('../dist/agent/commands.js');

  const result = await handleSlashCommand('/search payment router', {
    history: [],
    config: {
      model: 'local/test',
      apiUrl: 'http://localhost',
      chain: 'base',
      systemInstructions: [],
      capabilities: [],
      workingDir: process.cwd(),
      permissionMode: 'trust',
    },
    client: {},
    sessionId: 'session-current',
    onEvent: () => {},
  });

  assert.equal(result.handled, false);
  assert.ok(
    result.rewritten?.includes('Search the codebase for "payment router" using Grep'),
    `Expected codebase search rewrite.\n${JSON.stringify(result)}`
  );
});

test('slash /session-search finds saved sessions without hijacking /search', async () => {
  const { handleSlashCommand } = await import('../dist/agent/commands.js');
  const storage = await import('../dist/session/storage.js');
  const sessionId = storage.createSessionId();
  const metaFile = join(dirname(storage.getSessionFilePath(sessionId)), `${sessionId}.meta.json`);
  const needle = `SESSION_NEEDLE_${Date.now()}`;
  const events = [];

  try {
    storage.appendToSession(sessionId, { role: 'user', content: `look for ${needle}` });
    storage.appendToSession(sessionId, { role: 'assistant', content: `found ${needle}` });
    storage.updateSessionMeta(sessionId, {
      model: 'local/test',
      workDir: process.cwd(),
      turnCount: 1,
      messageCount: 2,
    });

    await handleSlashCommand(`/session-search "${needle}"`, {
      history: [],
      config: {
        model: 'local/test',
        apiUrl: 'http://localhost',
        chain: 'base',
        systemInstructions: [],
        capabilities: [],
        workingDir: process.cwd(),
        permissionMode: 'trust',
      },
      client: {},
      sessionId: 'session-current',
      onEvent: (event) => events.push(event),
    });

    const rendered = events
      .filter((event) => event.kind === 'text_delta')
      .map((event) => event.text)
      .join('\n');

    assert.ok(rendered.includes(sessionId), `Expected session id in search results.\n${rendered}`);
    assert.ok(rendered.includes(needle), `Expected snippet to include query.\n${rendered}`);
  } finally {
    rmSync(storage.getSessionFilePath(sessionId), { force: true });
    rmSync(metaFile, { force: true });
  }
});

test('slash /resume without id restores the latest non-current session', async () => {
  const { handleSlashCommand } = await import('../dist/agent/commands.js');
  const storage = await import('../dist/session/storage.js');
  const olderId = storage.createSessionId();
  const latestId = storage.createSessionId();
  const olderMeta = join(dirname(storage.getSessionFilePath(olderId)), `${olderId}.meta.json`);
  const latestMeta = join(dirname(storage.getSessionFilePath(latestId)), `${latestId}.meta.json`);
  const history = [{ role: 'user', content: 'placeholder current session' }];
  const events = [];

  try {
    storage.appendToSession(olderId, { role: 'user', content: 'old session' });
    storage.updateSessionMeta(olderId, {
      model: 'local/test',
      workDir: process.cwd(),
      turnCount: 1,
      messageCount: 1,
    });
    const olderMetaJson = JSON.parse(readFileSync(olderMeta, 'utf8'));
    olderMetaJson.updatedAt = Date.now() + 60_000;
    writeFileSync(olderMeta, JSON.stringify(olderMetaJson, null, 2));

    storage.appendToSession(latestId, { role: 'user', content: 'latest session restored' });
    storage.appendToSession(latestId, { role: 'assistant', content: 'latest answer' });
    storage.updateSessionMeta(latestId, {
      model: 'local/test',
      workDir: process.cwd(),
      turnCount: 1,
      messageCount: 2,
    });
    const latestMetaJson = JSON.parse(readFileSync(latestMeta, 'utf8'));
    latestMetaJson.updatedAt = Date.now() + 120_000;
    writeFileSync(latestMeta, JSON.stringify(latestMetaJson, null, 2));

    const result = await handleSlashCommand('/resume', {
      history,
      config: {
        model: 'local/test',
        apiUrl: 'http://localhost',
        chain: 'base',
        systemInstructions: [],
        capabilities: [],
        workingDir: process.cwd(),
        permissionMode: 'trust',
      },
      client: {},
      sessionId: 'session-current',
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.handled, true);
    assert.equal(history.length, 2, `Expected restored history.\n${JSON.stringify(history, null, 2)}`);
    assert.equal(history[0].content, 'latest session restored');
    assert.equal(history[1].content, 'latest answer');

    const rendered = events
      .filter((event) => event.kind === 'text_delta')
      .map((event) => event.text)
      .join('\n');
    assert.ok(rendered.includes(latestId), `Expected latest session id in resume message.\n${rendered}`);
  } finally {
    rmSync(storage.getSessionFilePath(olderId), { force: true });
    rmSync(olderMeta, { force: true });
    rmSync(storage.getSessionFilePath(latestId), { force: true });
    rmSync(latestMeta, { force: true });
  }
});

test('error classifier maps common failure modes', async () => {
  const { classifyAgentError } = await import('../dist/agent/error-classifier.js');

  assert.deepEqual(classifyAgentError('fetch failed').category, 'network');
  assert.deepEqual(classifyAgentError('429 rate limit exceeded').category, 'rate_limit');
  assert.deepEqual(classifyAgentError('verification failed: insufficient balance').category, 'payment');
  assert.deepEqual(classifyAgentError('prompt is too long').category, 'context_limit');
  assert.deepEqual(classifyAgentError('500 internal server error').category, 'server');
});

// Regression: Cheetah saw an upstream 503 that wasn't auto-retried because
// the JSON-extracted .message field stripped the status code and the literal
// "Service Unavailable" string. Both forms must now classify as server/transient
// so loop.ts's backoff retry kicks in.
test('error classifier catches gateway 503 in all thrown shapes', async () => {
  const { classifyAgentError } = await import('../dist/agent/error-classifier.js');

  // Form 1: the new thrown format from llm.ts after the v3.1.2 fix
  const withStatus = classifyAgentError(
    'HTTP 503: Service temporarily unavailable: All workers are busy, please retry later'
  );
  assert.equal(withStatus.category, 'server');
  assert.equal(withStatus.isTransient, true);

  // Form 2: the raw inner .message if the status prefix is ever lost
  const inner = classifyAgentError(
    'Service temporarily unavailable: All workers are busy, please retry later'
  );
  assert.equal(inner.category, 'server');
  assert.equal(inner.isTransient, true);

  // Form 3: just the "workers" fragment
  const fragment = classifyAgentError('All workers are busy, please retry later');
  assert.equal(fragment.category, 'server');
  assert.equal(fragment.isTransient, true);
});

test('workflow formatter renders aborted steps with warning icon', async () => {
  const { formatWorkflowResult } = await import('../dist/plugins/runner.js');

  const output = formatWorkflowResult(
    { name: 'Social Growth' },
    {
      steps: [
        { name: 'search', summary: 'No posts found', cost: 0, status: 'aborted' },
      ],
      totalCost: 0,
      itemsProcessed: 0,
      durationMs: 100,
      dryRun: true,
    }
  );

  assert.ok(output.includes('⚠ search: No posts found'), `Expected aborted warning icon.\n${output}`);
});

test('workflow formatter infers aborted icon when status is missing', async () => {
  const { formatWorkflowResult } = await import('../dist/plugins/runner.js');

  const output = formatWorkflowResult(
    { name: 'Social Growth' },
    {
      steps: [
        { name: 'search', summary: 'No posts found (search returned empty)', cost: 0 },
      ],
      totalCost: 0,
      itemsProcessed: 0,
      durationMs: 100,
      dryRun: true,
    }
  );

  assert.ok(
    output.includes('⚠ search: No posts found (search returned empty)'),
    `Expected inferred aborted warning icon.\n${output}`
  );
});

test('package exports plugin-sdk subpath', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.exports, 'Expected package.json exports field');
  assert.ok(pkg.exports['./plugin-sdk'], 'Expected ./plugin-sdk export');
  assert.equal(pkg.exports['./plugin-sdk'].default, './dist/plugin-sdk/index.js');
});
