/**
 * Deterministic tests for the BlockRun agent-market client (src/market/client.ts),
 * the shared engine behind the `/market` command and the agent_talent tool.
 *
 * A mock marketplace stands in for business.blockrun.ai: it serves the public
 * catalog and answers a run POST with a standard x402 402 challenge, then 200
 * on the paid retry. No network, no real wallet — a throwaway key signs the
 * payment so we can assert Franklin authorizes the EXACT advertised price (the
 * invariant the live route enforces with `signedValueMicro === totalMicro`).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Anvil account #1 — a throwaway signing key (address 0x7099…79C8). Set before
// importing the client so getOrCreateWallet() never touches ~/.blockrun.
process.env.BLOCKRUN_WALLET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WALLET_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const PRICE_MICRO = '20000'; // $0.02
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const CATALOG = {
  skills: [
    {
      slug: 'yield-radar', name: 'Yield Radar', description: 'Live stablecoin yields across chains',
      price_usd: 0.02, backing_model: 'anthropic/claude-haiku-4.5', run_count: 7, execution_type: 'agent',
      data_sources: ['api.barker.money'], sample_input: 'best yields', sample_output: 'Vectis 4.24%',
      creator: { wallet: '0xabc0000000000000000000000000000000000abc', x: 'barker' }, run_url: '',
    },
    {
      slug: 'summarize', name: 'Summarizer', description: 'Summarize any text',
      price_usd: 0.01, backing_model: 'anthropic/claude-haiku-4.5', run_count: 42, execution_type: 'prompt',
      data_sources: [], sample_input: 'long text', sample_output: 'short', creator: { wallet: '0xdef', x: null }, run_url: '',
    },
  ],
};

let server;
let base;
let mod;
let tool;             // agent_talent CapabilityHandler
let handleSlashCommand;
let lastLimit;        // the ?limit= the discovery GET last received (clamp check)
const paidCalls = []; // records the decoded x-payment on each paid retry

before(async () => {
  server = createServer(async (req, res) => {
    const url = req.url || '';
    const json = (code, body, extra) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...(extra || {}) });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.startsWith('/api/v1/skills')) {
      lastLimit = new URL(url, base).searchParams.get('limit');
      return json(200, CATALOG);
    }

    const runMatch = url.match(/^\/api\/v1\/skills\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) {
      const slug = runMatch[1];
      let bodyStr = '';
      for await (const chunk of req) bodyStr += chunk;
      const reqBody = JSON.parse(bodyStr || '{}');

      if (slug === 'always-fail') {
        return json(502, { error: 'upstream boom', code: 'UPSTREAM_ERROR' });
      }

      const xpay = req.headers['x-payment'];
      if (!xpay) {
        // Standard x402 challenge — same body shape the live route returns.
        return json(402, {
          x402Version: 2,
          accepts: [{
            scheme: 'exact', network: 'eip155:8453', amount: PRICE_MICRO, asset: USDC,
            payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
          }],
          resource: { url: `${base}/api/v1/skills/${slug}/run`, description: `Run — ${slug}`, mimeType: 'application/json' },
        });
      }

      const decoded = JSON.parse(Buffer.from(xpay, 'base64').toString());
      paidCalls.push({
        slug,
        input: reqBody.input,
        value: decoded.payload?.authorization?.value,
        from: decoded.payload?.authorization?.from,
        to: decoded.payload?.authorization?.to,
      });
      return json(200, { result: `ran ${slug} on: ${reqBody.input}` }, { 'X-Payment-Receipt': '0xdeadbeefcafe0000' });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BLOCKRUN_MARKET_URL = base;
  mod = await import('../dist/market/client.js');
  tool = (await import('../dist/tools/agent-talent.js')).agentTalentCapability;
  ({ handleSlashCommand } = await import('../dist/agent/commands.js'));
});

after(() => server?.close());

// Minimal ExecutionScope for the tool.
const toolCtx = { workingDir: process.cwd(), abortSignal: new AbortController().signal };

// Drive a slash command and capture the text it emits.
async function runCommand(input) {
  let text = '';
  const ctx = {
    history: [], sessionId: 't', config: {}, client: {},
    onEvent: (e) => { if (e.kind === 'text_delta') text += e.text; },
  };
  const r = await handleSlashCommand(input, ctx);
  return { r, text };
}

test('fetchCatalog parses the public catalog', async () => {
  const skills = await mod.fetchCatalog();
  assert.equal(skills.length, 2);
  assert.equal(skills[0].slug, 'yield-radar');
  assert.equal(skills[0].price_usd, 0.02);
  assert.deepEqual(skills[0].data_sources, ['api.barker.money']);
});

test('filterCatalog matches on name, description, and data source', async () => {
  const skills = await mod.fetchCatalog();
  assert.deepEqual(mod.filterCatalog(skills, 'barker').map((s) => s.slug), ['yield-radar']);
  assert.deepEqual(mod.filterCatalog(skills, 'summarize').map((s) => s.slug), ['summarize']);
  assert.deepEqual(mod.filterCatalog(skills, 'yields').map((s) => s.slug), ['yield-radar']);
  assert.equal(mod.filterCatalog(skills, 'nonexistent-zzz').length, 0);
});

test('formatCatalogList renders a numbered row with slug + price', async () => {
  const skills = await mod.fetchCatalog();
  const out = mod.formatCatalogList(skills, { heading: 'Marketplace:' });
  assert.match(out, /Marketplace:/);
  assert.match(out, /yield-radar/);
  assert.match(out, /\$0\.02/);
  assert.match(out, /\/market run <slug>/);
});

test('formatCatalogList truncates long descriptions at a word boundary', () => {
  const src = 'Live stablecoin yields ranked across many chains and protocols';
  const out = mod.formatCatalogList([{
    slug: 'x', name: 'X', description: src, price_usd: 0.02, backing_model: 'm',
    run_count: 1, execution_type: 'prompt', data_sources: [], creator: { wallet: '0x', x: null }, run_url: '',
  }]);
  assert.match(out, /…/); // it was truncated
  // the word right before the ellipsis must be a COMPLETE source word, not a fragment
  const lastWord = out.split('…')[0].trim().split(' ').pop();
  assert.ok(src.split(' ').includes(lastWord), `"${lastWord}" should be a whole word, not a mid-word cut`);
});

test('formatCatalogList never truncates the slug (it is the run identifier)', () => {
  const slug = 'a-very-long-skill-slug-past-eighteen';
  const out = mod.formatCatalogList([{
    slug, name: 'X', description: 'short', price_usd: 0.01, backing_model: 'm',
    run_count: 1, execution_type: 'prompt', data_sources: [], creator: { wallet: '0x', x: null }, run_url: '',
  }]);
  assert.match(out, new RegExp(slug.replace(/[-]/g, '\\-'))); // full slug present, uncut
});

test('runMarketSkill answers the 402 and authorizes the EXACT advertised price', async () => {
  paidCalls.length = 0;
  const outcome = await mod.runMarketSkill('yield-radar', 'best yields right now');

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.result, 'ran yield-radar on: best yields right now');
  assert.equal(outcome.paidUsd, 0.02);
  assert.equal(outcome.txHash, '0xdeadbeefcafe0000');

  // The signed authorization must carry the exact price the route requires
  // (the live route rejects any other value), be paid by our wallet, and pay
  // the advertised recipient.
  assert.equal(paidCalls.length, 1);
  assert.equal(paidCalls[0].value, PRICE_MICRO);
  assert.equal(paidCalls[0].from.toLowerCase(), WALLET_ADDR.toLowerCase());
  assert.equal(paidCalls[0].to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(paidCalls[0].input, 'best yields right now');
});

test('runMarketSkill fails closed with no charge on a non-2xx run', async () => {
  const outcome = await mod.runMarketSkill('always-fail', 'whatever');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 502);
  assert.equal(outcome.paidUsd, 0);
  assert.match(outcome.error, /upstream boom/);
});

test('fetchCatalog clamps the limit to 200 and passes it through', async () => {
  await mod.fetchCatalog({ limit: 500 });
  assert.equal(lastLimit, '200');
  await mod.fetchCatalog({ limit: 5 });
  assert.equal(lastLimit, '5');
});

test('formatSkillCard shows price, model, type badge, sample and a run hint', async () => {
  const skills = await mod.fetchCatalog();
  const card = mod.formatSkillCard(skills.find((s) => s.slug === 'yield-radar'));
  assert.match(card, /Yield Radar/);
  assert.match(card, /\$0\.02\/run/);
  assert.match(card, /anthropic\/claude-haiku-4\.5/);
  assert.match(card, /live:api\.barker\.money/);
  assert.match(card, /@barker/);
  assert.match(card, /\/market run yield-radar/);
});

// ─── agent_talent tool ──────────────────────────────────────────────────────

test('agent_talent list returns the catalog with slug + price + type', async () => {
  const r = await tool.execute({ action: 'list' }, toolCtx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /yield-radar/);
  assert.match(r.output, /\$0\.02\/run/);
  assert.match(r.output, /live-data\(api\.barker\.money\)/);
  assert.match(r.output, /action: "run"/);
});

test('agent_talent list filters by query', async () => {
  const r = await tool.execute({ action: 'list', query: 'summarize' }, toolCtx);
  assert.match(r.output, /summarize/);
  assert.doesNotMatch(r.output, /yield-radar/);
});

test('agent_talent list reports cleanly when nothing matches', async () => {
  const r = await tool.execute({ action: 'list', query: 'no-such-skill-zzz' }, toolCtx);
  assert.match(r.output, /No marketplace skills match/);
});

test('agent_talent run hires a skill and reports the amount paid', async () => {
  const r = await tool.execute({ action: 'run', slug: 'yield-radar', input: 'best yields' }, toolCtx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /Hired yield-radar/);
  assert.match(r.output, /paid \$0\.02/);
  assert.match(r.output, /ran yield-radar on: best yields/);
});

test('agent_talent run requires slug and input', async () => {
  const noSlug = await tool.execute({ action: 'run', input: 'x' }, toolCtx);
  assert.equal(noSlug.isError, true);
  assert.match(noSlug.output, /slug` is required/);
  const noInput = await tool.execute({ action: 'run', slug: 'yield-radar' }, toolCtx);
  assert.equal(noInput.isError, true);
  assert.match(noInput.output, /input` is required/);
});

test('agent_talent run surfaces a failed hire as no-charge', async () => {
  const r = await tool.execute({ action: 'run', slug: 'always-fail', input: 'x' }, toolCtx);
  assert.equal(r.isError, true);
  assert.match(r.output, /failed/);
  assert.match(r.output, /No charge/);
});

test('agent_talent rejects an unknown action', async () => {
  const r = await tool.execute({ action: 'frobnicate' }, toolCtx);
  assert.equal(r.isError, true);
  assert.match(r.output, /unknown action/);
});

test('agent_talent marks only list (not run) concurrency-safe', () => {
  assert.equal(tool.isConcurrentSafe({ action: 'list' }), true);
  assert.equal(tool.isConcurrentSafe({ action: 'run' }), false);
});

// ─── /market slash command ──────────────────────────────────────────────────

test('/market browses the catalog', async () => {
  const { r, text } = await runCommand('/market');
  assert.equal(r.handled, true);
  assert.match(text, /Agent talents/);
  assert.match(text, /yield-radar/);
  assert.match(text, /summarize/);
});

test('/market <keyword> searches', async () => {
  const { text } = await runCommand('/market summarize');
  assert.match(text, /matching "summarize"/);
  assert.match(text, /summarize/);
  assert.doesNotMatch(text, /yield-radar/);
});

test('/market info <slug> shows the detail card', async () => {
  const { text } = await runCommand('/market info yield-radar');
  assert.match(text, /Yield Radar/);
  assert.match(text, /\$0\.02\/run/);
  assert.match(text, /live:api\.barker\.money/);
});

test('/market info without a slug prints usage', async () => {
  const { text } = await runCommand('/market info');
  assert.match(text, /Usage: \/market info <slug>/);
});

test('/market run <slug> <input> pays and prints the result', async () => {
  const { text } = await runCommand('/market run yield-radar best yields now');
  assert.match(text, /Paid \$0\.02/);
  assert.match(text, /ran yield-radar on: best yields now/);
});

test('/market run with bad args prints usage', async () => {
  const { text } = await runCommand('/market run');
  assert.match(text, /Usage: \/market run <slug> <input>/);
});

test('/market run on a failing skill reports no charge', async () => {
  const { text } = await runCommand('/market run always-fail something');
  assert.match(text, /Could not run always-fail/);
  assert.match(text, /No charge/);
});

// ─── permission policy: free to browse, asks before it spends ───────────────

test('agent_talent browsing auto-allows but hiring asks for confirmation', async () => {
  const { PermissionManager } = await import('../dist/agent/permissions.js');
  const pm = new PermissionManager('default');

  const list = await pm.check('agent_talent', { action: 'list', query: 'yields' });
  assert.equal(list.behavior, 'allow'); // free read — no prompt

  const run = await pm.check('agent_talent', { action: 'run', slug: 'yield-radar', input: 'x' });
  assert.equal(run.behavior, 'ask'); // spends USDC — must confirm
});
