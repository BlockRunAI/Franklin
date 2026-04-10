/**
 * Deterministic local tests (no live model dependency).
 * These should run fast and reliably in CI/local environments.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIST = new URL('../dist/index.js', import.meta.url).pathname;

function runCli(prompt, { cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [DIST, '--model', 'zai/glm-5.1', '--trust'], {
      cwd: cwd ?? tmpdir(),
      env: { ...process.env },
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

test('cli startup prints banner and model line without model call', { timeout: 20_000 }, async () => {
  const result = await runCli('/exit');
  assert.equal(result.code, 0, `CLI exited non-zero.\nstderr:\n${result.stderr}`);
  assert.ok(result.stdout.includes('RunCode'), `Missing banner.\nstdout:\n${result.stdout}`);
  assert.ok(result.stdout.includes('Model:'), `Missing model line.\nstdout:\n${result.stdout}`);
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
    process.env.HOME = fakeHome;

    const storageUrl = new URL('../dist/session/storage.js', import.meta.url);
    const storage = await import(`${storageUrl.href}?t=${Date.now()}`);
    const sessionId = storage.createSessionId();

    storage.appendToSession(sessionId, { role: 'user', content: 'fallback-check' });
    storage.updateSessionMeta(sessionId, {
      model: 'local/test',
      workDir: process.cwd(),
      turnCount: 1,
      messageCount: 1,
    });

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

test('error classifier maps common failure modes', async () => {
  const { classifyAgentError } = await import('../dist/agent/error-classifier.js');

  assert.deepEqual(classifyAgentError('fetch failed').category, 'network');
  assert.deepEqual(classifyAgentError('429 rate limit exceeded').category, 'rate_limit');
  assert.deepEqual(classifyAgentError('verification failed: insufficient balance').category, 'payment');
  assert.deepEqual(classifyAgentError('prompt is too long').category, 'context_limit');
  assert.deepEqual(classifyAgentError('500 internal server error').category, 'server');
});
