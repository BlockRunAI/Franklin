/**
 * Deterministic tests for the payment hold (src/agent/payment-hold.ts +
 * SessionToolGuard). Reproduces the EmberTail 3.49.6 audit cases end to end
 * through the real StreamingExecutor with a scripted Bash handler:
 *   S19 / S40 — the first send settled but answered with a timeout / 502,
 *               then the model re-sends from a REWRITTEN script.
 *   S37 / S41 — nothing was processed; same replies.
 * plus the unpaid-without-checking record, reconciliation, recipient keying,
 * script files written to disk, background sends and thrown sends.
 * No network, no wallet, no model calls.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-payhold-test-'));
process.env.HOME = TMP_HOME;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-payhold-work-'));

const hold = await import('../dist/agent/payment-hold.js');
const { SessionToolGuard } = await import('../dist/agent/tool-guard.js');
const { StreamingExecutor } = await import('../dist/agent/streaming-executor.js');
const { approvalsLogPath } = await import('../dist/audit/approvals.js');
const { createHeadlessApprovalFn } = await import('../dist/commands/start.js');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
});

const SUPPLIER_A = '0x1111111111111111111111111111111111111111';
const SUPPLIER_B = '0x2222222222222222222222222222222222222222';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HASH_1 = '0x' + 'ab'.repeat(32);
const HASH_2 = '0x' + 'cd'.repeat(32);

/** A viem-style payment script, as the model writes them. */
function payScript(recipient, variant = 'a') {
  if (variant === 'a') {
    return `node -e "const { createWalletClient, http, parseUnits } = require('viem');
const hash = await wallet.writeContract({ address: '${USDC_BASE}', abi, functionName: 'transfer', args: ['${recipient}', parseUnits('200', 6)] });
console.log(hash);"`;
  }
  // The rewrite the model produced after its first script errored: different
  // text, same obligation.
  return `cat > /dev/null <<'EOF'
retry
EOF
node --input-type=module -e "import { encodeFunctionData } from 'viem';
const data = encodeFunctionData({ abi, functionName: 'transfer', args: ['${recipient}', 200000000n] });
const txHash = await walletClient.sendTransaction({ to: '${USDC_BASE}', data });
console.log('Transaction hash:', txHash);"`;
}

/** Stand-in Edit/Write: records the call, touches nothing. */
function fileTool(name) {
  return {
    spec: {
      name,
      description: `stand-in ${name}`,
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, content: { type: 'string' } } },
    },
    async execute() { return { output: `${name} ok` }; },
    concurrent: false,
  };
}

/**
 * Executor wired with the real guard and a scripted Bash. `replies` is a
 * queue of results for SEND commands; `ledger` counts sends that actually
 * reached the handler (i.e. were not held).
 */
let harnessCount = 0;
function harness({ replies = [], onApproval, recon = { output: 'nonce=5 balance=800' }, sessionId } = {}) {
  const sid = sessionId ?? `payhold-${process.pid}-${++harnessCount}`;
  const ledger = { sends: 0, recons: 0, records: [] };
  const queue = [...replies];
  const bash = {
    spec: {
      name: 'Bash',
      description: 'scripted bash',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' }, run_in_background: { type: 'boolean' } },
        required: ['command'],
      },
    },
    async execute(input) {
      const text = String(input.command);
      if (hold.isPaymentSend(hold.bashExecutedText(text, WORK))) {
        ledger.sends++;
        const next = queue.shift() ?? { output: HASH_2 };
        if (next.throw) throw new Error(next.throw);
        return next;
      }
      if (hold.isReconciliation(text)) {
        ledger.recons++;
        return recon;
      }
      return { output: 'ok' };
    },
    concurrent: false,
  };
  const recordOutcome = {
    spec: {
      name: 'RecordOutcome',
      description: 'third-party outcome tool (like EmberTail\'s)',
      input_schema: { type: 'object', properties: { status: { type: 'string' }, note: { type: 'string' } } },
    },
    async execute(input) {
      ledger.records.push(input.status);
      return { output: `recorded ${input.status}` };
    },
    concurrent: false,
  };
  const guard = new SessionToolGuard(sid);
  const exec = new StreamingExecutor({
    handlers: new Map([['Bash', bash], ['RecordOutcome', recordOutcome], ['Edit', fileTool('Edit')], ['Write', fileTool('Write')]]),
    scope: {
      workingDir: WORK,
      abortSignal: new AbortController().signal,
      sessionId: sid,
      ...(onApproval ? { onApproval } : {}),
    },
    guard,
    onStart: () => {},
    sessionId: sid,
  });
  let n = 0;
  const run = (name, input) =>
    exec.executeWithPermissions({ id: `inv-${++n}`, name, input, type: 'tool_use' }, 1, false);
  return { run, ledger, guard };
}

