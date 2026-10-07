import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { keccak256 } from 'viem';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-withdraw-test-'));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

// Replace only external signing/network boundaries. The built withdrawal,
// relayer submission, SDK batch builder, and atomic state store run unchanged.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || '';
  const withdraw = parent.endsWith('/dist/tools/polymarket/withdraw.js');
  const relayer = parent.endsWith('/dist/tools/polymarket/relayer.js');
  let source;
  if ((withdraw || relayer) && specifier === './client.js')
    source = 'export const getPolymarketAccount = () => globalThis.withdrawTest.account;';
  if (withdraw && specifier === './positions.js')
    source = 'export const getFundsAddress = () => globalThis.withdrawTest.owner;';
  if (withdraw && specifier === './setup.js')
    source = 'export const getPublicClient = () => globalThis.withdrawTest.publicClient;';
  if (withdraw && specifier === './orders.js')
    source = 'export const mapClobError = async error => error.message;';
  if (withdraw && specifier === 'axios')
    source = 'export default { post: (...args) => globalThis.withdrawTest.post(...args) };';
  if (withdraw && specifier === 'viem') {
    const actual = await nextResolve(specifier, context);
    source = 'export * from ' + JSON.stringify(actual.url) + '; export const createWalletClient = () => globalThis.withdrawTest.wallet;';
  }
  if (relayer && specifier === '@polymarket/builder-relayer-client')
    source = 'export class RelayClient { constructor() { return globalThis.withdrawTest.relay; } }';
  if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { loadState, saveState, saveBuilderCreds } = await import('../dist/tools/polymarket/creds.js');
const { withdrawFunds } = await import('../dist/tools/polymarket/withdraw.js');
const { sendWalletBatch } = await import('../dist/tools/polymarket/relayer.js');
const { PUSD_COLLATERAL } = await import('../dist/tools/polymarket/constants.js');
const agent = '0xaBcDEf0000000000000000000000000000000001';
const owner = '0x1111111111111111111111111111111111111111';
const bridge = '0x2222222222222222222222222222222222222222';
const signed = '0x01020304';
const txHash = keccak256(signed);
const calls = [{ target: PUSD_COLLATERAL, value: '0', data: '0x' }];
let h;
// getRelayClient caches the object, so retain this identity across tests.
const relay = {};

beforeEach(() => {
  process.env.POLYMARKET_SIG_TYPE = '3';
  saveState({ pendingWithdraw: undefined });
  h = {
    account: { address: agent }, owner,
    calls: [],
    publicClient: {
      readContract: async ({ address }) => { h.calls.push('balance'); return address === PUSD_COLLATERAL ? 10_000_000n : 0n; },
      getTransactionCount: async args => { h.calls.push('nonce'); assert.equal(args.blockTag, 'pending'); return 7; },
      getTransactionReceipt: async () => { h.calls.push('receipt'); throw new Error('receipt unavailable'); },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    },
    wallet: {
      prepareTransactionRequest: async request => { h.calls.push('prepare'); assert.equal(request.nonce, 7); return request; },
      signTransaction: async request => { h.calls.push('sign'); assert.equal(request.nonce, 7); assert.equal(loadState().pendingWithdraw, undefined); return signed; },
      sendRawTransaction: async ({ serializedTransaction }) => {
        h.calls.push('broadcast');
        assert.equal(serializedTransaction, signed);
        assert.deepEqual(loadState().pendingWithdraw, { txHash, nonce: 7, from: agent, serializedTransaction: signed });
        return txHash;
      },
    },
    post: async (_url, body) => { h.calls.push('bridge'); assert.equal(body.recipientAddr, agent); return { data: { address: { evm: bridge } } }; },
    relay,
  };
  Object.assign(relay, {
    relayerUrl: 'https://relayer.invalid', chainId: 137,
    contractConfig: { DepositWalletContracts: { DepositWalletFactory: owner, DepositWalletImplementation: bridge } },
    signer: {
      getAddress: async () => agent,
      signTypedData: async () => { h.calls.push('batch-sign'); assert.equal(loadState().pendingWithdraw, undefined); return '0x1234'; },
    },
    builderConfig: { isValid: () => true, generateBuilderHeaders: async () => ({ TEST_AUTH: 'test-only' }) },
    getNonce: async () => ({ nonce: '9' }),
    httpClient: { send: async (_url, _method, options) => {
      h.calls.push('submit');
      const pending = loadState().pendingWithdraw;
      const body = JSON.parse(options.data);
      assert.equal(pending.transactionID, undefined);
      assert.equal(pending.nonce, '9');
      assert.equal(pending.from, agent);
      assert.match(pending.payloadHash, /^0x[0-9a-f]{64}$/);
      assert.equal(pending.deadline, Number(body.depositWalletParams.deadline));
      assert.ok(pending.deadline > Date.now() / 1000);
      return { data: { transactionID: 'relay-1', state: 'STATE_NEW', transactionHash: txHash } };
    } },
    pollUntilState: async () => {
      assert.equal(loadState().pendingWithdraw.transactionID, 'relay-1');
      return { transactionHash: txHash, state: 'STATE_CONFIRMED' };
    },
    getTransaction: async () => { h.calls.push('relayer-state'); return [{ state: 'STATE_NEW' }]; },
  });
  globalThis.withdrawTest = h;
  saveBuilderCreds(agent, { key: 'test-key', secret: 'dGVzdA==', passphrase: 'test' });
});

