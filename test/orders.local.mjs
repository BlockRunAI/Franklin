/**
 * Polymarket order submission: an order that may have reached the CLOB keeps
 * its spend reserved, and only a provable non-submission is reported as such
 * (the trade-plan gate releases budget on that signal alone). No network: the
 * CLOB client module is replaced at the import boundary.
 */

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'franklin-orders-test-'));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const loader = `
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || '';
  if (parent.endsWith('/dist/tools/polymarket/orders.js') && specifier === './client.js') {
    const source = 'export const getClobClient = async () => globalThis.ordersTest.clob;' +
      'export const resetClobClient = () => {};' +
      'export const checkGeoblock = async () => ({});' +
      'export const getPolymarketAccount = () => ({ address: "0x0000000000000000000000000000000000000001" });';
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { executeTrade, getSessionLedger } = await import('../dist/tools/polymarket/orders.js');

const ORDER = { action: 'buy', token_id: '12345', price: 0.5, size: 4, confirm: true };
let h;

beforeEach(() => {
  h = {
    posts: 0,
    clob: {
      getOrderBook: async () => ({
        tick_size: '0.01', neg_risk: false, min_order_size: '1',
        asks: [{ price: '0.5', size: '100' }], bids: [{ price: '0.49', size: '100' }],
      }),
      createAndPostOrder: async () => { h.posts += 1; return h.respond(); },
      updateBalanceAllowance: async () => {},
    },
    respond: () => ({ success: true, orderID: 'o-1', status: 'live' }),
  };
  globalThis.ordersTest = h;
});

function apiError(message, status) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  return err;
}

test('a submit error without a definite rejection is UNKNOWN: reservation kept, not marked notSubmitted', async () => {
  for (const err of [apiError('socket hang up'), apiError('upstream response lost', 502), apiError('timeout', 408)]) {
    const before = getSessionLedger();
    h.respond = () => { throw err; };
    const result = await executeTrade(ORDER);
    assert.equal(result.isError, true);
    assert.match(result.text, /outcome UNKNOWN/);
    assert.match(result.text, /Do NOT place it again/);
    assert.notEqual(result.notSubmitted, true, err.message);
    const now = getSessionLedger();
    assert.equal(now.totalUsd, before.totalUsd + 2, `${err.message}: session cap still counts the order`);
    assert.equal(now.count, before.count + 1);
  }
});

test('a definite 4xx rejection or explicit success:false releases and is marked notSubmitted', async () => {
  for (const respond of [
    () => { throw apiError('invalid order payload', 400); },
    () => ({ success: false, errorMsg: 'order rejected' }),
  ]) {
    const before = getSessionLedger();
    h.respond = respond;
    const result = await executeTrade(ORDER);
    assert.equal(result.isError, true);
    assert.equal(result.notSubmitted, true);
    assert.deepEqual(getSessionLedger(), before);
  }
});

test('validation failures before any submit are marked notSubmitted and never post', async () => {
  const result = await executeTrade({ ...ORDER, size: undefined });
  assert.equal(result.isError, true);
  assert.equal(result.notSubmitted, true);
  assert.equal(h.posts, 0);
});

test('a placed order is neither an error nor notSubmitted', async () => {
  const result = await executeTrade(ORDER);
  assert.ok(!result.isError, result.text);
  assert.notEqual(result.notSubmitted, true);
  assert.equal(h.posts, 1);
});