// ─── Detection ─────────────────────────────────────────────────────────────

test('detects sends across viem, ethers, web3.py, CLIs and x402; not reads', () => {
  for (const s of [
    'await wallet.writeContract({ functionName: "transfer" })',
    'await client.sendTransaction({ to, value })',
    'await usdc.transfer(to, amt)',
    'w3.eth.send_raw_transaction(signed.raw_transaction)',
    'cast send 0xabc "transfer(address,uint256)"',
    'spl-token transfer EPj 200 Recip',
    'await sendAndConfirmTransaction(conn, tx, [payer])',
    'const f = wrapFetchWithPayment(fetch, account)',
  ]) assert.equal(hold.isPaymentSend(s), true, s);
  for (const s of [
    'await client.getTransactionReceipt({ hash })',
    'cast receipt 0xabc',
    'ls -la && cat notes.md',
    'console.log(balance.toString())',
  ]) assert.equal(hold.isPaymentSend(s), false, s);
  assert.equal(hold.isReconciliation('await client.getTransactionReceipt({ hash })'), true);
  assert.equal(hold.isReconciliation('await c.getTransactionReceipt({hash}); await w.sendTransaction(tx)'), false);
});

test('ambiguous outcomes: timeout, 5xx, dropped socket, background, error after hash', () => {
  const r = hold.ambiguousOutcomeReason;
  assert.ok(r('TimeoutError: payment response unavailable', true, false));
  assert.ok(r('Error: HTTP 502: Bad gateway', true, false));
  assert.ok(r('Error: socket hang up', true, false));
  assert.ok(r('502 upstream response lost', true, false));
  assert.ok(r('(command killed — timeout after 120s.)', true, false));
  assert.ok(r(`sent ${HASH_1}\nError: something odd`, true, false));
  assert.ok(r('started', false, true));
  // Conclusive: clean success, pre-send script error, amounts that look like 5xx.
  assert.equal(r(`Transaction hash: ${HASH_1}`, false, false), null);
  assert.equal(r('TypeError: publicClient.simulateContract is not a function', true, false), null);
  assert.equal(r('Paid 500 USDC', false, false), null);
});

test('recipients exclude token contracts and the own wallet', () => {
  const got = hold.extractRecipients(payScript(SUPPLIER_A), [SUPPLIER_B]);
  assert.deepEqual(got, [SUPPLIER_A]);
  assert.deepEqual(hold.extractRecipients(`pay ${SUPPLIER_B}`, [SUPPLIER_B]), []);
  assert.equal(hold.attemptsOverlap([SUPPLIER_A], [SUPPLIER_B]), false);
  assert.equal(hold.attemptsOverlap([], [SUPPLIER_B]), true, 'unknown recipient matches any send');
});

test('negative-outcome records are recognised in tool inputs', () => {
  assert.equal(hold.recordsNegativeOutcome(JSON.stringify({ status: 'unpaid' })), true);
  assert.equal(hold.recordsNegativeOutcome(JSON.stringify({ status: 'failed' })), true);
  assert.equal(hold.recordsNegativeOutcome('the USDC transfer failed'), true);
  assert.equal(hold.recordsNegativeOutcome(JSON.stringify({ status: 'unknown' })), false);
  assert.equal(hold.recordsNegativeOutcome(JSON.stringify({ status: 'completed' })), false);
});

// ─── EmberTail cases, end to end ───────────────────────────────────────────