test('withdraw refuses external recipients before any network access or signature', async () => {
  for (const confirm of [false, true]) {
    const result = await withdrawFunds({ to_address: bridge, confirm });
    assert.equal(result.isError, true);
    assert.match(result.text, /agent wallet first/);
    assert.deepEqual(h.calls, []);
  }
});

test('withdraw accepts default and case-insensitive agent wallet recipients', async () => {
  for (const to_address of [undefined, agent.toLowerCase(), agent.toUpperCase()]) {
    const result = await withdrawFunds({ to_address });
    assert.ok(!result.isError, result.text);
    assert.equal(result.structured.to, agent);
  }
});

test('relayer persists signed batch before submission and enriches before waiting', async () => {
  const result = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.ok(!result.isError, result.text);
  assert.ok(h.calls.includes('submit'));
  assert.equal(loadState().pendingWithdraw, undefined);
});

test('relayer signing and auth failures leave no pending marker or submitted request', async () => {
  for (const stage of ['sign', 'auth']) {
    const fail = async () => { throw new Error('pre-submission failure'); };
    if (stage === 'sign') relay.signer.signTypedData = fail;
    else {
      relay.signer.signTypedData = async () => '0x1234';
      relay.builderConfig.generateBuilderHeaders = fail;
    }
    await assert.rejects(sendWalletBatch(calls, owner, 'Withdraw', { trackPendingWithdraw: true }), /pre-submission/);
    assert.equal(loadState().pendingWithdraw, undefined);
    assert.ok(!h.calls.includes('submit'));
  }
});

test('lost relayer acknowledgement retains marker and blocks another confirmed withdrawal', async () => {
  const submit = relay.httpClient.send;
  relay.httpClient.send = async (...args) => { await submit(...args); throw new Error('response lost'); };
  const result = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(result.isError, true);
  const pending = loadState().pendingWithdraw;
  assert.ok(pending.payloadHash);
  assert.equal(pending.transactionID, undefined);
  h.calls.length = 0;
  const retry = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(retry.isError, true);
  assert.match(retry.text, /may still execute/);
  assert.deepEqual(h.calls, [], 'no query is possible without an acknowledgement');
  assert.deepEqual(loadState().pendingWithdraw, pending);
});

