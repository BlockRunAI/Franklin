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
