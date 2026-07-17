/**
 * Deterministic tests for the lifecycle hook engine (src/hooks/) and the
 * spend-tool estimators (src/tools/spend-tools.ts). No network, no wallet.
 *
 * HOME is redirected to a temp dir BEFORE importing dist modules so hook
 * discovery, trust markers, and the approvals audit log never touch the
 * user's real ~/.blockrun.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-hooks-test-'));
process.env.HOME = TMP_HOME;

const { loadHooks, isProjectTrusted, userHooksDir } = await import('../dist/hooks/loader.js');
const { HookEngine } = await import('../dist/hooks/runner.js');
const { estimateSpendUsd, isSpendTool } = await import('../dist/tools/spend-tools.js');

const HOOKS_DIR = path.join(TMP_HOME, '.blockrun', 'hooks');
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-hooks-proj-'));

function writeHookFile(name, content) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOOKS_DIR, name), typeof content === 'string' ? content : JSON.stringify(content));
}

function writeScript(name, body) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const p = path.join(HOOKS_DIR, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function clearHooks() {
  fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
}

const baseInput = (tool, extra = {}) => ({
  hookEventName: 'PreToolUse',
  sessionId: 'test-session',
  cwd: PROJECT_DIR,
  timestamp: new Date().toISOString(),
  toolName: tool,
  toolInput: {},
  ...extra,
});

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

// ─── Loader ────────────────────────────────────────────────────────────────

test('loader: skips malformed files and unknown events, loads valid hooks', () => {
  clearHooks();
  writeHookFile('broken.json', '{not json');
  writeHookFile('foreign.json', { hooks: { SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'true' }] }] } });
  writeHookFile('valid.json', { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } });

  const loaded = loadHooks(PROJECT_DIR);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].event, 'PreToolUse');
  assert.equal(loaded[0].scope, 'user');
  assert.ok(loaded[0].matcher.test('Bash'));
});

test('loader: rejects matchers on lifecycle events and invalid regexes', () => {
  clearHooks();
  writeHookFile('lifecycle-matcher.json', { hooks: { SessionStart: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] } });
  writeHookFile('bad-regex.json', { hooks: { PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'true' }] }] } });
  assert.equal(loadHooks(PROJECT_DIR).length, 0);
});

test('loader: project hooks gated on trust marker', () => {
  clearHooks();
  const projHooks = path.join(PROJECT_DIR, '.franklin', 'hooks');
  fs.mkdirSync(projHooks, { recursive: true });
  fs.writeFileSync(
    path.join(projHooks, 'proj.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } })
  );

  assert.equal(isProjectTrusted(PROJECT_DIR), false);
  assert.equal(loadHooks(PROJECT_DIR).length, 0, 'untrusted project hooks must not load');

  fs.mkdirSync(path.join(TMP_HOME, '.blockrun'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, '.blockrun', 'trusted-projects.json'),
    JSON.stringify([PROJECT_DIR])
  );
  assert.equal(isProjectTrusted(PROJECT_DIR), true);
  const loaded = loadHooks(PROJECT_DIR);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].scope, 'project');
});

// ─── Runner semantics ──────────────────────────────────────────────────────

test('runner: exit 0 allows', async () => {
  clearHooks();
  writeHookFile('allow.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'allow');
});

test('runner: exit 2 denies', async () => {
  clearHooks();
  writeHookFile('deny.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'deny');
});

test('runner: stdout deny wins regardless of exit code', async () => {
  clearHooks();
  writeHookFile('stdout-deny.json', {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `echo '{"decision":"deny","reason":"policy says no"}'; exit 0` }] }] },
  });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'policy says no');
});

test('runner: timeout fails open', async () => {
  clearHooks();
  writeHookFile('slow.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 10', timeout: 1 }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const started = Date.now();
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'allow', 'timeout must fail open');
  assert.ok(Date.now() - started < 5000, 'timeout must actually cut the handler short');
});

test('runner: missing binary fails open', async () => {
  clearHooks();
  writeHookFile('missing.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/nonexistent/binary-xyz' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'allow');
});

test('runner: matcher filters by tool name', async () => {
  clearHooks();
  writeHookFile('bash-only.json', { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'exit 2' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  assert.equal((await engine.dispatch('PreToolUse', baseInput('Bash'))).decision, 'deny');
  assert.equal((await engine.dispatch('PreToolUse', baseInput('Read'))).decision, 'allow');
});

test('runner: handler receives the JSON envelope on stdin', async () => {
  clearHooks();
  const outFile = path.join(TMP_HOME, 'stdin-capture.json');
  writeScript('capture.sh', `cat > "${outFile}"`);
  writeHookFile('capture.json', { hooks: { PreSpend: [{ hooks: [{ type: 'command', command: 'capture.sh' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  await engine.dispatch('PreSpend', baseInput('JupiterSwap', {
    hookEventName: 'PreSpend',
    spend: { estimatedUsd: 12.5, tool: 'JupiterSwap', params: { amount: 12.5 } },
  }));
  const captured = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.equal(captured.hookEventName, 'PreSpend');
  assert.equal(captured.spend.estimatedUsd, 12.5);
  assert.equal(captured.sessionId, 'test-session');
});

test('runner: deny on a non-blocking event does not block', async () => {
  clearHooks();
  writeHookFile('post-deny.json', { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PostToolUse', { ...baseInput('Bash'), hookEventName: 'PostToolUse' });
  assert.equal(d.decision, 'allow');
});

test('runner: first deny short-circuits and is audited', async () => {
  clearHooks();
  writeHookFile('a-deny.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } });
  writeHookFile('b-marker.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `touch "${TMP_HOME}/second-ran"` }] }] } });
  const engine = new HookEngine({ workDir: PROJECT_DIR });
  const d = await engine.dispatch('PreToolUse', baseInput('Bash'));
  assert.equal(d.decision, 'deny');
  assert.equal(fs.existsSync(path.join(TMP_HOME, 'second-ran')), false, 'later hooks must not run after a deny');

  const audit = fs.readFileSync(path.join(TMP_HOME, '.blockrun', 'approvals.jsonl'), 'utf-8').trim().split('\n');
  const last = JSON.parse(audit[audit.length - 1]);
  assert.equal(last.kind, 'hook');
  assert.equal(last.decision, 'deny');
  assert.equal(last.subject, 'Bash');
});

// ─── Spend estimators ──────────────────────────────────────────────────────

test('spend estimators: stable-denominated amounts price 1:1, unknown tokens null', () => {
  assert.equal(isSpendTool('JupiterSwap'), true);
  assert.equal(isSpendTool('Read'), false);

  assert.equal(estimateSpendUsd('JupiterSwap', { input_mint: 'USDC', amount: 25 }), 25);
  assert.equal(estimateSpendUsd('JupiterSwap', { input_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 3 }), 3);
  assert.equal(estimateSpendUsd('JupiterSwap', { input_mint: 'SOL', amount: 1 }), null);

  assert.equal(estimateSpendUsd('Base0xSwap', { sell_token: 'USDC', sell_amount: 10 }), 10);
  assert.equal(estimateSpendUsd('Base0xSwap', { sell_token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', sell_amount: 7 }), 7);
  assert.equal(estimateSpendUsd('Base0xSwap', { sell_token: 'WETH', sell_amount: 1 }), null);

  assert.equal(estimateSpendUsd('PolymarketBet', { action: 'buy', amount_usd: 5 }), 5);
  assert.equal(estimateSpendUsd('PolymarketBet', { action: 'buy', price: 0.4, size: 10 }), 4);
  assert.equal(estimateSpendUsd('PolymarketBet', { action: 'positions' }), null);
  assert.equal(estimateSpendUsd('PolymarketBet', { action: 'withdraw', amount_usd: 50 }), null, 'withdraw is not a spend');

  assert.equal(estimateSpendUsd('BuyPhoneNumber', {}), 5);
  assert.equal(estimateSpendUsd('ImageGen', { prompt: 'x' }), null);
});