test('relayer unknown and legacy pending states block; deadline plus grace or terminal state clears', async () => {
  const deadline = Math.floor(Date.now() / 1000) + 100;
  for (const pending of [{ deadline }, { transactionID: 'legacy', deadline }]) {
    saveState({ pendingWithdraw: pending });
    const result = await withdrawFunds({ confirm: true });
    assert.equal(result.isError, true);
    assert.deepEqual(loadState().pendingWithdraw, pending);
  }
  h.publicClient.readContract = async () => 0n;
  saveState({ pendingWithdraw: { deadline: Math.floor(Date.now() / 1000) - 30 } });
  assert.match((await withdrawFunds({ confirm: true })).text, /may still execute/, 'grace interval still blocks');
  saveState({ pendingWithdraw: { deadline: Math.floor(Date.now() / 1000) - 61 } });
  await withdrawFunds({ confirm: true });
  assert.equal(loadState().pendingWithdraw, undefined);
  for (const state of ['STATE_MINED', 'STATE_CONFIRMED', 'STATE_FAILED', 'STATE_INVALID']) {
    saveState({ pendingWithdraw: { transactionID: 'legacy', deadline } });
    relay.getTransaction = async () => [{ state }];
    await withdrawFunds({ confirm: true });
    assert.equal(loadState().pendingWithdraw, undefined);
  }
});

test('relayer poll failure keeps acknowledged marker; terminal failure clears it', async () => {
  relay.pollUntilState = async () => undefined;
  await assert.rejects(sendWalletBatch(calls, owner, 'Withdraw', { trackPendingWithdraw: true }), /may still land/);
  assert.equal(loadState().pendingWithdraw.transactionID, 'relay-1');
  saveState({ pendingWithdraw: undefined });
  relay.getTransaction = async () => [{ state: 'STATE_FAILED' }];
  await assert.rejects(sendWalletBatch(calls, owner, 'Withdraw', { trackPendingWithdraw: true }), /failed on-chain/);
  assert.equal(loadState().pendingWithdraw, undefined);
});

test('EOA persists hash, nonce and sender before raw broadcast and clears on receipt', async () => {
  process.env.POLYMARKET_SIG_TYPE = '0';
  const result = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.ok(!result.isError, result.text);
  assert.deepEqual(h.calls.slice(-4), ['nonce', 'prepare', 'sign', 'broadcast']);
  assert.equal(result.structured.transactionHash, txHash);
  assert.equal(loadState().pendingWithdraw, undefined);
});

test('EOA signing failure never broadcasts or leaves a marker', async () => {
  process.env.POLYMARKET_SIG_TYPE = '0';
  h.wallet.signTransaction = async () => { throw new Error('signing failed'); };
  assert.equal((await withdrawFunds({ amount_usd: 2, confirm: true })).isError, true);
  assert.ok(!h.calls.includes('broadcast'));
  assert.equal(loadState().pendingWithdraw, undefined);
});

test('EOA lost broadcast response or receipt timeout retains marker', async () => {
  process.env.POLYMARKET_SIG_TYPE = '0';
  const broadcast = h.wallet.sendRawTransaction;
  for (const stage of ['broadcast', 'receipt']) {
    saveState({ pendingWithdraw: undefined });
    h.wallet.sendRawTransaction = stage === 'broadcast'
      ? async args => { await broadcast(args); throw new Error('response lost'); }
      : broadcast;
    h.publicClient.waitForTransactionReceipt = async () => { throw new Error('receipt timed out'); };
    assert.equal((await withdrawFunds({ amount_usd: 2, confirm: true })).isError, true);
    assert.equal(loadState().pendingWithdraw.txHash, txHash);
    h.calls.length = 0;
    // The RPC still knows the hash (or cannot say): never infer "dropped";
    // re-broadcast the SAME signed bytes and keep the guard.
    h.publicClient.getTransaction = async () => { h.calls.push('lookup'); return { hash: txHash }; };
    h.wallet.sendRawTransaction = async ({ serializedTransaction }) => { h.calls.push('rebroadcast'); assert.equal(serializedTransaction, signed); return txHash; };
    const result = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /may still land.*re-broadcast/);
    assert.deepEqual(h.calls, ['receipt', 'lookup', 'rebroadcast']);
    assert.equal(loadState().pendingWithdraw.txHash, txHash);
    h.wallet.sendRawTransaction = broadcast;
  }
});

