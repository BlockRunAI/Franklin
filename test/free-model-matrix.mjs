/**
 * Live free-model matrix for Franklin.
 *
 * Run:
 *   npm run test:free-models
 *   FREE_MODEL_MATRIX=nvidia/qwen3-coder-480b,nvidia/llama-4-maverick npm run test:free-models
 *   FREE_MODEL_MATRIX=all npm run test:free-models
 *   FREE_MODEL_MATRIX_PROBES=echo npm run test:free-models
 *
 * This suite calls the live gateway. It spends no USDC, but it can hit the
 * free-tier rate limit, so upstream/rate-limit failures are skipped rather
 * than treated as deterministic code regressions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const DIST = new URL('../dist/index.js', import.meta.url).pathname;
const TIMEOUT_MS = Number.parseInt(process.env.FREE_MODEL_MATRIX_TIMEOUT_MS || '180000', 10);

const { MODEL_PRICING, estimateCost } = await import('../dist/pricing.js');
const { PICKER_CATEGORIES, resolveModel } = await import('../dist/ui/model-picker.js');

const freeCategory = PICKER_CATEGORIES.find((category) => /Free/.test(category.category));
if (!freeCategory) throw new Error('Free model picker category not found');

const requestedModels = (process.env.FREE_MODEL_MATRIX || '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)
  .map(resolveModel);

const defaultMatrixModels = new Set([
  'nvidia/qwen3-coder-480b',
  'nvidia/llama-4-maverick',
]);

const selectedModels = process.env.FREE_MODEL_MATRIX === 'all'
  ? freeCategory.models
  : requestedModels.length > 0
  ? freeCategory.models.filter((entry) => requestedModels.includes(entry.id))
  : freeCategory.models.filter((entry) => defaultMatrixModels.has(entry.id));

if (selectedModels.length === 0) {
  throw new Error(`No free models selected. Requested: ${requestedModels.join(', ') || '(default)'}`);
}

const probes = new Set(
  (process.env.FREE_MODEL_MATRIX_PROBES || 'echo,bash')
    .split(',')
    .map((probe) => probe.trim().toLowerCase())
    .filter(Boolean),
);

function safeId(model) {
  return model.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function franklin(prompt, { model, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const proc = spawn('node', [DIST, '--model', model, '--trust'], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        FRANKLIN_NO_ANALYZER: '1',
        FRANKLIN_NO_EVAL: '1',
        FRANKLIN_NO_PREFETCH: '1',
        FRANKLIN_NO_UPDATE_CHECK: '1',
        FRANKLIN_PANEL_AUTOSTART: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.stdin.write(`${prompt}\n`);
    proc.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut });
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function skipIfUnavailable(t, result) {
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const lower = combined.toLowerCase();

  if (result.timedOut) {
    t.skip('Live gateway/model call exceeded the matrix harness timeout — retry later');
    return true;
  }
  if (
    combined.includes('max 60 requests/hour') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    combined.includes('Free tier')
  ) {
    t.skip('Free tier rate limited — retry later');
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
    t.skip('Live gateway/network unavailable from this environment');
    return true;
  }
  if (
    lower.includes('insufficient') ||
    lower.includes('payment required') ||
    lower.includes('verification failed') ||
    lower.includes('[payment]')
  ) {
    t.skip('Model path unexpectedly requires payment or wallet verification');
    return true;
  }
  if (
    lower.includes('[server]') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('workers are busy') ||
    lower.includes('overloaded')
  ) {
    t.skip('Upstream gateway is transiently unavailable');
    return true;
  }
  return false;
}

function assertNoModelArtifacts(model, stdout) {
  assert.ok(
    !/<think>|<\/think>|<thinking>|<\/thinking>/i.test(stdout),
    `${model} leaked raw thinking tags:\n${stdout}`,
  );
  assert.ok(
    !/\[TOOLCALL\]|<tool_call>|<\/tool_call>/i.test(stdout),
    `${model} leaked role-played tool-call text:\n${stdout}`,
  );
}

test('free model matrix catalog is zero-cost and NVIDIA-backed', () => {
  assert.ok(selectedModels.length > 0, 'Expected at least one free model');
  for (const entry of selectedModels) {
    assert.ok(entry.id.startsWith('nvidia/'), `${entry.id} should be NVIDIA-backed free tier`);
    assert.equal(entry.price, 'FREE', `${entry.id} should render as FREE`);
    assert.equal(resolveModel(entry.shortcut), entry.id, `${entry.shortcut} shortcut drifted`);
    const pricing = MODEL_PRICING[entry.id];
    assert.ok(pricing, `${entry.id} missing from MODEL_PRICING`);
    assert.equal(pricing.input, 0, `${entry.id} input price must be zero`);
    assert.equal(pricing.output, 0, `${entry.id} output price must be zero`);
    assert.equal(pricing.perCall ?? 0, 0, `${entry.id} must not gain per-call pricing`);
    assert.equal(estimateCost(entry.id, 1_000_000, 1_000_000), 0, `${entry.id} should estimate to $0`);
  }
});

if (probes.has('echo')) {
  for (const entry of selectedModels) {
    test(`free model exact echo: ${entry.id}`, { timeout: TIMEOUT_MS + 5_000 }, async (t) => {
      const marker = `FREE_MATRIX_${safeId(entry.id)}_ECHO_OK`;
      const result = await franklin(`Reply with exactly and only this token: ${marker}`, {
        model: entry.id,
      });
      if (skipIfUnavailable(t, result)) return;
      assert.equal(result.exitCode, 0, `Non-zero exit for ${entry.id}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.ok(result.stdout.includes(marker), `Expected ${marker} from ${entry.id}.\nstdout:\n${result.stdout}`);
      assertNoModelArtifacts(entry.id, result.stdout);
    });
  }
}

if (probes.has('bash')) {
  for (const entry of selectedModels) {
    test(`free model bash tool: ${entry.id}`, { timeout: TIMEOUT_MS + 5_000 }, async (t) => {
      const marker = `FREE_MATRIX_${safeId(entry.id)}_BASH_OK`;
      const result = await franklin(
        `Use the Bash tool to run: printf ${marker}. Then report the exact output.`,
        { model: entry.id },
      );
      if (skipIfUnavailable(t, result)) return;
      assert.equal(result.exitCode, 0, `Non-zero exit for ${entry.id}.\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
      assert.ok(result.stdout.includes(marker), `Expected bash marker ${marker} from ${entry.id}.\nstdout:\n${result.stdout}`);
      assertNoModelArtifacts(entry.id, result.stdout);
    });
  }
}
