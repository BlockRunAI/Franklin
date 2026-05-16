/**
 * Live E2E tests for franklin CLI.
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 *
 * Run:  npm run test:e2e
 *       E2E_MODEL=<provider/model> npm run test:e2e
 *
 * Each test pipes a prompt into franklin's piped (non-TTY) mode
 * and asserts the output contains expected content.
 */

// Disable side-effect writes to the developer's ~/.blockrun/ — the e2e
// suite spawns franklin with real model names (zai/glm-5.1 etc.), which
// look like production traffic to isTestFixtureModel(). Verified
// 2026-05-04: prior runs left 409 audit entries ($0.258 cost) and 3
// orphan session metas in the user's home dir. Both env vars are set
// before any franklin import / child spawn so the spawned children (which
// inherit env on line ~37) skip audit/stats AND session writes. The two
// vars are intentionally separate: test/local.mjs sets only
// FRANKLIN_NO_AUDIT=1 because it depends on session writes still landing
// on disk (resume tests verify the .jsonl contents). See
// src/stats/audit.ts, src/stats/tracker.ts, src/session/storage.ts.
process.env.FRANKLIN_NO_AUDIT = '1';
process.env.FRANKLIN_NO_PERSIST = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TIMEOUT_MS = 90_000; // 90s per test — model calls can be slow

// ─── Helper ────────────────────────────────────────────────────────────────

/**
 * Run franklin with the given prompt(s) piped to stdin.
 * Pass a string for a single turn, or an array of strings for multi-turn.
 * Returns { stdout, stderr, exitCode }.
 */
