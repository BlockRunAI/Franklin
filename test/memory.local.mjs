/**
 * Deterministic tests for the document-memory subsystem (src/memory/):
 * identity keying, markdown store, TF search with decay + staleness,
 * trading capture, session summaries, and dream consolidation gates.
 * No network — the dream LLM call uses a fake client.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-memory-test-'));
process.env.HOME = TMP_HOME;

const {
  workspaceKey, workspaceMemoryPath, globalMemoryPath, appendUnderHeading,
  writeSessionLog, sessionLogsDir, tradingJournalPath, thesisPath, memoryRoot,
} = await import('../dist/memory/store.js');
const { searchMemory, formatMemoryContext, resetMemoryIndexCache } = await import('../dist/memory/indexer.js');
const { captureTradeEvent, writeSessionMetadataSummary } = await import('../dist/memory/capture.js');
const { dreamGatesPass, runDream } = await import('../dist/memory/dream.js');

const WORK_A = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-mem-work-a-'));
const WORK_B = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-mem-work-b-'));

after(() => {
  for (const d of [TMP_HOME, WORK_A, WORK_B]) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir, ...args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

// ─── Identity keying ───────────────────────────────────────────────────────

test('identity: non-repo dirs key by path; clones of one origin share a key', () => {
  const a = workspaceKey(WORK_A);
  const b = workspaceKey(WORK_B);
  assert.notEqual(a.hash8, b.hash8, 'different dirs = different identities');
  assert.deepEqual(workspaceKey(WORK_A), a, 'stable across calls');

  // Two "clones" with the same origin remote share one memory identity.
  const cloneA = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-mem-clone-a-'));
  const cloneB = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-mem-clone-b-'));
  try {
    for (const c of [cloneA, cloneB]) {
      git(c, 'init', '-q');
      git(c, 'remote', 'add', 'origin', 'git@github.com:acme/franklin-strategies.git');
    }
    assert.equal(workspaceKey(cloneA).hash8, workspaceKey(cloneB).hash8, 'memory follows the repo, not the checkout');
  } finally {
    fs.rmSync(cloneA, { recursive: true, force: true });
    fs.rmSync(cloneB, { recursive: true, force: true });
  }
});

// ─── Store ─────────────────────────────────────────────────────────────────

test('appendUnderHeading creates and extends heading blocks in place', () => {
  const p = workspaceMemoryPath(WORK_A);
  appendUnderHeading(p, 'Preferences', 'prefers limit orders');
  appendUnderHeading(p, 'Theses', 'SOL consolidation breakout');
  appendUnderHeading(p, 'Preferences', 'max 2% position size');

  const content = fs.readFileSync(p, 'utf-8');
  const prefIdx = content.indexOf('## Preferences');
  const thesisIdx = content.indexOf('## Theses');
  assert.ok(prefIdx !== -1 && thesisIdx !== -1);
  const prefBlock = content.slice(prefIdx, thesisIdx);
  assert.match(prefBlock, /limit orders/);
  assert.match(prefBlock, /max 2% position size/, 'second note lands under the SAME heading');
  assert.doesNotMatch(prefBlock, /breakout/);
});

// ─── Search: scopes, decay, staleness ──────────────────────────────────────

test('search: finds curated + session content, decays old session logs, flags staleness', () => {
  resetMemoryIndexCache();
  fs.mkdirSync(path.dirname(globalMemoryPath()), { recursive: true });
  fs.writeFileSync(globalMemoryPath(), '# Global\n\n## Facts\n- the funding wallet lives on base chain\n');
  writeSessionLog(WORK_A, 'sessfresh', '# Session\nexplored the solana validator economics deep dive');

  // ~10 days old: decayed (half-life 7d) and stale (>3d) but still above the
  // score floor. A years-old log would decay out of the results entirely —
  // which is the intended fade-to-nothing behavior.
  const oldLog = path.join(sessionLogsDir(WORK_A), '2020-01-01-oldsess.md');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, '# Session\nsolana validator economics from long ago with much more detail');
  const old = new Date(Date.now() - 10 * 86_400_000);
  fs.utimesSync(oldLog, old, old);

  const hits = searchMemory('solana validator economics', WORK_A, { limit: 6 });
  assert.ok(hits.length >= 2, `expected fresh + old session hits, got ${hits.length}`);
  // Session log filenames carry sessionId.slice(0, 8) — 'sessfres'.
  const fresh = hits.find(h => h.file.includes('sessfres'));
  const stale = hits.find(h => h.file === oldLog);
  assert.ok(fresh && stale);
  assert.ok(fresh.score > stale.score, 'temporal decay must rank the old session below the fresh one');
  assert.match(stale.stalenessNote, /verify current state/);
  assert.equal(fresh.stalenessNote, undefined);

  const global = searchMemory('funding wallet', WORK_A);
  assert.equal(global[0].scope, 'global');
  assert.equal(global[0].stalenessNote, undefined, 'curated files never carry staleness');

  const ctxBlock = formatMemoryContext(hits);
  assert.match(ctxBlock, /^<memory-recall>/);
  assert.match(ctxBlock, /\[session\]/);
  assert.equal(searchMemory('', WORK_A).length, 0);
});

// ─── Trading capture ───────────────────────────────────────────────────────

test('captureTradeEvent journals opens/bets/closes keyed by wallet', () => {
  const addr = '0xAbCdEf1234567890';
  captureTradeEvent({ kind: 'open', chain: 'base', address: addr, asset: 'SOL', amountUsd: 25, thesis: 'breakout above the range', ref: 'tp_1' });
  captureTradeEvent({ kind: 'bet', chain: 'base', address: addr, asset: 'election-yes', amountUsd: 5, ref: 'tp_2' });
  captureTradeEvent({ kind: 'close', chain: 'base', address: addr, asset: 'SOL', amountUsd: 30, pnlUsd: 5, ref: 'tp_3' });

  const journal = fs.readFileSync(tradingJournalPath('base', addr), 'utf-8');
  assert.match(journal, /## Open positions/);
  assert.match(journal, /OPEN SOL \$25\.00/);
  assert.match(journal, /## Bets/);
  assert.match(journal, /## Closed positions/);
  assert.match(journal, /P&L \+\$5\.00/);

  const thesis = fs.readFileSync(thesisPath('base', addr, 'SOL'), 'utf-8');
  assert.match(thesis, /breakout above the range/);
  assert.match(thesis, /## Outcomes/);

  // Wallet-keyed recall: a completely different workDir still finds the thesis.
  resetMemoryIndexCache();
  const recall = searchMemory('breakout range thesis', WORK_B);
  assert.ok(recall.some(h => h.scope === 'trading'), 'trading memory follows the wallet, not the directory');
});

// ─── Session summaries ─────────────────────────────────────────────────────

test('writeSessionMetadataSummary skips trivial sessions, writes topics for real ones', () => {
  assert.equal(
    writeSessionMetadataSummary({ workDir: WORK_B, sessionId: 'triv0001', history: [{ role: 'user', content: 'hi' }] }),
    false
  );

  const history = [
    { role: 'user', content: 'analyze the SOL funding rates across venues' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now compare with ETH and rank by carry' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'Continue working the active goal. Address open verification gaps first; ignored' },
    { role: 'user', content: 'save the ranking to a file' },
  ];
  assert.equal(writeSessionMetadataSummary({ workDir: WORK_B, sessionId: 'real0001', history }), true);
  const files = fs.readdirSync(sessionLogsDir(WORK_B)).filter(f => f.includes('real0001'));
  assert.equal(files.length, 1);
  const log = fs.readFileSync(path.join(sessionLogsDir(WORK_B), files[0]), 'utf-8');
  assert.match(log, /user prompts: 3/, 'goal continuations are not user prompts');
  assert.match(log, /funding rates/);
});

// ─── Dream ─────────────────────────────────────────────────────────────────

function fakeClient(text) {
  return {
    complete: async () => ({
      content: [{ type: 'text', text }],
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end_turn',
    }),
  };
}

test('dream: gates require 3 logs; run consolidates and archives', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-mem-dream-'));
  try {
    assert.equal(dreamGatesPass(workDir), false, 'no logs yet');
    writeSessionLog(workDir, 'aaaa0001', '# S1\nlearned about venue A fees');
    writeSessionLog(workDir, 'bbbb0002', '# S2\nlearned about venue B fees');
    assert.equal(dreamGatesPass(workDir), false, 'two logs is below the gate');
    writeSessionLog(workDir, 'cccc0003', '# S3\nlearned venue A beats B on fees');
    assert.equal(dreamGatesPass(workDir), true);

    const result = await runDream({
      client: fakeClient('# Memory\n\n## Venues\n- venue A beats venue B on fees'),
      model: 'local/test-dream',
      workDir,
      force: true,
    });
    assert.equal(result.consolidated, true);
    assert.equal(result.logsConsumed, 3);
    assert.match(fs.readFileSync(workspaceMemoryPath(workDir), 'utf-8'), /venue A beats venue B/);
    assert.equal(fs.readdirSync(sessionLogsDir(workDir)).filter(f => f.endsWith('.md')).length, 0, 'logs archived out of the search path');
    assert.ok(fs.existsSync(path.join(sessionLogsDir(workDir), 'archived')));
    assert.equal(dreamGatesPass(workDir), false, 'fresh dream resets the time gate');

    const junk = await runDream({ client: fakeClient('sorry, cannot help'), model: 'local/test-dream', workDir, force: true });
    assert.equal(junk.consolidated, false, 'non-markdown output must not clobber curated memory');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('memory kill switch disables search', () => {
  process.env.FRANKLIN_MEMORY = '0';
  resetMemoryIndexCache();
  assert.equal(searchMemory('funding wallet', WORK_A).length, 0);
  delete process.env.FRANKLIN_MEMORY;
});
