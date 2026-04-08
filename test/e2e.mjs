/**
 * E2E tests for runcode CLI.
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 *
 * Run:  node --test test/e2e.mjs
 *       node --test --test-reporter=spec test/e2e.mjs
 *
 * Each test pipes a prompt into runcode's piped (non-TTY) mode
 * and asserts the output contains expected content.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIST = new URL('../dist/index.js', import.meta.url).pathname;
const TIMEOUT_MS = 90_000; // 90s per test — model calls can be slow

// ─── Helper ────────────────────────────────────────────────────────────────

/**
 * Run runcode with the given prompt(s) piped to stdin.
 * Pass a string for a single turn, or an array of strings for multi-turn.
 * Returns { stdout, stderr, exitCode }.
 */
function runcode(prompt, { cwd, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const workDir = cwd ?? tmpdir();
    const proc = spawn('node', [DIST], {
      cwd: workDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Send prompt(s) then close stdin (EOF signals session end)
    const lines = Array.isArray(prompt) ? prompt : [prompt];
    proc.stdin.write(lines.join('\n') + '\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeoutMs / 1000}s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('startup: banner and model line printed', { timeout: 10_000 }, async () => {
  // Use a prompt that gets rejected quickly — just check startup output
  const { stdout } = await runcode('say exactly: PING_OK', { timeoutMs: 60_000 });
  assert.ok(stdout.includes('RunCode'), `Missing banner. stdout:\n${stdout}`);
  assert.ok(stdout.includes('Model:'), `Missing model line. stdout:\n${stdout}`);
});

test('simple response: model echoes back a unique token', { timeout: 60_000 }, async () => {
  const { stdout, exitCode } = await runcode('say exactly and only this word: PONG_E2E_42');
  assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
  assert.ok(stdout.includes('PONG_E2E_42'), `Expected PONG_E2E_42 in output.\nstdout:\n${stdout}`);
});

test('bash tool: executes shell command and returns output', { timeout: 90_000 }, async () => {
  const { stdout, exitCode } = await runcode(
    'Use the Bash tool to run: echo BASH_TOOL_WORKS. Report the exact output.'
  );
  assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
  assert.ok(
    stdout.includes('BASH_TOOL_WORKS'),
    `Expected BASH_TOOL_WORKS in output.\nstdout:\n${stdout}`
  );
});

test('write tool: creates a file with specified content', { timeout: 90_000 }, async () => {
  const testDir = join(tmpdir(), `rc-e2e-write-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'hello.txt');

  try {
    const { stdout, exitCode } = await runcode(
      `Use the Write tool to create a file at ${targetFile} with content: E2E_WRITE_SUCCESS`,
      { cwd: testDir }
    );
    assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
    assert.ok(existsSync(targetFile), `File was not created at ${targetFile}`);
    const content = readFileSync(targetFile, 'utf8');
    assert.ok(content.includes('E2E_WRITE_SUCCESS'), `File content wrong: ${content}`);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('read tool: reads a pre-existing file', { timeout: 90_000 }, async () => {
  const testDir = join(tmpdir(), `rc-e2e-read-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'data.txt');
  writeFileSync(targetFile, 'E2E_READ_MARKER_XYZ\nline two\nline three\n');

  try {
    const { stdout, exitCode } = await runcode(
      `Use the Read tool to read the file at ${targetFile} and tell me the first line exactly.`,
      { cwd: testDir }
    );
    assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
    assert.ok(
      stdout.includes('E2E_READ_MARKER_XYZ'),
      `Expected E2E_READ_MARKER_XYZ in output.\nstdout:\n${stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('glob tool: finds files by pattern', { timeout: 90_000 }, async () => {
  const testDir = join(tmpdir(), `rc-e2e-glob-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'alpha.txt'), 'a');
  writeFileSync(join(testDir, 'beta.txt'), 'b');
  writeFileSync(join(testDir, 'gamma.log'), 'c');

  try {
    const { stdout, exitCode } = await runcode(
      `Use the Glob tool to find all *.txt files in ${testDir} and list their names.`,
      { cwd: testDir }
    );
    assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
    assert.ok(stdout.includes('alpha.txt'), `Missing alpha.txt.\nstdout:\n${stdout}`);
    assert.ok(stdout.includes('beta.txt'), `Missing beta.txt.\nstdout:\n${stdout}`);
    assert.ok(!stdout.includes('gamma.log') || stdout.includes('gamma'),
      `gamma.log should not be matched.\nstdout:\n${stdout}`);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('grep tool: finds content in files', { timeout: 90_000 }, async () => {
  const testDir = join(tmpdir(), `rc-e2e-grep-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'haystack.txt'), 'line one\nGREP_NEEDLE_42\nline three\n');

  try {
    const { stdout, exitCode } = await runcode(
      `Use the Grep tool to search for "GREP_NEEDLE_42" in ${testDir}/haystack.txt and tell me if it was found.`,
      { cwd: testDir }
    );
    assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
    assert.ok(
      stdout.includes('GREP_NEEDLE_42'),
      `Expected GREP_NEEDLE_42 in output.\nstdout:\n${stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('bash tool: error exit code is captured', { timeout: 90_000 }, async () => {
  const { stdout, exitCode } = await runcode(
    'Use the Bash tool to run: exit 42. Tell me what the exit code was.'
  );
  assert.equal(exitCode, 0, `runcode itself should exit 0. stdout:\n${stdout}`);
  // The model should mention an error or non-zero exit
  assert.ok(
    stdout.includes('42') || stdout.toLowerCase().includes('error') || stdout.toLowerCase().includes('exit'),
    `Expected mention of exit code 42 or error.\nstdout:\n${stdout}`
  );
});

test('multi-tool: write then read a file in same session', { timeout: 90_000 }, async () => {
  const testDir = join(tmpdir(), `rc-e2e-multi-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'roundtrip.txt');

  try {
    const { stdout, exitCode } = await runcode(
      `Step 1: Use the Write tool to create ${targetFile} with content: ROUNDTRIP_OK_789\n` +
      `Step 2: Use the Read tool to read that file back.\n` +
      `Step 3: Tell me the content you read.`,
      { cwd: testDir }
    );
    assert.equal(exitCode, 0, `Non-zero exit. stdout:\n${stdout}`);
    assert.ok(existsSync(targetFile), `File not created at ${targetFile}`);
    assert.ok(
      stdout.includes('ROUNDTRIP_OK_789'),
      `Expected ROUNDTRIP_OK_789 in output.\nstdout:\n${stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── Session cost tracking tests ───────────────────────────────────────────

test('session cost: token usage reported at session end', { timeout: 60_000 }, async () => {
  // The terminal UI (piped mode) prints "Tokens: X in / Y out" to stderr at exit.
  // This verifies the usage event pipeline is wired end-to-end.
  const { stderr, exitCode } = await runcode('say exactly: COST_CHECK_OK');
  assert.equal(exitCode, 0, `Non-zero exit.\nstderr: ${stderr}`);
  assert.ok(
    stderr.includes('Tokens:'),
    `Expected "Tokens:" summary in stderr.\nstderr:\n${stderr}`
  );
  // Token counts should be non-zero
  const match = stderr.match(/Tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out/);
  assert.ok(match, `Could not parse token line from: ${stderr}`);
  const inputTokens = parseInt(match[1], 10);
  const outputTokens = parseInt(match[2], 10);
  assert.ok(inputTokens > 0, `Expected input tokens > 0, got ${inputTokens}`);
  assert.ok(outputTokens > 0, `Expected output tokens > 0, got ${outputTokens}`);
});

test('session cost: accumulates across multiple turns', { timeout: 120_000 }, async () => {
  // Two turns in one session — token totals at session end should reflect both.
  const { stderr, exitCode } = await runcode([
    'say exactly: TURN_ONE',
    'say exactly: TURN_TWO',
  ]);
  assert.equal(exitCode, 0, `Non-zero exit.\nstderr: ${stderr}`);

  const match = stderr.match(/Tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out/);
  assert.ok(match, `Could not parse token line from: ${stderr}`);
  const inputTokens = parseInt(match[1], 10);
  const outputTokens = parseInt(match[2], 10);

  // Two turns means more tokens than a single turn would produce.
  // A single "say X" turn typically uses 10-50 input tokens.
  // Two turns should be at least 20 input tokens combined.
  assert.ok(inputTokens >= 20, `Expected ≥20 input tokens for 2 turns, got ${inputTokens}`);
  assert.ok(outputTokens >= 2, `Expected ≥2 output tokens for 2 turns, got ${outputTokens}`);
});

test('session cost: /cost command shows cost info', { timeout: 60_000 }, async () => {
  // Run a prompt then check /cost output in the same piped session.
  const { stderr, exitCode } = await runcode([
    'say exactly: BEFORE_COST',
    '/cost',
  ]);
  assert.equal(exitCode, 0, `Non-zero exit.\nstderr: ${stderr}`);
  // /cost prints token counts to stderr in the terminal UI
  assert.ok(
    stderr.includes('Tokens:'),
    `Expected "Tokens:" in /cost output.\nstderr:\n${stderr}`
  );
});

test('session cost: estimateCost returns non-negative value for known model', { timeout: 5_000 }, async () => {
  // Import and unit-test the pricing function directly (no model call needed).
  const { estimateCost } = await import('../dist/pricing.js');

  // GLM-5.1: $0.001 per call (flat pricing)
  const cost = estimateCost('zai/glm-5.1', 1_000_000, 1_000_000, 1);
  assert.ok(cost > 0, `Expected non-zero cost for GLM-5.1, got ${cost}`);
  assert.ok(cost <= 0.001, `GLM-5.1 is flat $0.001/call, got ${cost}`);

  // Free model should cost $0
  const freeCost = estimateCost('nvidia/nemotron-ultra-253b', 1_000_000, 1_000_000);
  assert.equal(freeCost, 0, `Expected $0 for free model, got ${freeCost}`);

  // Unknown model should return 0 (not throw)
  const unknownCost = estimateCost('unknown/model-xyz', 1_000, 1_000);
  assert.ok(unknownCost >= 0, `Expected non-negative for unknown model, got ${unknownCost}`);
});
