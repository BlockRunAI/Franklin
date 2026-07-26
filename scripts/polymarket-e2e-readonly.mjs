/**
 * Read-only local-wallet preflight for the Polymarket redeem/withdraw paths.
 *
 * Nothing in the local suite touches order/withdraw/redeem — test/polymarket.local.mjs
 * covers the l1-auth golden vectors only — so a green `npm test` says nothing
 * about whether this module still works against the live CLOB. This script is
 * the cheapest thing that does: it exercises the real read paths with the real
 * wallet and no money movement.
 *
 * Safety contract (ported from blockrun-mcp's scripts/polymarket-e2e-readonly.ts,
 * originally @KillerQueen-Z's #66): never supplies confirm:true, so withdrawFunds
 * returns its dry-run preview and signs nothing; and never emits a wallet
 * address, private key, or transaction identifier.
 *
 * Run with: npm run e2e:polymarket:readonly
 */
import { listPositions } from '../dist/tools/polymarket/positions.js';
import { withdrawFunds } from '../dist/tools/polymarket/withdraw.js';
import { listOpenOrders } from '../dist/tools/polymarket/orders.js';
import { getPolymarketAccount } from '../dist/tools/polymarket/client.js';
import { getSigType } from '../dist/tools/polymarket/constants.js';
import { loadL2Creds } from '../dist/tools/polymarket/creds.js';

/** Strip anything address- or hash-shaped, whatever path produced the text. */
const redact = (text) =>
  String(text)
    .replace(/0x[a-fA-F0-9]{64}/g, '<hash>')
    .replace(/0x[a-fA-F0-9]{40}/g, '<wallet>');

// No confirm: true anywhere in this file. withdrawFunds({}) is the dry run.
const [positionsResult, withdrawalResult] = await Promise.all([
  listPositions(),
  withdrawFunds({}),
]);

// Only the fields below are emitted — `structured.user` is deliberately dropped.
const positions = (positionsResult.structured?.positions ?? []).map((position) => ({
  title: position.title,
  outcome: position.outcome,
  size: position.size,
  currentValue: position.currentValue,
  redeemable: position.redeemable,
  negativeRisk: position.negativeRisk,
  condition: position.conditionId ? `${position.conditionId.slice(0, 10)}…` : undefined,
}));

// The CLOB read is the only part that exercises clob-client-v2 itself, but
// reaching it without existing L2 creds would DERIVE them — a side effect on
// Polymarket's side. So it runs only when the creds are already on disk, and
// reports why it skipped otherwise. Still read-only: getOpenOrders places
// nothing.
const sigType = getSigType();
const signer = getPolymarketAccount().address;
const hasL2Creds = loadL2Creds(signer, sigType) !== null;
let openOrders;
if (hasL2Creds) {
  const r = await listOpenOrders({});
  openOrders = r.isError
    ? redact(r.text)
    : { count: r.structured?.orders?.length ?? 0 };
} else {
  openOrders = 'skipped — no L2 creds cached; reaching the CLOB would derive them (a side effect)';
}

const report = {
  positionsError: positionsResult.isError ? redact(positionsResult.text) : undefined,
  positionCount: positions.length,
  positions,
  sigType,
  openOrders,
  withdrawalPreview: withdrawalResult.isError
    ? redact(withdrawalResult.text)
    : {
      dryRun: withdrawalResult.structured?.dryRun,
      amountUsd: withdrawalResult.structured?.amountUsd,
      pusdUsd: withdrawalResult.structured?.pusdUsd,
      usdceUsd: withdrawalResult.structured?.usdceUsd,
      wrapUsd: withdrawalResult.structured?.wrapUsd,
      toChainId: withdrawalResult.structured?.toChainId,
    },
};

console.log(JSON.stringify(report, null, 2));

// A dry run that reports dryRun !== true would mean withdrawFunds took a
// non-preview branch without confirm — fail loudly rather than print it.
if (!withdrawalResult.isError && withdrawalResult.structured?.dryRun !== true) {
  console.error('\nFATAL: withdrawFunds({}) did not return a dry run. Not a read-only path.');
  process.exit(1);
}
