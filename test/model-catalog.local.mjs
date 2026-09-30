import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import snapshot from '@blockrun/model-catalog/snapshot' with { type: 'json' };

process.env.RUNCODE_CHAIN = 'solana';
delete process.env.FRANKLIN_CATALOG_OFFLINE;
const auth = await import('../dist/payments/auth-mode.js');
auth.useWalletMode();

test('Franklin refreshes central catalog, picker, aliases and pricing without a rebuild', async () => {
  let bundle = structuredClone(snapshot);
  let rows = bundle.catalog.models.filter(m => m.networks.solana.listed).map(m => ({ id: m.id, name: m.name, ...m.networks.solana }));
  let broken = false;
  const server = createServer((req, res) => {
    if (broken) { res.writeHead(503); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/catalog' ? bundle : { data: rows }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.BLOCKRUN_MODEL_CATALOG_URL = `${base}/catalog`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => originalFetch(String(url).includes('/api/v1/models') ? `${base}/models` : url, options);
  try {
    const catalog = await import('../dist/model-catalog.js');
    const picker = await import('../dist/ui/model-picker.js');
    const pricing = await import('../dist/pricing.js');
    const list = picker.PICKER_MODELS_FLAT;
    let state = await catalog.refreshModelCatalog({ force: true });
    assert.equal(state.source, 'live');
    assert.equal(state.lastError, undefined);
    assert.equal(list.length, state.groups.filter(g => g.id !== 'other').flatMap(g => g.models).length + 1);
    assert.ok(!list.some(m => m.id === 'openai/gpt-6-astra'), 'uncurated models stay behind +more');
    assert.equal(picker.resolveModel('openai/gpt-6-astra'), 'openai/gpt-6-astra');
    assert.ok(!list.some(m => m.id === 'openai/o3'), 'Solana category overlay must apply');
    assert.equal(picker.resolveModel('kimi'), 'moonshot/kimi-k3');

    // Only the centrally served data changes below. No code/package rebuild.
    const id = 'test/future-model';
    const model = { id, name: 'Future Model', categories: ['chat'], billing_mode: 'paid', pricing: { input: 0.88, output: 2.5 } };
    rows.push(model);
    bundle.catalog.models.push({ id, name: model.name, provider: 'test', lifecycle: 'active', declared_capabilities: ['chat'], aliases: [], redirects: [], networks: { solana: { ...model, listed: true }, base: { listed: false, categories: [], billing_mode: 'unavailable', pricing: {} } } });
    const bump = version => {
      bundle.catalog.catalog_version = bundle.picker_policy.catalog_version = bundle.router_policy.catalog_version = version;
    };
    bump('2026.09.29.2');
    const view = bundle.picker_policy.views.default_chat;
    view.shortcuts.future = id;
    // Curation is policy data too: promoting the model into a group reaches the picker live.
    view.model_ids.push(id);
    view.groups[0].model_ids.push(id);
    state = await catalog.refreshModelCatalog({ force: true });
    assert.equal(state.lastError, undefined);
    assert.equal(state.version, '2026.09.29.2');
    assert.equal(picker.PICKER_MODELS_FLAT, list);
    assert.ok(list.some(m => m.id === id && m.price === '$0.88/$2.5'));
    assert.equal(picker.resolveModel('future'), id);
    assert.equal(pricing.estimateCost(id, 1_000_000, 1_000_000), 3.38);

    model.pricing.input = 1.25;
    await catalog.refreshModelCatalog({ force: true });
    assert.equal(pricing.MODEL_PRICING[id].input, 1.25);
    assert.ok(list.some(m => m.id === id && m.price === '$1.25/$2.5'));
    broken = true;
    state = await catalog.refreshModelCatalog({ force: true });
    assert.match(state.lastError, /503/);
    assert.ok(list.some(m => m.id === id), 'last good cache retained on outage');

    broken = false;
    rows = rows.filter(m => m.id !== id);
    bundle.catalog.models = bundle.catalog.models.filter(m => m.id !== id);
    delete view.shortcuts.future;
    view.model_ids = view.model_ids.filter(x => x !== id);
    view.groups[0].model_ids = view.groups[0].model_ids.filter(x => x !== id);
    bump('2026.09.29.3');
    state = await catalog.refreshModelCatalog({ force: true });
    assert.equal(state.lastError, undefined);
    assert.ok(!list.some(m => m.id === id));
    assert.equal(picker.MODEL_SHORTCUTS.future, undefined);
    assert.equal(pricing.MODEL_PRICING[id], undefined);
    assert.ok(pricing.MODEL_PRICING['moonshot/kimi-k2.5'], 'historical session prices remain readable');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.BLOCKRUN_MODEL_CATALOG_URL;
    await new Promise(resolve => server.close(resolve));
  }
});


test('catalog isolates Base, Solana and API accounts and keeps credentials off policy requests', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BLOCKRUN_API_KEY;
  const originalPolicyUrl = process.env.BLOCKRUN_MODEL_CATALOG_URL;
  const policyUrl = 'https://catalog.example.test/snapshot.json';
  process.env.BLOCKRUN_MODEL_CATALOG_URL = policyUrl;
  const catalog = await import('../dist/model-catalog.js');
  const gateway = await import('../dist/gateway-models.js');
  const requests = [];
  let releaseBase;
  let baseStarted;
  const started = new Promise(resolve => { baseStarted = resolve; });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const headers = new Headers(init?.headers);
    requests.push({ target, authenticated: headers.has('Authorization') });
    if (target === policyUrl) {
      assert.equal(headers.has('Authorization'), false);
      return Response.json(snapshot);
    }
    let id;
    if (target.startsWith('https://blockrun.ai/')) {
      assert.equal(headers.has('Authorization'), false);
      baseStarted();
      await new Promise(resolve => { releaseBase = resolve; });
      id = 'test/base-only';
    } else if (target.startsWith('https://sol.blockrun.ai/')) {
      assert.equal(headers.has('Authorization'), false);
      id = 'test/solana-only';
    } else {
      assert.ok(target.startsWith('https://api.blockrun.ai/'));
      assert.equal(headers.get('Authorization'), `Bearer ${process.env.BLOCKRUN_API_KEY}`);
      id = process.env.BLOCKRUN_API_KEY.endsWith('A') ? 'test/account-a' : 'test/account-b';
    }
    return Response.json({ data: [{ id, name: id, categories: ['chat'], billing_mode: 'paid', pricing: { input: 1, output: 2 } }] });
  };
  try {
    auth.useWalletMode();
    gateway.clearGatewayModelsCache();
    const basePending = catalog.refreshModelCatalog({ network: 'base', force: true });
    await started;
    const solana = await catalog.refreshModelCatalog({ network: 'solana', force: true });
    assert.equal(solana.models[0].id, 'test/solana-only');
    releaseBase();
    assert.equal((await basePending).models[0].id, 'test/base-only');
    assert.equal(catalog.getModelCatalog().models[0].id, 'test/solana-only');
    const { MODEL_SHORTCUTS } = await import('../dist/ui/model-picker.js');
    assert.equal(MODEL_SHORTCUTS['test/solana-only'], 'test/solana-only');
    assert.equal(MODEL_SHORTCUTS['test/base-only'], undefined);

    for (const suffix of ['A', 'B']) {
      process.env.BLOCKRUN_API_KEY = `brk_test_${'x'.repeat(24)}${suffix}`;
      auth.resetPayModeCache();
      const rows = await gateway.getGatewayModels();
      assert.equal(rows[0].id, `test/account-${suffix.toLowerCase()}`);
    }
    assert.equal(requests.filter(r => r.authenticated).length, 2);
  } finally {
    releaseBase?.();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BLOCKRUN_API_KEY;
    else process.env.BLOCKRUN_API_KEY = originalKey;
    if (originalPolicyUrl === undefined) delete process.env.BLOCKRUN_MODEL_CATALOG_URL;
    else process.env.BLOCKRUN_MODEL_CATALOG_URL = originalPolicyUrl;
    auth.useWalletMode();
    gateway.clearGatewayModelsCache();
  }
});


test('metadata can load before --wallet overrides an invalid configured API key', async () => {
  const originalKey = process.env.BLOCKRUN_API_KEY;
  const catalog = await import('../dist/model-catalog.js');
  try {
    process.env.BLOCKRUN_API_KEY = 'invalid-test-key';
    auth.resetPayModeCache();
    assert.ok(catalog.getModelCatalog().models.length > 0);
    assert.doesNotThrow(() => catalog.getModelCatalogIdentity());
    await assert.rejects(catalog.refreshModelCatalog(), /Invalid API key/);
    auth.useWalletMode();
    assert.ok(catalog.getModelCatalog().models.length > 0);
  } finally {
    if (originalKey === undefined) delete process.env.BLOCKRUN_API_KEY;
    else process.env.BLOCKRUN_API_KEY = originalKey;
    auth.useWalletMode();
    catalog.clearModelCatalogCache();
  }
});