for (const [label, reply] of [
  ['S19/S37 timeout', { output: 'Error during USDC transfer: TimeoutError: payment response unavailable', isError: true }],
  ['S40/S41 502', { output: 'Error: HTTP 502: Bad gateway', isError: true }],
]) {
  test(`${label}: rewritten resend is held when no one approves (headless)`, async () => {
    const { run, ledger } = harness({
      replies: [reply],
      onApproval: createHeadlessApprovalFn(true, 1000),
    });
    const first = await run('Bash', { command: payScript(SUPPLIER_A, 'a') });
    assert.match(first.output, /OUTCOME UNKNOWN/);
    assert.match(first.output, /NOT a failure/);
    assert.equal(ledger.sends, 1);

    const second = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
    assert.equal(second.isError, true);
    assert.match(second.output, /Payment held/);
    assert.match(second.output, /NOT sent/);
    assert.equal(ledger.sends, 1, 'the second payment must never reach the chain');
  });

  test(`${label}: recording "unpaid" before any check is refused; "unknown" passes`, async () => {
    const { run, ledger } = harness({ replies: [reply] });
    await run('Bash', { command: payScript(SUPPLIER_A) });
    const unpaid = await run('RecordOutcome', { status: 'unpaid', note: 'transfer failed' });
    assert.equal(unpaid.isError, true);
    assert.match(unpaid.output, /UNKNOWN/);
    assert.deepEqual(ledger.records, []);
    const unknown = await run('RecordOutcome', { status: 'unknown' });
    assert.equal(unknown.isError, undefined);
    assert.deepEqual(ledger.records, ['unknown']);
  });
}

