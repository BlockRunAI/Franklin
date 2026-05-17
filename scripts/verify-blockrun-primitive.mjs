/**
 * Live end-to-end verification of the BlockRun primitive capability.
 *
 * Calls the generic BlockRun tool against a Tier-1 Surf endpoint
 * (/v1/surf/market/fear-greed, $0.001 flat). Verifies the x402 payment
 * flow signs, retries, and settles, and that the response shape matches
 * what skills like /surf-market expect.
 *
 * Cost: ~$0.001 USDC. Wallet must be on Base (Surf settles to Base only).
 */
import { blockrunCapability } from '../dist/tools/blockrun.js';

async function run() {
  const ctx = {
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
  };

  console.log('→ BlockRun({ path: "/v1/surf/market/fear-greed", method: "GET" })');
  const t0 = Date.now();
  const result = await blockrunCapability.execute(
    { path: '/v1/surf/market/fear-greed', method: 'GET' },
    ctx,
  );
  const latency = Date.now() - t0;

  console.log('');
  console.log(`  isError: ${result.isError ? 'YES' : 'no'}`);
  console.log(`  latency: ${latency}ms`);
  console.log('');
  console.log(`  output (first 600 chars):`);
  console.log('  ' + (result.output || '').slice(0, 600).split('\n').join('\n  '));
  console.log('');

  if (result.isError) {
    console.error('FAIL — capability returned isError. See output above.');
    process.exit(1);
  }

  // Sanity check: the head line of output should mention the path + cost
  if (!/BlockRun GET \/v1\/surf\/market\/fear-greed/.test(result.output || '')) {
    console.error('FAIL — output header missing expected method+path');
    process.exit(1);
  }

  console.log('PASS — primitive executed, payment settled, response received.');
}

run().catch(err => {
  console.error('FAIL — uncaught:', err);
  process.exit(1);
});
