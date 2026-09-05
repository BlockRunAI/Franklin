/**
 * API-key payment mode — resolution, isolation from wallet mode, and the
 * local pricing that replaces the x402 charge the key gateway never reports.
 *
 * HOME is redirected to a temp dir BEFORE any import, because config.ts
 * resolves BLOCKRUN_DIR from os.homedir() at module load. Without this the
 * suite would read and write the developer's real ~/.blockrun.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'franklin-apikey-'));
process.env.HOME = TEST_HOME;
delete process.env.BLOCKRUN_API_KEY;
delete process.env.RUNCODE_CHAIN;
process.env.FRANKLIN_NO_AUDIT = '1';

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const auth = await import('../dist/payments/auth-mode.js');
const { API_URLS, KEY_API_URL, BLOCKRUN_DIR, saveChain } = await import('../dist/config.js');
const { redactSecrets } = await import('../dist/agent/secret-redact.js');
const catalog = await import('../dist/payments/price-catalog.js');

// Synthetic — shaped like a real key so the format checks are meaningful, but
// not a credential. Never put a live key in a tracked file.
const VALID_KEY = 'brk_live_0000TESTKEYNOTREAL0000000000000000000';
const KEY_FILE = join(BLOCKRUN_DIR, 'api-key');

function clean() {
  delete process.env.BLOCKRUN_API_KEY;
  rmSync(KEY_FILE, { force: true });
  auth.resetPayModeCache();
}

function writeKeyFile(key) {
  mkdirSync(BLOCKRUN_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key + '\n');
  auth.resetPayModeCache();
}

test('Messages API credit refusal never invokes wallet signing', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  const { ModelClient } = await import('../dist/agent/llm.js');
  const client = new ModelClient({ apiUrl: KEY_API_URL, chain: 'solana' });
  const nativeFetch = globalThis.fetch;
  let signed = false;
  let requests = 0;
  client.signPayment = async () => { signed = true; return null; };
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: { message: 'Account credits exhausted' } }, { status: 402 });
  };
  try {
    const events = [];
    for await (const event of client.streamCompletion({ model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 })) events.push(event);
    assert.equal(signed, false);
    assert.equal(requests, 1);
    assert.match(events.find(event => event.kind === 'error')?.payload.message ?? '', /credits exhausted/);
  } finally {
    globalThis.fetch = nativeFetch;
    clean();
  }
});

// ─── Backward compatibility: no key means nothing changes ───────────────
//
// This is the guarantee the whole feature rests on. If it ever fails, every
// existing wallet user's traffic has silently moved hosts.

test('no key configured — wallet mode resolves to today exact host, per chain', () => {
  clean();

  saveChain('solana');
  auth.resetPayModeCache();
  let mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'wallet');
  assert.equal(mode.apiBase, API_URLS.solana);
  assert.equal(auth.gatewayBase(), 'https://sol.blockrun.ai/api');

  saveChain('base');
  auth.resetPayModeCache();
  mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'wallet');
  assert.equal(mode.apiBase, API_URLS.base);
  assert.equal(auth.gatewayBase(), 'https://blockrun.ai/api');
});

test('no key configured — gateway headers carry no Authorization', () => {
  clean();
  const headers = auth.gatewayHeaders();
  assert.equal('Authorization' in headers, false);
  assert.ok(headers['User-Agent'], 'User-Agent is still set');
});

test('isKeyMode is false with no key', () => {
  clean();
  assert.equal(auth.isKeyMode(), false);
});

// ─── Key mode ───────────────────────────────────────────────────────────

test('key on disk switches host to the key gateway and drops /api', () => {
  clean();
  writeKeyFile(VALID_KEY);

  const mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'key');
  assert.equal(mode.apiBase, KEY_API_URL);
  assert.equal(auth.gatewayBase(), 'https://api.blockrun.ai');
  // The key host 404s `wrong_host` on /api/v1/... — the base must not carry it.
  assert.equal(auth.gatewayBase().endsWith('/api'), false);
  assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
  clean();
});

test('BLOCKRUN_API_KEY takes precedence over the key file', () => {
  clean();
  writeKeyFile('brk_live_fromdiskAAAAAAAAAAAAAAAAAAAAAAAA');
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  assert.equal(auth.loadApiKey(), VALID_KEY);
  assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
  clean();
});

test('useWalletMode overrides a configured key', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.equal(auth.isKeyMode(), true);

  auth.useWalletMode();
  assert.equal(auth.isKeyMode(), false);
  assert.equal('Authorization' in auth.gatewayHeaders(), false);
  clean();
});

test('invalidateKey refreshes credentials without changing the payment method', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.equal(auth.isKeyMode(), true);

  auth.invalidateKey();
  assert.equal(auth.isKeyMode(), true, 'only an explicit wallet selection changes payment method');
  clean();
});

test('a malformed configured key fails before any wallet fallback', () => {
  clean();
  // Truncated paste — sending this would produce a confusing 401 on the first
  // paid call instead of an obvious "that is not a key" at configure time.
  process.env.BLOCKRUN_API_KEY = 'brk_live_short';
  auth.resetPayModeCache();
  assert.throws(() => auth.isKeyMode(), /BLOCKRUN_API_KEY/);
  clean();
});

test('isApiKeyShaped accepts live and test keys, rejects other prefixes', () => {
  assert.equal(auth.isApiKeyShaped(VALID_KEY), true);
  assert.equal(auth.isApiKeyShaped('brk_test_' + 'a'.repeat(24)), true);
  assert.equal(auth.isApiKeyShaped('sk-proj-' + 'a'.repeat(40)), false);
  assert.equal(auth.isApiKeyShaped('brk_live_tooshort'), false);
  assert.equal(auth.isApiKeyShaped(''), false);
});

test('maskApiKey never reveals the secret tail beyond four characters', () => {
  const masked = auth.maskApiKey(VALID_KEY);
  assert.ok(masked.startsWith('brk_live_'));
  assert.equal(masked.includes(VALID_KEY), false);
  assert.ok(masked.endsWith(VALID_KEY.slice(-4)));
});

// ─── Fallback classification ────────────────────────────────────────────

test('classifies account failures without choosing a payment method', () => {
  assert.equal(auth.classifyKeyFailure(401, '{"code":"invalid_api_key"}'), 'invalid-key');
  assert.equal(
    auth.classifyKeyFailure(404, '{"code":"unsupported_endpoint"}'),
    'unsupported-endpoint'
  );
  // A malformed request must NOT be retried on the wallet — that would spend
  // real USDC on a call that was always going to fail.
  assert.equal(auth.classifyKeyFailure(400, '{"error":"Invalid request body"}'), null);
  assert.equal(auth.classifyKeyFailure(402, '{"error":"Payment Required"}'), null);
  assert.equal(auth.classifyKeyFailure(500, 'boom'), null);
  assert.equal(auth.classifyKeyFailure(404, '{"error":"Not Found"}'), null);
});

test('toWalletUrl moves a key-host URL onto the chain host, restoring /api', () => {
  assert.equal(
    auth.toWalletUrl('https://api.blockrun.ai/v1/exa/search', 'solana'),
    'https://sol.blockrun.ai/api/v1/exa/search'
  );
  assert.equal(
    auth.toWalletUrl('https://api.blockrun.ai/v1/chat/completions', 'base'),
    'https://blockrun.ai/api/v1/chat/completions'
  );
  // Already a wallet URL — left alone.
  assert.equal(
    auth.toWalletUrl('https://blockrun.ai/api/v1/models', 'base'),
    'https://blockrun.ai/api/v1/models'
  );
});


// ─── Forwarded-request auth (the payment proxy) ─────────────────────────

test('applyGatewayAuth replaces a client Authorization header, whatever its case', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  // Node lowercases inbound header names. Before this was case-insensitive the
  // proxy sent BOTH `authorization` and `Authorization`, the gateway read the
  // client's, and every proxied call 401'd.
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer sk-ant-client-key',
    'X-Franklin-Version': '1',
  };
  auth.applyGatewayAuth(headers);

  const authKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization');
  assert.equal(authKeys.length, 1, 'exactly one Authorization header may survive');
  assert.equal(headers[authKeys[0]], `Bearer ${VALID_KEY}`);
  assert.equal(headers['content-type'], 'application/json', 'other headers are untouched');
  clean();
});

test('applyGatewayAuth leaves a client Authorization alone in wallet mode', () => {
  clean();
  // Wallet mode contributes no credential — payment rides on the 402 retry —
  // so stripping the client's header here would break plain pass-through.
  const headers = { authorization: 'Bearer sk-ant-client-key' };
  auth.applyGatewayAuth(headers);
  assert.equal(headers.authorization, 'Bearer sk-ant-client-key');
});

// ─── Secret redaction ───────────────────────────────────────────────────

test('a BlockRun API key is redacted from text', () => {
  const { redactedText, matches } = redactSecrets(`my key is ${VALID_KEY} ok`);
  assert.equal(redactedText.includes(VALID_KEY), false, 'the key must not survive redaction');
  assert.ok(matches.some((m) => m.label === 'blockrun_api_key'));
});

test('redaction does not fire on ordinary text that merely starts with brk', () => {
  const { matches } = redactSecrets('brk_live_ is a prefix, and brkfast is a word');
  assert.equal(matches.some((m) => m.label === 'blockrun_api_key'), false);
});

// ─── Price catalog ──────────────────────────────────────────────────────

test('priceForPath matches with or without the /api prefix and a query string', () => {
  catalog.__resetPriceCatalog();
  const withApi = catalog.priceForPath('/api/v1/surf/market/ranking');
  const withoutApi = catalog.priceForPath('/v1/surf/market/ranking');
  const withQuery = catalog.priceForPath('/v1/surf/market/ranking?symbol=BTC');
  assert.equal(withApi, withoutApi);
  assert.equal(withApi, withQuery);
  assert.ok(withApi > 0, 'surf is a paid endpoint');
});

test('priceForPath accepts a full gateway URL from either host', () => {
  catalog.__resetPriceCatalog();
  const viaKeyHost = catalog.priceForPath('https://api.blockrun.ai/v1/rpc/base');
  const viaWalletHost = catalog.priceForPath('https://blockrun.ai/api/v1/rpc/base');
  assert.equal(viaKeyHost, viaWalletHost);
  assert.ok(viaKeyHost > 0);
});

test('a more specific pattern beats a wildcard', () => {
  catalog.__primePriceCatalog([
    { endpoint: '/api/v1/modal/*', usd: 0.002 },
    { endpoint: '/api/v1/modal/sandbox/create', usd: 0.011 },
  ]);
  assert.equal(catalog.priceForPath('/v1/modal/sandbox/create'), 0.011);
  assert.equal(catalog.priceForPath('/v1/modal/sandbox/exec'), 0.002);
  catalog.__resetPriceCatalog();
});

test('free endpoints price at zero, unknown endpoints price as null', () => {
  catalog.__resetPriceCatalog();
  assert.equal(catalog.priceForPath('/v1/models'), 0);
  assert.equal(catalog.priceForPath('/v1/crypto/price/BTC'), 0);
  // Chat is model-priced; gateway-models.ts owns it, so the catalog declines.
  assert.equal(catalog.priceForPath('/v1/chat/completions'), null);
});

test('resolveCharge prefers a settled amount, then a reported one, then the catalog', () => {
  catalog.__resetPriceCatalog();

  const settled = catalog.resolveCharge({
    apiPath: '/v1/surf/market/ranking', settledUsd: 0.0085, reportedUsd: 0.02,
  });
  assert.equal(settled.usd, 0.0085);
  assert.equal(settled.estimated, false, 'a settled x402 amount is exact');

  const reported = catalog.resolveCharge({
    apiPath: '/v1/exa/search', reportedUsd: 0.007,
  });
  assert.equal(reported.usd, 0.007);
  assert.equal(reported.estimated, false, 'a gateway-reported charge is exact');

  const listed = catalog.resolveCharge({ apiPath: '/v1/surf/market/ranking' });
  assert.ok(listed.usd > 0, 'key-mode calls must never record zero for paid work');
  assert.equal(listed.estimated, true, 'a catalog price is an estimate');
});

test('resolveCharge falls back to a caller list price for an uncatalogued path', () => {
  catalog.__primePriceCatalog([{ endpoint: '/api/v1/surf/*', usd: 0.0085 }]);
  const charge = catalog.resolveCharge({ apiPath: '/v1/nonexistent/thing', fallbackUsd: 0.05 });
  assert.equal(charge.usd, 0.05);
  assert.equal(charge.estimated, true);
  catalog.__resetPriceCatalog();
});


test('the price catalog is read from the Base origin, the only host that publishes one', async () => {
  // Not a style assertion, and not "Base is the only one with prices" — sol
  // publishes prices too, in openapi.json under x-payment-info. Base is the
  // only host serving the services[] shape parsePricing reads, and sol's
  // published numbers currently disagree with what sol quotes and settles
  // ($0.001 published vs $0.0075 charged for surf fear-greed, measured
  // 2026-09-05). Repointing this per-host pins every estimate to the static
  // floor; switching to sol's sheet makes estimates worse. The comment on
  // CATALOG_URL carries all three numbers.
  const src = await readFile(
    new URL('../dist/payments/price-catalog.js', import.meta.url), 'utf-8'
  );
  assert.match(src, /https:\/\/blockrun\.ai\/\.well-known\/x402/);
  assert.doesNotMatch(
    src, /https:\/\/sol\.blockrun\.ai\/\.well-known/,
    'the sol origin publishes no prices — fetching it yields a permanently stale catalog'
  );
  // A 200 carrying no services[] must be reported, never swallowed.
  assert.match(src, /returned no services/);
});

test('cleanup', () => {
  clean();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

for (const status of [401, 402, 404, 429, 500]) {
  test(`API ${status} preserves the selected account and never retries with a wallet`, async () => {
    clean();
    process.env.BLOCKRUN_API_KEY = VALID_KEY;
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(JSON.stringify({ code: status === 404 ? 'unsupported_endpoint' : 'rejected' }), { status });
    };
    try {
      const { postWithPayment } = await import('../dist/payments/post-with-payment.js');
      const result = await postWithPayment(`${KEY_API_URL}/v1/exa/search`, { query: 'test' }, 'test');
      assert.equal(calls.length, 1, 'account errors must never trigger a wallet request');
      assert.equal(result.status, status);
      assert.equal(result.settled, false);
      assert.equal(calls[0].headers.get('authorization'), `Bearer ${VALID_KEY}`);
      assert.equal(auth.resolvePayMode().kind, 'key');
    } finally {
      globalThis.fetch = originalFetch;
      clean();
    }
  });
}

for (const source of ['env', 'file']) {
  for (const value of ['', '   ', 'not-a-key']) {
    test(`invalid ${source} configuration cannot silently select a wallet (${JSON.stringify(value)})`, () => {
      clean();
      try {
        if (source === 'env') process.env.BLOCKRUN_API_KEY = value;
        else writeKeyFile(value);
        assert.throws(() => auth.resolvePayMode(), /API.key|BLOCKRUN_API_KEY/i);
        auth.useWalletMode();
        assert.equal(auth.resolvePayMode().kind, 'wallet', 'explicit --wallet still works');
      } finally { clean(); }
    });
  }
}

test('saving, rotating and removing a key refreshes request credentials across both wallet chains', () => {
  clean();
  try {
    const secondKey = 'brk_test_' + 'b'.repeat(24);
    auth.saveApiKey(VALID_KEY);
    assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
    auth.saveApiKey(secondKey);
    assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${secondKey}`);
    assert.equal(auth.clearApiKey(), true);
    for (const chain of ['solana', 'base']) {
      saveChain(chain);
      auth.resetPayModeCache();
      assert.equal(auth.gatewayBase(), API_URLS[chain]);
      assert.equal('Authorization' in auth.gatewayHeaders(), false);
    }
  } finally { clean(); }
});