test('after a read-only reconciliation, an outcome may be recorded; sends stay held', async () => {
  const { run, ledger } = harness({
    replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const recon = await run('Bash', { command: `node -e "await client.getBalance({ address: '${SUPPLIER_A}' })"` });
  assert.equal(recon.isError, undefined);
  assert.equal(ledger.recons, 1);
  const rec = await run('RecordOutcome', { status: 'unpaid' });
  assert.equal(rec.isError, undefined, 'a check ran — the model may now record what it found');
  const resend = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(resend.output, /Payment held/, 'resending still needs the user');
  assert.equal(ledger.sends, 1);
});

test('a reconciliation that itself times out establishes nothing', async () => {
  const { run } = harness({
    replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }],
    recon: { output: 'TimeoutError: request timed out', isError: true },
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  await run('Bash', { command: 'cast receipt ' + HASH_1 });
  const rec = await run('RecordOutcome', { status: 'failed' });
  assert.equal(rec.isError, true);
});

test('the user can explicitly allow a resend; it then executes once', async () => {
  const asked = [];
  const { run, ledger, guard } = harness({
    replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }, { output: `Transaction hash: ${HASH_2}` }],
    onApproval: async (req) => { asked.push(req); return { choice: 'approve' }; },
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  // Identical command text — the exact-command dedup must not swallow it
  // once the user has approved.
  const second = await run('Bash', { command: payScript(SUPPLIER_A) });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'payment-hold');
  assert.deepEqual(asked[0].options, ['approve', 'deny']);
  assert.match(asked[0].description, /may already have\s+settled/);
  assert.match(second.output, new RegExp(HASH_2));
  assert.equal(ledger.sends, 2);
  assert.equal(guard.unresolvedPaymentAttempts().length, 0);

  const log = fs.readFileSync(approvalsLogPath(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(r => r.kind === 'payment-hold' && r.decision === 'approve'));
});

test('a user deny keeps the hold', async () => {
  const { run, ledger } = harness({
    replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }],
    onApproval: async () => ({ choice: 'deny' }),
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const second = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(second.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('a payment to a DIFFERENT recipient is not held', async () => {
  const { run, ledger } = harness({
    replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const other = await run('Bash', { command: payScript(SUPPLIER_B) });
  assert.doesNotMatch(other.output, /Payment held/);
  assert.equal(ledger.sends, 2);
});

test('a clean payment creates no hold', async () => {
  const { run, ledger } = harness({ replies: [{ output: `Transaction hash: ${HASH_1}` }] });
  const first = await run('Bash', { command: payScript(SUPPLIER_A) });
  assert.doesNotMatch(first.output, /OUTCOME UNKNOWN/);
  await run('Bash', { command: payScript(SUPPLIER_B) });
  assert.equal(ledger.sends, 2);
});

test('a script written to disk and run by path is still recognised', async () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  fs.writeFileSync(path.join(WORK, 'pay2.mjs'), payScript(SUPPLIER_A, 'b'));
  const { run, ledger } = harness({
    replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }],
  });
  const first = await run('Bash', { command: 'node pay.mjs' });
  assert.match(first.output, /OUTCOME UNKNOWN/);
  const second = await run('Bash', { command: `cd ${WORK} && node ./pay2.mjs` });
  assert.match(second.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('a send detached to the background is an unknown outcome', async () => {
  const { run } = harness({ replies: [{ output: 'Started background task bg-1' }] });
  const first = await run('Bash', { command: payScript(SUPPLIER_A), run_in_background: true });
  assert.match(first.output, /OUTCOME UNKNOWN/);
  const second = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(second.output, /Payment held/);
});

test('a send whose tool throws is an unknown outcome, not forgotten', async () => {
  const { run, ledger } = harness({ replies: [{ throw: 'spawn died' }] });
  const first = await run('Bash', { command: payScript(SUPPLIER_A) });
  assert.equal(first.isError, true);
  assert.match(first.output, /OUTCOME UNKNOWN/);
  const second = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(second.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('ordinary Bash and reads are unaffected while a hold is active', async () => {
  const { run } = harness({
    replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const ls = await run('Bash', { command: 'ls -la' });
  assert.equal(ls.output, 'ok');
});

// ─── Codex review regressions ──────────────────────────────────────────────

test('[codex P1] quoted script paths and quoted cd targets are inspected', async () => {
  const dir = path.join(WORK, 'pay scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  fs.writeFileSync(path.join(dir, 'retry.mjs'), payScript(SUPPLIER_A, 'b'));
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('node "pay scripts/pay.mjs"', WORK)), true);
  assert.equal(hold.isPaymentSend(hold.bashExecutedText("node 'pay scripts'/pay.mjs", WORK)), true);
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('node pay\\ scripts/pay.mjs', WORK)), true);
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('cd "pay scripts" && node pay.mjs', WORK)), true);

  const { run, ledger } = harness({ replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }] });
  const first = await run('Bash', { command: 'node "pay scripts/pay.mjs"' });
  assert.match(first.output, /OUTCOME UNKNOWN/);
  const second = await run('Bash', { command: 'cd "pay scripts" && timeout 60 node ./retry.mjs' });
  assert.match(second.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P2] reading a script is not running it', async () => {
  fs.writeFileSync(path.join(WORK, 'show.mjs'), payScript(SUPPLIER_A) + '\n// timeout: 30000');
  for (const cmd of ['cat show.mjs', 'git diff show.mjs', 'head -50 show.mjs', 'grep -n transfer show.mjs', 'cp show.mjs backup.mjs']) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), false, cmd);
  }
  for (const cmd of ['node show.mjs', 'npx tsx show.mjs', 'timeout 30 node show.mjs', 'FOO=1 bun show.mjs', 'pnpm dlx tsx show.mjs']) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  }
  // Displaying a payment script whose source says "timeout" creates no attempt.
  const { run, guard } = harness();
  await run('Bash', { command: 'cat show.mjs' });
  assert.equal(guard.unresolvedPaymentAttempts().length, 0);
});

test('[codex P2] heredocs: data written to a file vs code run by an interpreter', () => {
  const body = `const h = await wallet.writeContract({ functionName: 'transfer', args: ['${SUPPLIER_A}', 1n] });`;
  const writeOnly = `cat > draft.mjs <<'EOF'\n${body}\nEOF`;
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(writeOnly, WORK)), false, 'writing a script is not sending');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(`${writeOnly}\nnode draft.mjs`, WORK)), true, 'write then run');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(`node --input-type=module <<'EOF'\n${body}\nEOF`, WORK)), true);
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(`cat <<EOF | python3\n${body}\nEOF`, WORK)), true);
  // An older file on disk is overwritten by the heredoc in the same command.
  fs.writeFileSync(path.join(WORK, 'stale.mjs'), 'console.log("old")');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(`cat > stale.mjs <<'EOF'\n${body}\nEOF\nnode stale.mjs`, WORK)), true);
  // echo/printf into a file that is then run.
  assert.equal(hold.isPaymentSend(hold.bashExecutedText(`echo "${body.replace(/"/g, '\\"')}" > fresh.mjs && node fresh.mjs`, WORK)), true);
  // A shell script that runs a payment script.
  fs.writeFileSync(path.join(WORK, 'inner.mjs'), body);
  fs.writeFileSync(path.join(WORK, 'run.sh'), '#!/bin/sh\nnode inner.mjs\n');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('bash run.sh', WORK)), true);
});

