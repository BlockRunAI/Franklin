/**
 * Arc (Circle, eip155:5042) as a third payment chain.
 *
 * Arc is EVM and shares the Base wallet key, but it is NOT Base: its USDC is
 * the ERC-20 at 0x3600…0000 with EIP-712 domain name "USDC", and the gateway is
 * arc.blockrun.ai. A payment signed over Base's domain is a valid-looking
 * signature the Circle facilitator rejects, so these tests decode what was
 * actually signed instead of trusting that "the EVM path" is enough.
 *
 * HOME is redirected to a temp dir BEFORE any import (config.ts resolves
 * BLOCKRUN_DIR from os.homedir() at module load).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'franklin-arc-'));
process.env.HOME = TEST_HOME;
delete process.env.BLOCKRUN_API_KEY;
delete process.env.RUNCODE_CHAIN;
process.env.FRANKLIN_NO_AUDIT = '1';
process.env.FRANKLIN_CATALOG_OFFLINE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const config = await import('../dist/config.js');
const auth = await import('../dist/payments/auth-mode.js');
const { readEvmBalance } = await import('../dist/wallet/manager.js');

const ARC_HOST = 'https://arc.blockrun.ai/api';
const USDC_ARC = '0x3600000000000000000000000000000000000000';
const PAY_TO = '0x0000000000000000000000000000000000000001';

function useChain(chain) {
  if (chain === undefined) delete process.env.RUNCODE_CHAIN;
  else process.env.RUNCODE_CHAIN = chain;
  auth.resetPayModeCache();
}

/** The 402 arc.blockrun.ai actually sends (shape captured live 2026-10-03). */
function arcChallenge() {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: 'eip155:5042',
      amount: '2000',
      asset: USDC_ARC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
    }],
    resource: { url: `${ARC_HOST}/v1/exa/search`, description: 'test' },
  })).toString('base64');
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('arc resolves from env and from the saved chain file', () => {
  useChain('arc');
  assert.equal(config.loadChain(), 'arc');
  useChain(undefined);
  config.saveChain('arc');
  assert.equal(config.loadChain(), 'arc');
  config.saveChain('solana');
  assert.equal(config.loadChain(), 'solana');
});

test('an unknown chain value is ignored, never coerced to Arc or Base', () => {
  useChain('arcc');
  config.saveChain('solana');
  assert.equal(config.loadChain(), 'solana');
  useChain(undefined);
});

test('arc pays at arc.blockrun.ai and is an EVM chain', () => {
  assert.equal(config.API_URLS.arc, ARC_HOST);
  assert.equal(config.isEvmChain('arc'), true);
  assert.equal(config.isEvmChain('solana'), false);
  useChain('arc');
  const mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'wallet');
  assert.equal(mode.apiBase, ARC_HOST);
  useChain(undefined);
});

test('the Arc balance is read from the Arc gateway, in 6-decimal USDC', async () => {
  const seen = [];
  const balance = await withFetch(async (url) => {
    seen.push(String(url));
    return Response.json({ address: '0xabc', balance: '25000000', network: 'arc' });
  }, () => readEvmBalance('arc', {
    getWalletAddress: () => '0xabc',
    getBalance: async () => { throw new Error('the Base reader must not be used for Arc'); },
  }));
  assert.equal(balance, 25);
  assert.deepEqual(seen, [`${ARC_HOST}/v1/balance?address=0xabc`]);
});

test('an unreadable Arc balance throws instead of reading as an empty wallet', async () => {
  const client = { getWalletAddress: () => '0xabc', getBalance: async () => 99 };
  await withFetch(async () => new Response('down', { status: 500 }), () =>
    assert.rejects(readEvmBalance('arc', client), /Arc balance read failed/));
  await withFetch(async () => Response.json({ error: 'failed' }), () =>
    assert.rejects(readEvmBalance('arc', client), /no balance/));
});

test('Base keeps its own balance reader', async () => {
  const balance = await withFetch(async () => { throw new Error('no fetch on Base'); },
    () => readEvmBalance('base', { getWalletAddress: () => '0xabc', getBalance: async () => 7.5 }));
  assert.equal(balance, 7.5);
});

