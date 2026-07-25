/**
 * Live end-to-end verification of Franklin's Opus request payload.
 *
 * Calls each model through the real ModelClient (which builds and posts the
 * request payload exactly the way Franklin does in production). Expectation:
 * a 200 streaming response, NOT a 400 complaining about the `thinking` field.
 *
 * The default pair covers both sides of the extended-thinking allowlist:
 * Opus 5 must be called WITHOUT the flag (it thinks by default and rejects
 * `budget_tokens`), Opus 4.6 must still be called WITH it — a regression check
 * that promoting the flagship didn't break the older path.
 *
 * Pass model ids as argv to override (e.g. `node scripts/verify-opus-47.mjs
 * anthropic/claude-opus-4.7`).
 *
 * Cost: ~$0.001 USDC across the two calls (tiny prompt, max_tokens=64).
 */
import { ModelClient } from '../dist/agent/llm.js';

const API_URL = process.env.BLOCKRUN_API_URL || 'https://blockrun.ai/api';

async function callModel(model) {
  const client = new ModelClient({ apiUrl: API_URL, chain: 'base' });
  const t0 = Date.now();
  let chunks = 0;
  let firstError = null;
  let textOut = '';
  try {
    const gen = client.streamCompletion({
      model,
      messages: [{ role: 'user', content: 'Say the single word: ok' }],
      max_tokens: 64,
    });
    for await (const chunk of gen) {
      chunks++;
      if (chunk.kind === 'error') {
        firstError = JSON.stringify(chunk.payload);
        break;
      }
      if (chunk.kind === 'content_block_delta') {
        const delta = chunk.payload?.delta;
        if (delta?.text) textOut += delta.text;
      }
    }
  } catch (e) {
    firstError = e.message + (e.cause ? ` | cause: ${JSON.stringify(e.cause)}` : '');
  }
  const dt = Date.now() - t0;
  return { model, chunks, dt, firstError, textOut: textOut.slice(0, 80) };
}

console.log(`Endpoint: ${API_URL}\n`);

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['anthropic/claude-opus-5', 'anthropic/claude-opus-4.6'];

for (const m of MODELS) {
  process.stdout.write(`→ ${m} ... `);
  const r = await callModel(m);
  if (r.firstError) {
    console.log(`FAIL (${r.dt}ms)`);
    console.log(`   error: ${r.firstError}`);
  } else {
    console.log(`ok (${r.chunks} chunks, ${r.dt}ms)  text="${r.textOut}"`);
  }
}