test('[codex P2] a lookup reconciles only the attempts it names', async () => {
  const { run } = harness({
    replies: [
      { output: `sent ${HASH_1}\nTimeoutError: payment response unavailable`, isError: true },
      { output: `sent ${HASH_2}\nError: HTTP 502: Bad gateway`, isError: true },
    ],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  await run('Bash', { command: payScript(SUPPLIER_B) });
  await run('Bash', { command: `cast receipt ${HASH_1}` });
  const stillBlocked = await run('RecordOutcome', { status: 'unpaid' });
  assert.equal(stillBlocked.isError, true, 'the attempt to supplier B was never checked');
  assert.match(stillBlocked.output, new RegExp(HASH_2));
  assert.doesNotMatch(stillBlocked.output, new RegExp(HASH_1));
  // An unrelated lookup does not count either.
  await run('Bash', { command: `cast receipt 0x${'ef'.repeat(32)}` });
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, true);
  await run('Bash', { command: `node -e "await client.getBalance({ address: '${SUPPLIER_B}' })"` });
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, undefined);
});

test('[codex P2] a background lookup is not a completed check', async () => {
  const { run } = harness({
    replies: [{ output: `sent ${HASH_1}\nTimeoutError: payment response unavailable`, isError: true }],
    recon: { output: 'Background task started: bg-7' },
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  await run('Bash', { command: `cast receipt ${HASH_1}`, run_in_background: true });
  assert.equal((await run('RecordOutcome', { status: 'failed' })).isError, true);
});

test('[codex P2] failed/unpaid inside JSON string content is caught', async () => {
  const { run, ledger } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  for (const note of ['{"status":"failed"}', '{"invoice":"INV-1","outcome": "unpaid"}', "status = 'failed'"]) {
    const res = await run('RecordOutcome', { note });
    assert.equal(res.isError, true, note);
  }
  assert.deepEqual(ledger.records, []);
});

// ─── Codex review regressions, round 2 ─────────────────────────────────────

test('[codex P1] sends inside bash -c, sh -lc and eval are inspected', async () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of [
    'bash -c "node pay.mjs"',
    `sh -lc 'cd "pay scripts" && node pay.mjs'`,
    'zsh -ec "timeout 20 node ./pay.mjs"',
    'eval "node pay.mjs"',
    `bash -c 'bash -c "node pay.mjs"'`,
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);

  const { run, ledger } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: 'node pay.mjs' });
  const wrapped = await run('Bash', { command: 'bash -c "node pay.mjs"' });
  assert.match(wrapped.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P1] a shell script resolves paths from the caller, not its own directory', () => {
  const scripts = path.join(WORK, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  // The real payment sits in the caller's directory; a harmless decoy sits
  // next to the shell script. Bash runs the caller's one.
  fs.writeFileSync(path.join(WORK, 'real-pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  fs.writeFileSync(path.join(scripts, 'real-pay.mjs'), 'console.log("decoy")');
  fs.writeFileSync(path.join(scripts, 'go.sh'), '#!/bin/sh\nnode real-pay.mjs\n');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('bash scripts/go.sh', WORK)), true);
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('sh ./scripts/go.sh', WORK)), true);
  // …and the reverse: a cd inside the script moves it.
  fs.writeFileSync(path.join(scripts, 'go2.sh'), '#!/bin/sh\ncd scripts && node real-pay.mjs\n');
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('bash scripts/go2.sh', WORK)), false, 'runs the decoy');
});

test('[codex P2] printing a lookup into a file is not a check; running one is', async () => {
  const lookup = `await client.getTransactionReceipt({ hash: '${HASH_1}' })`;
  assert.equal(hold.analyzeBash(`printf '${lookup}' > check.mjs`, WORK).code.includes('getTransactionReceipt'), false);
  assert.equal(hold.analyzeBash(`echo "${lookup}" >> notes.txt`, WORK).code.includes('getTransactionReceipt'), false);
  assert.equal(hold.analyzeBash(`node -e "${lookup}"`, WORK).code.includes('getTransactionReceipt'), true);
  assert.equal(hold.analyzeBash(`printf '${lookup}' > fresh-check.mjs && node fresh-check.mjs`, WORK).code.includes('getTransactionReceipt'), true);

  const { run } = harness({
    replies: [{ output: `sent ${HASH_1}\nTimeoutError: payment response unavailable`, isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  await run('Bash', { command: `printf '${lookup}' > check.mjs` });
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, true, 'nothing was looked up yet');
  await run('Bash', { command: `cast receipt ${HASH_1} --rpc-url https://mainnet.base.org` });
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, undefined);
});

test('[codex P2] Edit is judged by what it writes, not what it removes', async () => {
  const { run } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const correction = await run('Edit', { file_path: 'ledger.json', old_string: '{"status":"unpaid"}', new_string: '{"status":"unknown"}' });
  assert.equal(correction.isError, undefined);
  const claim = await run('Edit', { file_path: 'ledger.json', old_string: '{"status":"pending"}', new_string: '{"status":"unpaid"}' });
  assert.equal(claim.isError, true);
  const write = await run('Write', { file_path: 'ledger.json', content: '{"status":"failed"}' });
  assert.equal(write.isError, true);
});

test('[codex P2] a sender nonce or balance check counts for the sender\'s attempts', async () => {
  // Hardhat account #0 — a well-known test key, never funded on mainnet.
  process.env.BLOCKRUN_WALLET_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  try {
    const { run, guard } = harness({
      replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }],
    });
    await run('Bash', { command: payScript(SUPPLIER_A) });
    const [attempt] = guard.unresolvedPaymentAttempts();
    assert.deepEqual(attempt.recipients, [SUPPLIER_A], 'own wallet is never a recipient');
    assert.deepEqual(attempt.senders, [SENDER.toLowerCase()]);
    await run('Bash', { command: `cast nonce ${SENDER}` });
    assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, undefined);
  } finally {
    delete process.env.BLOCKRUN_WALLET_KEY;
  }
});

