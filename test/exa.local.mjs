/**
 * Exa wire-format regression tests (no network, no USDC spend).
 *
 * The BlockRun gateway returns Exa payloads at the TOP level
 * ({ results, costDollars } / { answer, citations }). A 2026-06-22 paid
 * e2e run revealed the tool read them under a non-existent `data` wrapper
 * (`res.data.results`), so every paid Exa call silently returned
 * "no results" / a blank answer AFTER paying $0.01–$0.002 USDC. The paid
 * e2e tests never caught it because their skip heuristic false-skipped on
 * payment-domain content (x402 == HTTP 402 "Payment Required").
 *
 * These tests stub fetch with the real top-level shape and assert the data
 * is surfaced, plus a legacy data-wrapped envelope for backward-compat.
 */
process.env.FRANKLIN_NO_AUDIT = '1';
process.env.FRANKLIN_NO_PERSIST = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const ctx = () => ({ workingDir: process.cwd(), abortSignal: new AbortController().signal });

// Stub a 200 response carrying `body`. postWithPayment only reads headers
// in the 402 branch (not taken here) and text() only on !ok, so a minimal
// Response-like object suffices.
function stubFetch(body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return () => { globalThis.fetch = original; };
}

test('ExaSearch surfaces top-level results from the live gateway wire shape', async () => {
  const { exaSearchCapability } = await import('../dist/tools/exa.js');
  const restore = stubFetch({
    requestId: 'r1',
    results: [{ id: 'u1', title: 'x402 Overview', url: 'https://docs.cdp.coinbase.com/x402/welcome' }],
    costDollars: { total: 0.01 },
  });
  try {
    const r = await exaSearchCapability.execute({ query: 'x402 payment protocol' }, ctx());
    assert.notEqual(r.isError, true, `unexpected error: ${r.output}`);
    assert.ok(r.output.includes('https://docs.cdp.coinbase.com/x402/welcome'),
      `expected the result URL in output, got:\n${r.output}`);
    assert.ok(!/No Exa results/.test(r.output),
      `tool dropped top-level results (wire-format bug):\n${r.output}`);
  } finally { restore(); }
});

test('ExaAnswer surfaces top-level answer from the live gateway wire shape', async () => {
  const { exaAnswerCapability } = await import('../dist/tools/exa.js');
  const restore = stubFetch({
    requestId: 'r2',
    answer: 'x402 is a payment protocol built on HTTP 402 Payment Required.',
    citations: [{ id: 'c1', title: 'Overview', url: 'https://docs.cdp.coinbase.com/x402/welcome' }],
    costDollars: { total: 0.01 },
  });
  try {
    const r = await exaAnswerCapability.execute({ query: 'What is x402?' }, ctx());
    assert.notEqual(r.isError, true, `unexpected error: ${r.output}`);
    assert.ok(r.output.includes('x402 is a payment protocol'),
      `expected the answer text in output, got:\n${r.output}`);
  } finally { restore(); }
});

test('ExaReadUrls surfaces top-level results from the live gateway wire shape', async () => {
  const { exaReadUrlsCapability } = await import('../dist/tools/exa.js');
  const restore = stubFetch({
    requestId: 'r3',
    results: [{
      id: 'u1', url: 'https://en.wikipedia.org/wiki/HTTP_402',
      title: 'HTTP 402', text: 'The 402 Payment Required status code.',
    }],
    costDollars: { total: 0.002 },
  });
  try {
    const r = await exaReadUrlsCapability.execute({ urls: ['https://en.wikipedia.org/wiki/HTTP_402'] }, ctx());
    assert.notEqual(r.isError, true, `unexpected error: ${r.output}`);
    assert.ok(r.output.includes('402 Payment Required status code'),
      `expected the fetched text in output, got:\n${r.output}`);
  } finally { restore(); }
});

test('ExaSearch still parses a legacy { data: {...} } envelope (backward-compat)', async () => {
  const { exaSearchCapability } = await import('../dist/tools/exa.js');
  const restore = stubFetch({
    data: {
      results: [{ id: 'u1', title: 'X', url: 'https://example.com/x402' }],
      costDollars: { total: 0.01 },
    },
  });
  try {
    const r = await exaSearchCapability.execute({ query: 'x402' }, ctx());
    assert.ok(r.output.includes('https://example.com/x402'),
      `legacy data-wrapped envelope must still parse:\n${r.output}`);
  } finally { restore(); }
});

// ── prefetch twin path (intent-prefetch.exaAnswerTry) ─────────────────────
// The harness prefetch makes its OWN paid /v1/exa/answer call, separate from
// the ExaAnswer tool. It must read the SAME top-level wire shape — historically
// it lagged the tool fix and paid the $0.01 USDC then dropped the answer.
test('readExaAnswer surfaces a TOP-LEVEL answer (the regression the prefetch path missed)', async () => {
  const { readExaAnswer } = await import('../dist/agent/intent-prefetch.js');
  const r = readExaAnswer({ answer: 'Circle (CRCL) rallied on stablecoin news.', costDollars: { total: 0.012 } }, true);
  assert.equal(r.text, 'Circle (CRCL) rallied on stablecoin news.', 'top-level answer must not be dropped');
  assert.equal(r.costUsd, 0.012, 'reports the gateway-reported cost');
});

test('readExaAnswer still reads a legacy data-wrapped answer', async () => {
  const { readExaAnswer } = await import('../dist/agent/intent-prefetch.js');
  const r = readExaAnswer({ data: { answer: 'Nested legacy answer.', costDollars: { total: 0.008 } } }, true);
  assert.equal(r.text, 'Nested legacy answer.');
  assert.equal(r.costUsd, 0.008);
});

test('readExaAnswer counts a paid-but-empty answer so spend is never under-reported', async () => {
  const { readExaAnswer } = await import('../dist/agent/intent-prefetch.js');
  // Paid 200 with no usable text + no reported cost → fall back to the estimate.
  const paidEmpty = readExaAnswer({}, true);
  assert.equal(paidEmpty.text, null);
  assert.equal(paidEmpty.costUsd, 0.01, 'a settled x402 charge must still be counted');
  // Unpaid (non-402 200 or failure) with no text → no phantom charge.
  const unpaid = readExaAnswer({}, false);
  assert.equal(unpaid.text, null);
  assert.equal(unpaid.costUsd, 0, 'no payment → no cost booked');
});

test('readExaAnswer degrades (does not throw) on a malformed non-string answer, preserving paid-cost counting', async () => {
  const { readExaAnswer } = await import('../dist/agent/intent-prefetch.js');
  // A drifted wire shape (number/object/array answer) must NOT throw — a throw
  // would be swallowed and mis-book a settled paid call as $0.
  for (const bad of [12345, { foo: 1 }, ['x'], true]) {
    const r = readExaAnswer({ answer: bad, costDollars: { total: 0.01 } }, true);
    assert.equal(r.text, null, `non-string answer ${JSON.stringify(bad)} must yield null text`);
    assert.equal(r.costUsd, 0.01, 'the settled charge is still counted');
  }
  // Non-object body / nested non-object data also degrade cleanly.
  assert.deepEqual(readExaAnswer(null, true), { text: null, costUsd: 0.01 });
  assert.deepEqual(readExaAnswer('not json', false), { text: null, costUsd: 0 });
});
