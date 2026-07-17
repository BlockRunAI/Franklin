/**
 * AgentHost integration tests: multiple concurrent hosted agents driven
 * against a mock SSE gateway (no network, no wallet). Verifies dispatch,
 * event isolation between agents, reply round-trips, remote permission
 * answering via the approval broker, and live-registry publication.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-agenthost-test-'));
process.env.HOME = TMP_HOME;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-agenthost-work-'));

const { AgentHost } = await import('../dist/serve/agent-host.js');
const { readLiveAgents } = await import('../dist/session/live-registry.js');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

async function until(cond, timeoutMs = 15_000, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error('condition not met within timeout');
}

function lastUserText(payload) {
  const messages = payload.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text);
      if (texts.length) return texts.join(' ');
    }
  }
  return '';
}

/** Mock gateway: echoes the last user text back as the assistant answer. */
function startEchoServer() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let text = 'echo:';
    try { text = `echo:${lastUserText(JSON.parse(raw)).slice(0, 60)}`; } catch { /* keep default */ }
    send('message_start', { message: { usage: { input_tokens: 5, output_tokens: 0 } } });
    send('content_block_start', { content_block: { type: 'text', text: '' } });
    send('content_block_delta', { delta: { type: 'text_delta', text } });
    send('content_block_stop', {});
    send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    send('message_stop', {});
    res.end('data: [DONE]\n\n');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function agentText(host, sessionId) {
  return host
    .output(sessionId)
    .filter(e => e.kind === 'text_delta')
    .map(e => e.text)
    .join('');
}

test('host: concurrent agents stay isolated; reply starts a new turn; registry published', { timeout: 60_000 }, async () => {
  const { server, url } = await startEchoServer();
  const host = new AgentHost({ workDir: WORK_DIR, chain: 'base', apiUrl: url, defaultModel: 'zai/glm-5.1' });
  try {
    const [alpha, beta] = await Promise.all([
      host.dispatch({ prompt: 'alpha task about funding rates', label: 'alpha' }),
      host.dispatch({ prompt: 'beta task about validator yields', label: 'beta' }),
    ]);
    assert.ok(alpha && beta && alpha !== beta, 'two distinct session ids');

    await until(() => host.get(alpha)?.state === 'idle' && host.get(beta)?.state === 'idle');

    const alphaText = agentText(host, alpha);
    const betaText = agentText(host, beta);
    assert.match(alphaText, /alpha task/);
    assert.match(betaText, /beta task/);
    assert.doesNotMatch(alphaText, /beta task/, 'no event bleed between agents');
    assert.doesNotMatch(betaText, /alpha task/);

    // Live registry: both agents published as serve-hosted.
    const live = readLiveAgents();
    const rows = live.filter(r => r.sessionId === alpha || r.sessionId === beta);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.host === 'serve'));

    // Subscribe + reply: the follow-up streams to the subscriber and lands
    // only in alpha's buffer.
    const seen = [];
    const unsubscribe = host.subscribe(alpha, ev => seen.push(ev));
    assert.ok(unsubscribe);
    assert.equal(host.reply(alpha, 'follow-up question'), true);
    await until(() => agentText(host, alpha).includes('follow-up question'));
    assert.ok(seen.some(e => e.kind === 'text_delta' && e.text.includes('follow-up')));
    assert.doesNotMatch(agentText(host, beta), /follow-up/);
    unsubscribe();

    assert.equal(host.reply('nonexistent', 'x'), false);

    // list() reflects both agents.
    const summaries = host.list();
    assert.ok(summaries.find(s => s.sessionId === alpha)?.label, 'alpha');
  } finally {
    host.shutdown();
    await new Promise(r => server.close(r));
  }
});

test('host: permission prompt parks as an approval; remote respond resolves it', { timeout: 60_000 }, async () => {
  // Mock gateway: the MAIN agent turn (identified by carrying the Write tool
  // and no prior tw_1 result — harness side-calls like the turn analyzer
  // don't pass the full toolset) asks to Write a file; every later/other
  // call just answers with text.
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    let wantsToolUse = false;
    try {
      const payload = JSON.parse(raw);
      const hasWriteTool = Array.isArray(payload.tools) && payload.tools.some(t => t.name === 'Write');
      wantsToolUse = hasWriteTool && !raw.includes('tw_1');
    } catch { /* text fallback */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send('message_start', { message: { usage: { input_tokens: 5, output_tokens: 0 } } });
    if (wantsToolUse) {
      send('content_block_start', { content_block: { type: 'tool_use', id: 'tw_1', name: 'Write' } });
      send('content_block_delta', { delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path.join(WORK_DIR, 'out.txt'), content: 'x' }) } });
      send('content_block_stop', {});
      send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } });
    } else {
      send('content_block_start', { content_block: { type: 'text', text: '' } });
      send('content_block_delta', { delta: { type: 'text_delta', text: 'acknowledged the denial' } });
      send('content_block_stop', {});
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    }
    send('message_stop', {});
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const host = new AgentHost({ workDir: WORK_DIR, chain: 'base', apiUrl: url, defaultModel: 'zai/glm-5.1' });
  try {
    const sid = await host.dispatch({ prompt: 'write the file', label: 'writer' });

    // The Write call must park as a pending approval and flip the agent to
    // needs-input.
    await until(() => (host.get(sid)?.pendingApprovals.length ?? 0) > 0);
    assert.equal(host.get(sid).state, 'needs-input');
    const req = host.get(sid).pendingApprovals[0];
    assert.equal(req.kind, 'tool-permission');
    assert.match(req.title, /Write/);

    // Deny remotely — the turn continues, the file is never written.
    assert.equal(host.respond(sid, req.requestId, 'no'), true);
    await until(() => host.get(sid)?.state === 'idle');
    assert.equal(host.get(sid).pendingApprovals.length, 0);
    assert.match(agentText(host, sid), /acknowledged the denial/);
    assert.equal(fs.existsSync(path.join(WORK_DIR, 'out.txt')), false, 'denied Write must not touch disk');

    assert.equal(host.respond(sid, 'bogus-request', 'yes'), false);
  } finally {
    host.shutdown();
    await new Promise(r => server.close(r));
  }
});