// ─── Codex review regressions, round 3 ─────────────────────────────────────

test('[codex P1] a payment detached with &, nohup or setsid is an unknown outcome', async () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of [
    'nohup node pay.mjs >/tmp/pay.log 2>&1 &',
    'node pay.mjs &',
    'setsid node pay.mjs > out.log',
    '(node pay.mjs &) ; echo started',
  ]) assert.equal(hold.analyzeBash(cmd, WORK).detached, true, cmd);
  for (const cmd of ['node pay.mjs && echo done', 'node pay.mjs &>out.log', 'node pay.mjs 2>&1 | tee log']) {
    assert.equal(hold.analyzeBash(cmd, WORK).detached, false, cmd);
  }

  // The tool returns at once with a clean result — still unknown, still held.
  const { run, ledger } = harness({ replies: [{ output: '' }] });
  const first = await run('Bash', { command: 'nohup node pay.mjs >/tmp/pay.log 2>&1 &' });
  assert.match(first.output, /OUTCOME UNKNOWN/);
  const second = await run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(second.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P1] scripts fed to an interpreter on stdin are inspected', async () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of [
    'node < pay.mjs',
    'node --input-type=module < pay.mjs',
    'cat pay.mjs | node',
    'cat pay.mjs | node --input-type=module -',
    'head -n 200 pay.mjs | node',
    `node <<< "await wallet.writeContract({ functionName: 'transfer' })"`,
    'cat run.sh | bash',
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  // stdin that is not code, or a non-interpreter consumer, is not a send.
  for (const cmd of ['wc -l < pay.mjs', 'cat pay.mjs | wc -l', 'grep transfer < pay.mjs']) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), false, cmd);
  }

  const { run, ledger } = harness({ replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }] });
  await run('Bash', { command: 'node pay.mjs' });
  assert.match((await run('Bash', { command: 'node < pay.mjs' })).output, /Payment held/);
  assert.match((await run('Bash', { command: 'cat pay.mjs | node' })).output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P2] an unpaid write riding along with a lookup is refused', async () => {
  const { run } = harness({
    replies: [{ output: `sent ${HASH_1}\nTimeoutError: payment response unavailable`, isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  for (const cmd of [
    `echo '{"status":"unpaid"}' > ledger.json; cast receipt ${HASH_1}`,
    `cast receipt 0x${'ef'.repeat(32)} && printf 'INV-1 unpaid' >> ledger.txt`,
    `cat > ledger.json <<'J'\n{"status":"failed"}\nJ\ncast nonce ${SUPPLIER_A}`,
  ]) {
    const res = await run('Bash', { command: cmd });
    assert.equal(res.isError, true, cmd);
    assert.match(res.output, /records a payment as failed\/unpaid/);
  }
  // A lookup whose own code merely mentions "unpaid" is a real check.
  const check = await run('Bash', {
    command: `node -e "const r = await client.getTransactionReceipt({ hash: '${HASH_1}' }); console.log(r ? 'paid' : 'unpaid')"`,
  });
  assert.equal(check.isError, undefined);
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, undefined);
});

// ─── Codex review regressions, round 4 ─────────────────────────────────────

test('[codex P1] sends behind setsid / daemonize / stdbuf are inspected and detached', async () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of ['setsid node pay.mjs >out.log', 'daemonize node pay.mjs', 'stdbuf -oL node pay.mjs', 'nice -n 5 setsid node pay.mjs']) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  }
  const { run, ledger } = harness({ replies: [{ output: '' }] });
  const first = await run('Bash', { command: 'setsid node pay.mjs >out.log' });
  assert.match(first.output, /OUTCOME UNKNOWN/, 'setsid returns before the payment does');
  assert.match((await run('Bash', { command: 'setsid node pay.mjs >out2.log' })).output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P2] a ledger script run from disk cannot record unpaid early', async () => {
  fs.writeFileSync(path.join(WORK, 'record.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync('ledger.json', JSON.stringify({ invoice: 'INV-1', status: 'unpaid' }));\n`);
  fs.writeFileSync(path.join(WORK, 'record.py'),
    `import json\nwith open('ledger.json', 'w') as f:\n    json.dump({'status': 'failed'}, f)\n`);
  const { run } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  for (const cmd of ['node record.mjs', 'python3 record.py', 'ledger-cli add INV-1 --status unpaid']) {
    const res = await run('Bash', { command: cmd });
    assert.equal(res.isError, true, cmd);
    assert.match(res.output, /records a payment as failed\/unpaid/, cmd);
  }
  // Reading the ledger or printing to the terminal is not a record.
  for (const cmd of ['grep -n unpaid ledger.json', 'cat ledger.json | jq .status', 'echo "status: unknown, not unpaid yet"']) {
    assert.equal((await run('Bash', { command: cmd })).isError, undefined, cmd);
  }
});