test('a paid tool on Arc signs the Arc USDC domain, not Base', async () => {
  useChain('arc');
  const calls = [];
  try {
    const { exaSearchCapability } = await import('../dist/tools/exa.js');
    const result = await withFetch(async (url, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url: String(url), headers });
      if (headers.has('payment-signature')) return Response.json({ results: [] });
      return new Response(JSON.stringify({ error: 'Payment Required' }), {
        status: 402,
        headers: { 'content-type': 'application/json', 'payment-required': arcChallenge() },
      });
    }, () => exaSearchCapability.execute({ query: 'x402' }, { workingDir: TEST_HOME, abortSignal: new AbortController().signal }));

    assert.equal(calls.length, 2, `expected challenge + paid retry, got ${calls.length}: ${result.output}`);
    for (const call of calls) assert.ok(call.url.startsWith(ARC_HOST), `left the Arc host: ${call.url}`);
    const signed = JSON.parse(Buffer.from(calls[1].headers.get('payment-signature'), 'base64').toString());
    assert.equal(signed.accepted.network, 'eip155:5042');
    assert.equal(signed.accepted.asset.toLowerCase(), USDC_ARC);
    assert.equal(signed.accepted.extra.name, 'USDC', 'Arc domain name is "USDC", Base\'s is "USD Coin"');
    assert.equal(signed.payload.authorization.to.toLowerCase(), PAY_TO);
    assert.equal(signed.payload.authorization.value, '2000');

    // Same EVM key as Base: one address funds both chains.
    const { getOrCreateWallet } = await import('@blockrun/llm');
    assert.equal(signed.payload.authorization.from.toLowerCase(), getOrCreateWallet().address.toLowerCase());
  } finally {
    useChain(undefined);
  }
});

test('Arc reads live models from its own gateway, with a cache apart from Base', async () => {
  const catalog = await import('../dist/model-catalog.js');
  catalog.clearModelCatalogCache();
  useChain('arc');
  const arcIdentity = catalog.getModelCatalogIdentity();
  assert.match(arcIdentity, /arc\.blockrun\.ai\/api\/v1\/models/);
  assert.ok(catalog.getModelCatalog().models.length > 0, 'Arc falls back to the bundled Base snapshot offline');
  useChain('base');
  assert.notEqual(catalog.getModelCatalogIdentity(), arcIdentity);
  useChain(undefined);
  catalog.clearModelCatalogCache();
});

test('the system prompt names the Arc gateway as this session\'s host', async () => {
  const { assembleInstructions } = await import('../dist/agent/context.js');
  useChain('arc');
  const all = assembleInstructions(TEST_HOME).join('\n');
  const i = all.indexOf('**Base URLs**');
  const section = all.slice(i, all.indexOf('**Discovery', i));
  assert.match(section, /Your host: `https:\/\/arc\.blockrun\.ai\/api`\*\* — the Arc x402 wallet gateway/);
  assert.match(section, /`https:\/\/blockrun\.ai\/api` \(the Base wallet gateway\)/);
  assert.match(section, /`https:\/\/sol\.blockrun\.ai\/api` \(the Solana wallet gateway\)/);
  useChain(undefined);
});

test('card onramp refuses Arc before any payment handshake', async () => {
  useChain('arc');
  let fetched = false;
  try {
    const { getOnrampUrl } = await import('../dist/onramp/client.js');
    await withFetch(async () => { fetched = true; return new Response('', { status: 500 }); }, () =>
      assert.rejects(getOnrampUrl('0xabc'), /not available on Arc/));
    assert.equal(fetched, false);
  } finally {
    useChain(undefined);
  }
});

test('`franklin setup arc` saves Arc and reuses the EVM wallet', async () => {
  useChain(undefined);
  config.saveChain('solana');
  const { setupCommand } = await import('../dist/commands/setup.js');
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { await setupCommand('arc'); } finally { console.log = log; }
  assert.equal(config.loadChain(), 'arc');
  assert.doesNotMatch(lines.join('\n'), /Solana wallet/);
});

test('cleanup', () => {
  useChain(undefined);
  rmSync(TEST_HOME, { recursive: true, force: true });
});