function notFound() {
  const err = new Error('Transaction could not be found');
  err.name = 'TransactionNotFoundError';
  throw err;
}

test('EOA guard releases only when the nonce moved past ours AND the RPC does not know our hash', async () => {
  for (const [latest, release] of [[7, false], [8, true]]) {
    saveState({ pendingWithdraw: { txHash, nonce: 7, from: agent, serializedTransaction: signed } });
    h.publicClient.getTransaction = async () => notFound();
    h.publicClient.getTransactionCount = async ({ blockTag }) => { assert.equal(blockTag, 'latest'); return latest; };
    h.wallet.sendRawTransaction = async () => { h.calls.push('rebroadcast'); return txHash; };
    h.publicClient.readContract = async () => 0n;
    h.calls.length = 0;
    const result = await withdrawFunds({ confirm: true });
    if (release) {
      assert.equal(loadState().pendingWithdraw, undefined);
      assert.ok(!h.calls.includes('rebroadcast'));
    } else {
      assert.match(result.text, /may still land/);
      assert.ok(h.calls.includes('rebroadcast'), 'a free nonce means the same bytes are re-sent, never new ones');
      assert.equal(loadState().pendingWithdraw.txHash, txHash);
    }
  }
});

test('EOA definite broadcast rejection of unknown bytes releases the guard; ambiguous errors keep it', async () => {
  process.env.POLYMARKET_SIG_TYPE = '0';
  for (const [message, release] of [['insufficient funds for gas * price + value', true], ['socket hang up', false]]) {
    saveState({ pendingWithdraw: undefined });
    h.publicClient.getTransaction = async () => notFound();
    h.wallet.sendRawTransaction = async () => { throw new Error(message); };
    const result = await withdrawFunds({ amount_usd: 2, confirm: true });
    assert.equal(result.isError, true);
    assert.equal(loadState().pendingWithdraw === undefined, release, message);
  }
  // Even a "definite" rejection keeps the guard if the RPC already knows the hash.
  saveState({ pendingWithdraw: undefined });
  h.publicClient.getTransaction = async () => ({ hash: txHash });
  h.wallet.sendRawTransaction = async () => { throw new Error('nonce too low'); };
  await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(loadState().pendingWithdraw.txHash, txHash);
});

test('EOA pending receipt success or revert clears regardless of sig-type changes', async () => {
  for (const status of ['success', 'reverted']) {
    saveState({ pendingWithdraw: { txHash, nonce: 7, from: agent } });
    h.publicClient.getTransactionReceipt = async ({ hash }) => { assert.equal(hash, txHash); return { status }; };
    h.publicClient.readContract = async () => 0n;
    await withdrawFunds({ confirm: true });
    assert.equal(loadState().pendingWithdraw, undefined);
  }
});

test('EOA confirmed revert clears guard but reports failure', async () => {
  process.env.POLYMARKET_SIG_TYPE = '0';
  h.publicClient.waitForTransactionReceipt = async () => ({ status: 'reverted' });
  const result = await withdrawFunds({ amount_usd: 2, confirm: true });
  assert.equal(result.isError, true);
  assert.match(result.text, /revert/i);
  assert.equal(loadState().pendingWithdraw, undefined);
});

test('withdraw never submits when persisting the pre-submission guard fails', async () => {
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('state persistence failed'); };
    for (const sigType of ['0', '3']) {
      process.env.POLYMARKET_SIG_TYPE = sigType;
      const result = await withdrawFunds({ amount_usd: 2, confirm: true });
      assert.equal(result.isError, true);
      assert.match(result.text, /state persistence failed/);
      assert.equal(loadState().pendingWithdraw, undefined);
      assert.ok(!h.calls.includes('submit'));
      assert.ok(!h.calls.includes('broadcast'));
    }
  } finally {
    fs.renameSync = rename;
  }
});