test('[codex P2] a lookup that also writes unpaid is refused; one that only prints passes', async () => {
  const { run } = harness({
    replies: [{ output: `sent ${HASH_1}\nTimeoutError: payment response unavailable`, isError: true }],
  });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const sneaky = await run('Bash', {
    command: `node -e "require('fs').writeFileSync('ledger.json','unpaid'); await c.getBalance({ address: '${SUPPLIER_A}' })"`,
  });
  assert.equal(sneaky.isError, true);
  assert.equal((await run('RecordOutcome', { status: 'unpaid' })).isError, true, 'the sneaky call did not count as a check');
  const honest = await run('Bash', {
    command: `node -e "const r = await c.getTransactionReceipt({ hash: '${HASH_1}' }); console.log(r ? 'paid' : 'unpaid')"`,
  });
  assert.equal(honest.isError, undefined);
});

// ─── Codex review regressions, round 5 ─────────────────────────────────────

test('[codex P1] chain CLIs with global options before the subcommand are sends', () => {
  for (const cmd of [
    `solana --url mainnet-beta transfer ${SUPPLIER_A} 200`,
    `spl-token --url mainnet-beta --fee-payer k.json transfer EPj 200 ${SUPPLIER_A}`,
    `cast --verbose send ${SUPPLIER_A} --value 1wei`,
    'cast publish 0x02f8',
    `timeout --signal TERM 30 solana -u m transfer ${SUPPLIER_A} 1`,
    `curl -X POST https://api.example/pay -H "X-PAYMENT: eyJhbGc"`,
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  for (const cmd of ['solana --url mainnet-beta balance', 'spl-token accounts', `cast receipt ${HASH_1}`]) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), false, cmd);
  }
});