function franklin(prompt, { cwd, timeoutMs = TIMEOUT_MS, model: modelOverride } = {}) {
  return new Promise((resolve, reject) => {
    const workDir = cwd ?? tmpdir();
    // Default to GLM for better reliability than free-tier models.
    // Override via the per-call `model` option or the E2E_MODEL env var.
    const model = modelOverride || process.env.E2E_MODEL || 'zai/glm-5.1';
    const proc = spawn('node', [DIST, '--model', model, '--trust'], {
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

/**
 * Check if result indicates the upstream is unavailable (rate limit,
 * payment, network/DNS failure, or server 5xx). If so, skip the test —
 * these are environment conditions, not code regressions.
 */
function skipIfRateLimited(t, result) {
  const combined = (result.stdout || '') + (result.stderr || '');
  const lower = combined.toLowerCase();

  if (
    combined.includes('max 60 requests/hour') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    combined.includes('Free tier')
  ) {
    t.skip('Free tier rate limited (60 req/hr) — retry later');
    return true;
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('[network]') ||
    lower.includes('network error') ||
    lower.includes('check your network') ||
    lower.includes('[timeout]') ||
    lower.includes('eai_again') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  ) {
    t.skip('Upstream unreachable from this environment (DNS/network) — skipping live model call');
    return true;
  }
  if (
    lower.includes('insufficient') ||
    lower.includes('payment required') ||
    lower.includes('verification failed') ||
    lower.includes('[payment]')
  ) {
    t.skip('Model unavailable due to payment/balance constraints — retry with E2E_MODEL or funded wallet');
    return true;
  }
  if (
    lower.includes('[server]') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('workers are busy') ||
    lower.includes('overloaded')
  ) {
    t.skip('Upstream gateway is transiently unavailable — retry later');
    return true;
  }
  return false;
}

function parseTokenCount(raw) {
  return parseInt(raw.replace(/,/g, ''), 10);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('startup: banner on stdout and model line on stderr', { timeout: 10_000 }, async () => {
  // Startup should be observable without waiting on a model response.
  const { stdout, stderr } = await franklin('/exit', { timeoutMs: 10_000 });
  assert.ok(
    stdout.includes('blockrun.ai') && stdout.includes('The AI agent with a wallet'),
    `Missing banner tagline. stdout:\n${stdout}`
  );
  assert.ok(stderr.includes('Model:'), `Missing model line. stderr:\n${stderr}`);
});

test('simple response: model echoes back a unique token', { timeout: 60_000 }, async (t) => {
  const result = await franklin('say exactly and only this word: PONG_E2E_42');
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
  assert.ok(result.stdout.includes('PONG_E2E_42'), `Expected PONG_E2E_42 in output.\nstdout:\n${result.stdout}`);
});

test('bash tool: executes shell command and returns output', { timeout: 90_000 }, async (t) => {
  const result = await franklin(
    'Use the Bash tool to run: echo BASH_TOOL_WORKS. Report the exact output.'
  );
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
  assert.ok(
    result.stdout.includes('BASH_TOOL_WORKS'),
    `Expected BASH_TOOL_WORKS in output.\nstdout:\n${result.stdout}`
  );
});

test('write tool: creates a file with specified content', { timeout: 90_000 }, async (t) => {
  const testDir = join(tmpdir(), `rc-e2e-write-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'hello.txt');

  try {
    const result = await franklin(
      `Use the Write tool to create a file at ${targetFile} with content: E2E_WRITE_SUCCESS`,
      { cwd: testDir }
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
    assert.ok(existsSync(targetFile), `File was not created at ${targetFile}`);
    const content = readFileSync(targetFile, 'utf8');
    assert.ok(content.includes('E2E_WRITE_SUCCESS'), `File content wrong: ${content}`);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('read tool: reads a pre-existing file', { timeout: 90_000 }, async (t) => {
  const testDir = join(tmpdir(), `rc-e2e-read-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'data.txt');
  writeFileSync(targetFile, 'E2E_READ_MARKER_XYZ\nline two\nline three\n');

  try {
    const result = await franklin(
      `Use the Read tool to read the file at ${targetFile} and tell me the first line exactly.`,
      { cwd: testDir }
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
    assert.ok(
      result.stdout.includes('E2E_READ_MARKER_XYZ'),
      `Expected E2E_READ_MARKER_XYZ in output.\nstdout:\n${result.stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('glob tool: finds files by pattern', { timeout: 90_000 }, async (t) => {
  const testDir = join(tmpdir(), `rc-e2e-glob-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'alpha.txt'), 'a');
  writeFileSync(join(testDir, 'beta.txt'), 'b');
  writeFileSync(join(testDir, 'gamma.log'), 'c');

  try {
    const result = await franklin(
      `Use the Glob tool to find all *.txt files in ${testDir} and list their names.`,
      { cwd: testDir }
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
    assert.ok(result.stdout.includes('alpha.txt'), `Missing alpha.txt.\nstdout:\n${result.stdout}`);
    assert.ok(result.stdout.includes('beta.txt'), `Missing beta.txt.\nstdout:\n${result.stdout}`);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('grep tool: finds content in files', { timeout: 90_000 }, async (t) => {
  const testDir = join(tmpdir(), `rc-e2e-grep-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'haystack.txt'), 'line one\nGREP_NEEDLE_42\nline three\n');

  try {
    const result = await franklin(
      `Use the Grep tool to search for "GREP_NEEDLE_42" in ${testDir}/haystack.txt and tell me if it was found.`,
      { cwd: testDir }
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
    assert.ok(
      result.stdout.includes('GREP_NEEDLE_42'),
      `Expected GREP_NEEDLE_42 in output.\nstdout:\n${result.stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('bash tool: error exit code is captured', { timeout: 90_000 }, async (t) => {
  const result = await franklin(
    'Use the Bash tool to run: exit 42. Tell me what the exit code was.'
  );
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `franklin itself should exit 0. stdout:\n${result.stdout}`);
  assert.ok(
    result.stdout.includes('42'),
    `Expected mention of exit code 42 in output.\nstdout:\n${result.stdout}`
  );
});

test('multi-tool: write then read a file in same session', { timeout: 150_000 }, async (t) => {
  const testDir = join(tmpdir(), `rc-e2e-multi-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const targetFile = join(testDir, 'roundtrip.txt');

  try {
    const result = await franklin(
      `Step 1: Use the Write tool to create ${targetFile} with content: ROUNDTRIP_OK_789\n` +
      `Step 2: Use the Read tool to read that file back.\n` +
      `Step 3: Tell me the content you read.`,
      { cwd: testDir, timeoutMs: 140_000 }
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit. stdout:\n${result.stdout}`);
    assert.ok(existsSync(targetFile), `File not created at ${targetFile}`);
    assert.ok(
      result.stdout.includes('ROUNDTRIP_OK_789'),
      `Expected ROUNDTRIP_OK_789 in output.\nstdout:\n${result.stdout}`
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── Session cost tracking tests ───────────────────────────────────────────

test('session cost: token usage reported at session end', { timeout: 60_000 }, async (t) => {
  const result = await franklin('say exactly: COST_CHECK_OK');
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('Tokens:'),
    `Expected "Tokens:" summary in stderr.\nstderr:\n${result.stderr}`
  );
  const match = result.stderr.match(/Tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out/);
  assert.ok(match, `Could not parse token line from: ${result.stderr}`);
  const inputTokens = parseTokenCount(match[1]);
  const outputTokens = parseTokenCount(match[2]);
  assert.ok(inputTokens > 0, `Expected input tokens > 0, got ${inputTokens}`);
  assert.ok(outputTokens > 0, `Expected output tokens > 0, got ${outputTokens}`);
});

test('session cost: accumulates across multiple turns', { timeout: 120_000 }, async (t) => {
  const result = await franklin([
    'say exactly and only this word: TURN_ONE',
    'say exactly and only this word: TURN_TWO',
  ]);
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr: ${result.stderr}`);

  const match = result.stderr.match(/Tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out/);
  assert.ok(match, `Could not parse token line from: ${result.stderr}`);
  const inputTokens = parseTokenCount(match[1]);
  const outputTokens = parseTokenCount(match[2]);
  assert.ok(inputTokens >= 20, `Expected ≥20 input tokens for 2 turns, got ${inputTokens}`);
  assert.ok(outputTokens >= 2, `Expected ≥2 output tokens for 2 turns, got ${outputTokens}`);
});

test('session cost: /cost command shows cost info', { timeout: 60_000 }, async (t) => {
  const result = await franklin([
    'say exactly: BEFORE_COST',
    '/cost',
  ]);
  if (skipIfRateLimited(t, result)) return;
  assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('Tokens:'),
    `Expected "Tokens:" in /cost output.\nstderr:\n${result.stderr}`
  );
});

// ─── Weak-model polish regression tests ───────────────────────────────────
// These run against a live free model to verify the
// polish round: <think> tag stripping, [TOOLCALL] guardrail, streaming
// markdown sanitization. Use a trivial prompt so the assertions aren't
// flaky against model creativity.

test('polish: weak model respects instruction without leaking <think> or [TOOLCALL]',
  { timeout: 90_000 },
  async (t) => {
    const result = await franklin(
      'reply with exactly and only this token: POLISH_PROBE_OK',
      { model: 'nvidia/qwen3-coder-480b', timeoutMs: 80_000 },
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    // Core content landed
    assert.ok(result.stdout.includes('POLISH_PROBE_OK'),
      `Expected POLISH_PROBE_OK in output.\nstdout:\n${result.stdout}`);
    // <think> stripper: no raw tag leakage in rendered stdout
    assert.ok(!/<think>|<\/think>|<thinking>|<\/thinking>/i.test(result.stdout),
      `Raw think tags leaked into output:\n${result.stdout}`);
    // Hallucination guard: no role-played tool-call tokens in final text
    assert.ok(!/\[TOOLCALL\]|<tool_call>/.test(result.stdout),
      `Role-played tool-call tokens leaked:\n${result.stdout}`);
  },
);

// ─── Paid tool tests — gated behind RUN_PAID_E2E=1 ────────────────────────
// These tests actually spend USDC on live generation. Default is skipped so
// `npm run test:e2e` stays free on CI / repeated local runs. Set
// RUN_PAID_E2E=1 when you explicitly want to verify paid paths end-to-end.

// Exa paid e2e: use Sonnet-tier for deterministic behavior. Weak/default models
// can hang for minutes after the tool returns before emitting the follow-up
// narrative; Sonnet wraps up in seconds. Assertions focus on the tool-call log
// rather than the agent's narrative response, so we're testing the paid x402
// path end-to-end, not the agent's writing speed.
const EXA_MODEL = 'anthropic/claude-sonnet-4.6';

test('ExaSearch tool: returns results via BlockRun /v1/exa/search',
  { timeout: 120_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.01 USDC per run)' : false },
  async (t) => {
    const result = await franklin(
      'Use the ExaSearch tool with query "x402 payment protocol" and numResults: 3. ' +
      'Report the URL of the top result verbatim so I can verify.',
      { model: EXA_MODEL, timeoutMs: 110_000 },
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    const combined = result.stdout + result.stderr;
    assert.ok(/ExaSearch/.test(combined), `ExaSearch tool call not evident.\n${combined}`);
    assert.ok(/https?:\/\/\S+/.test(combined), `No URL surfaced.\n${combined}`);
  },
);

test('ExaAnswer tool: cited answer via BlockRun /v1/exa/answer',
  { timeout: 120_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.01 USDC per run)' : false },
  async (t) => {
    const result = await franklin(
      'Use the ExaAnswer tool to answer exactly this question: ' +
      '"What is the x402 payment protocol?". Report back briefly.',
      { model: EXA_MODEL, timeoutMs: 110_000 },
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    const combined = result.stdout + result.stderr;
    assert.ok(/ExaAnswer/.test(combined), `ExaAnswer tool call not evident.\n${combined}`);
    // Grounded answer should mention the concept — x402 / payment / HTTP 402
    assert.ok(/x402|payment|HTTP 402/i.test(result.stdout),
      `Answer doesn't mention x402/payment — not grounded.\n${result.stdout}`);
  },
);

test('ExaReadUrls tool: batch markdown fetch via BlockRun /v1/exa/contents',
  { timeout: 120_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.002 USDC per URL)' : false },
  async (t) => {
    // Use well-known high-traffic pages Exa definitely has indexed.
    const result = await franklin(
      'Use the ExaReadUrls tool to fetch this single URL: ["https://en.wikipedia.org/wiki/HTTP_402"]. ' +
      'Report briefly what the page is about.',
      { model: EXA_MODEL, timeoutMs: 110_000 },
    );
    if (skipIfRateLimited(t, result)) return;
    assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    const combined = result.stdout + result.stderr;
    assert.ok(/ExaReadUrls/.test(combined), `ExaReadUrls tool call not evident.\n${combined}`);
    // HTTP 402 Wikipedia page must mention status code or payment concept
    assert.ok(/402|payment|status code|HTTP/i.test(result.stdout),
      `Fetched content doesn't mention HTTP 402 / payment.\n${result.stdout}`);
  },
);

test('VideoGen tool: generates an MP4 via BlockRun /v1/videos/generations',
  { timeout: 300_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs ~$0.42 USDC per run)' : false },
  async (t) => {
    const testDir = join(tmpdir(), `rc-e2e-videogen-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const outFile = join(testDir, 'probe.mp4');

    try {
      const result = await franklin(
        `Use the VideoGen tool with these exact arguments: ` +
        `prompt="a red apple spinning slowly on a wooden table, daylight", ` +
        `output_path="${outFile}". ` +
        `After it finishes, tell me the final file path and file size.`,
        { cwd: testDir, timeoutMs: 290_000 },
      );
      if (skipIfRateLimited(t, result)) return;
      assert.equal(result.exitCode, 0, `Non-zero exit.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.ok(existsSync(outFile), `MP4 file was not created at ${outFile}.\nstdout:\n${result.stdout}`);
      const size = readFileSync(outFile).byteLength;
      assert.ok(size > 50_000, `MP4 suspiciously small (${size} bytes) — expected > 50KB for an 8s clip.`);
      // Sanity: first 4 bytes of an ISO-BMFF container are the size of the
      // ftyp box, followed by the literal "ftyp" atom at offset 4.
      const head = readFileSync(outFile).subarray(4, 8).toString('ascii');
      assert.equal(head, 'ftyp', `File at ${outFile} doesn't start with an ftyp atom — not a valid MP4. Header: ${head}`);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  },
);

// ─── PredictionMarket (Predexon) live wire-format tests ───────────────────
// These invoke the capability directly with the real wallet — bypassing the
// agent loop so failures pinpoint to wire format (param names, response
// shape, payment headers) without LLM-routing variance. Added 2026-05-06
// after the 3.15.70→3.15.72 walletProfile 422 chain — that bug would have
// been caught instantly by a paid e2e test calling the live endpoint.
//
// Test wallet `0xdfe3...c4` is a real, currently-active Polymarket wallet
// confirmed via the bash-curl fallback in a real user session. Same user
// reproducibly returns positions + P&L; if Polymarket rotates this wallet
// out, swap to any other live one.
const PM_TEST_WALLET = '0xdfe3fedc5c7679be42c3d393e99d4b55247b73c4';

test('PredictionMarket walletProfile (single): live /wallet/{addr} returns profile data',
  { timeout: 60_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.005 USDC per run)' : false },
  async () => {
    const { predictionMarketCapability } = await import('../dist/tools/prediction.js');
    const result = await predictionMarketCapability.execute(
      { action: 'walletProfile', wallets: PM_TEST_WALLET },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    assert.notEqual(result.isError, true, `walletProfile errored: ${result.output}`);
    assert.ok(/Polymarket wallet profile/i.test(result.output),
      `Expected profile header.\n${result.output}`);
    assert.ok(!/422|Bad Request|missing/i.test(result.output),
      `Output looks like the old 3.15.70-era 422 mode.\n${result.output}`);
    assert.ok(/\$0\.005 paid/.test(result.output),
      `Cost footer missing.\n${result.output}`);
    assert.ok(!/\[object Object\]/.test(result.output),
      `Formatter rendered a nested object as [object Object] — pickString fallback failed.\n${result.output}`);
  },
);

test('PredictionMarket walletPnl: live /wallet/pnl/{addr} returns P&L data',
  { timeout: 60_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.005 USDC per run)' : false },
  async () => {
    const { predictionMarketCapability } = await import('../dist/tools/prediction.js');
    const result = await predictionMarketCapability.execute(
      { action: 'walletPnl', wallets: PM_TEST_WALLET },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    assert.notEqual(result.isError, true, `walletPnl errored: ${result.output}`);
    assert.ok(/Polymarket wallet P&L/i.test(result.output),
      `Expected P&L header.\n${result.output}`);
    assert.ok(!/422|Bad Request|missing/i.test(result.output),
      `Output looks like a wire-format error.\n${result.output}`);
    assert.ok(!/\[object Object\]/.test(result.output),
      `Formatter rendered a nested object as [object Object] — pickString fallback failed.\n${result.output}`);
  },
);

test('PredictionMarket walletPositions: live /wallet/positions/{addr} returns positions',
  { timeout: 60_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.005 USDC per run)' : false },
  async () => {
    const { predictionMarketCapability } = await import('../dist/tools/prediction.js');
    const result = await predictionMarketCapability.execute(
      { action: 'walletPositions', wallets: PM_TEST_WALLET, limit: 5 },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    assert.notEqual(result.isError, true, `walletPositions errored: ${result.output}`);
    assert.ok(/Polymarket positions/i.test(result.output),
      `Expected positions header.\n${result.output}`);
    assert.ok(!/422|Bad Request|missing/i.test(result.output),
      `Output looks like a wire-format error.\n${result.output}`);
    assert.ok(!/\[object Object\]/.test(result.output),
      `Formatter rendered a nested object as [object Object] — pickString fallback failed.\n${result.output}`);
  },
);

test('PredictionMarket leaderboard: live /polymarket/leaderboard returns top wallets',
  { timeout: 60_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.001 USDC per run)' : false },
  async () => {
    const { predictionMarketCapability } = await import('../dist/tools/prediction.js');
    const result = await predictionMarketCapability.execute(
      { action: 'leaderboard', limit: 3 },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    assert.notEqual(result.isError, true, `leaderboard errored: ${result.output}`);
    assert.ok(/leaderboard/i.test(result.output),
      `Expected leaderboard header.\n${result.output}`);
    assert.ok(!/422|Bad Request|missing/i.test(result.output),
      `Output looks like a wire-format error.\n${result.output}`);
    assert.ok(!/\[object Object\]/.test(result.output),
      `Formatter rendered a nested object as [object Object] — pickString fallback failed.\n${result.output}`);
  },
);

test('PredictionMarket searchAll: live /markets/search returns multi-platform results',
  { timeout: 60_000, skip: process.env.RUN_PAID_E2E !== '1' ? 'RUN_PAID_E2E=1 to enable (costs $0.005 USDC per run)' : false },
  async () => {
    const { predictionMarketCapability } = await import('../dist/tools/prediction.js');
    const result = await predictionMarketCapability.execute(
      { action: 'searchAll', search: 'election', limit: 3 },
      { workingDir: process.cwd(), abortSignal: new AbortController().signal },
    );
    assert.notEqual(result.isError, true, `searchAll errored: ${result.output}`);
    assert.ok(/Cross-platform market search/i.test(result.output),
      `Expected cross-platform header.\n${result.output}`);
    assert.ok(!/422|Bad Request|missing/i.test(result.output),
      `Output looks like a wire-format error.\n${result.output}`);
    assert.ok(!/\[object Object\]/.test(result.output),
      `Formatter rendered a nested object as [object Object] — pickString fallback failed.\n${result.output}`);
  },
);

test('session cost: estimateCost returns non-negative value for known model', { timeout: 5_000 }, async () => {
  const { estimateCost } = await import('../dist/pricing.js');

  // GLM-5.1: $0.001 per call (flat pricing)
  const cost = estimateCost('zai/glm-5.1', 1_000_000, 1_000_000, 1);
  assert.ok(cost > 0, `Expected non-zero cost for GLM-5.1, got ${cost}`);
  assert.ok(cost <= 0.001, `GLM-5.1 is flat $0.001/call, got ${cost}`);

  // Free model should cost $0
  const freeCost = estimateCost('nvidia/qwen3-coder-480b', 1_000_000, 1_000_000);
  assert.equal(freeCost, 0, `Expected $0 for free model, got ${freeCost}`);

  // Unknown model should return > 0 (falls back to $2/$10 per 1M)
  const unknownCost = estimateCost('unknown/model-xyz', 1_000, 1_000);
  assert.ok(unknownCost >= 0, `Expected non-negative for unknown model, got ${unknownCost}`);
});