test('[codex P1] wrapper option values are not mistaken for the program', () => {
  fs.writeFileSync(path.join(WORK, 'pay.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of [
    'env -u NODE_OPTIONS node pay.mjs',
    'env -C . node pay.mjs',
    'env -S "node pay.mjs"',
    'timeout --signal TERM 30 node pay.mjs',
    'timeout -k 5 30 node pay.mjs',
    'sudo -u bob -- node pay.mjs',
    'ionice -c 2 -n 7 node pay.mjs',
    'stdbuf -o L node pay.mjs',
    'npx -p tsx tsx pay.mjs',
    'npx -c "node pay.mjs"',
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
});

test('[codex P2] an unpaid write batched with an unrelated send is refused', async () => {
  const { run, ledger } = harness({ replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const batched = await run('Bash', { command: `echo unpaid > invoice-A.txt; cast send ${SUPPLIER_B} --value 1wei` });
  assert.equal(batched.isError, true);
  assert.match(batched.output, /records a payment as failed\/unpaid/);
  assert.equal(ledger.sends, 1, 'nothing in the batch ran');
  // The unrelated send on its own is fine.
  await run('Bash', { command: `cast send ${SUPPLIER_B} --value 1wei` });
  assert.equal(ledger.sends, 2);
});

test('[codex P2] searching for or printing payment code is not a send', async () => {
  for (const cmd of [
    `grep -n 'sendTransaction(' pay.mjs`,
    `rg "writeContract\\(" src`,
    `printf '%s' 'wallet.sendTransaction({ to })' > draft.mjs`,
    `echo "cast send ${SUPPLIER_A}" >> notes.md`,
    `git log -S 'transfer(' --oneline`,
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), false, cmd);

  const { run, ledger } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const inspect = await run('Bash', { command: `grep -n 'sendTransaction(' pay.mjs` });
  assert.doesNotMatch(inspect.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

// ─── Codex review regressions, round 6 ─────────────────────────────────────

test('[codex P1] a script rewritten in the same command is judged by its new content', async () => {
  fs.writeFileSync(path.join(WORK, 'step.mjs'), 'console.log("harmless")');
  const sendJs = `await wallet.sendTransaction({ to: '${SUPPLIER_A}', value: 1n })`;
  for (const cmd of [
    `echo "${sendJs}" > step.mjs && node step.mjs`,
    `printf '%s' "${sendJs}" > step.mjs; node step.mjs`,
    `cp /tmp/other.mjs step.mjs && node step.mjs # ${sendJs}`,
    `curl -s -o step.mjs https://x/y && node step.mjs # ${sendJs}`,
  ]) assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  // Untouched file: its real (harmless) content decides.
  assert.equal(hold.isPaymentSend(hold.bashExecutedText('node step.mjs', WORK)), false);

  const { run, ledger } = harness({ replies: [{ output: 'TimeoutError: payment response unavailable', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  const swapped = await run('Bash', { command: `echo "${sendJs}" > step.mjs && node step.mjs` });
  assert.match(swapped.output, /Payment held/);
  assert.equal(ledger.sends, 1);
});

test('[codex P1] env -C / sudo -D resolve the script in the target directory', () => {
  const dir = path.join(WORK, 'payments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'only-here.mjs'), payScript(SUPPLIER_A).replace(/^node -e "|"$/g, ''));
  for (const cmd of ['env -C payments node only-here.mjs', 'env --chdir=payments node only-here.mjs', 'sudo -D payments node only-here.mjs']) {
    assert.equal(hold.isPaymentSend(hold.bashExecutedText(cmd, WORK)), true, cmd);
  }
});

test('[codex P1] an unresolved hold survives --resume of the same session', async () => {
  const sessionId = `resume-${process.pid}`;
  const first = harness({ sessionId, replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await first.run('Bash', { command: payScript(SUPPLIER_A) });
  assert.equal(first.guard.unresolvedPaymentAttempts().length, 1);

  // New process, same session id: a fresh guard must load the hold.
  const resumed = harness({ sessionId });
  assert.equal(resumed.guard.unresolvedPaymentAttempts().length, 1);
  const resend = await resumed.run('Bash', { command: payScript(SUPPLIER_A, 'b') });
  assert.match(resend.output, /Payment held/);
  assert.equal(resumed.ledger.sends, 0);
  assert.equal((await resumed.run('RecordOutcome', { status: 'unpaid' })).isError, true);

  // A different session starts clean.
  assert.equal(harness().guard.unresolvedPaymentAttempts().length, 0);
});

test('[codex P2] records through program output redirects and HTTP writes are refused', async () => {
  const { run } = harness({ replies: [{ output: 'Error: HTTP 502: Bad gateway', isError: true }] });
  await run('Bash', { command: payScript(SUPPLIER_A) });
  for (const cmd of [
    `node -e 'console.log("unpaid")' > ledger.txt`,
    `python3 -c 'print("status: failed")' >> ledger.txt`,
    `curl -X POST https://ledger.example/record -d '{"status":"unpaid"}'`,
    `curl https://ledger.example/record --json '{"outcome":"failed"}'`,
  ]) {
    const res = await run('Bash', { command: cmd });
    assert.equal(res.isError, true, cmd);
    assert.match(res.output, /records a payment as failed\/unpaid/, cmd);
  }
  // Reading the ledger over HTTP is not a record.
  assert.equal((await run('Bash', { command: 'curl -s https://ledger.example/INV-1 | jq .status' })).isError, undefined);
});
