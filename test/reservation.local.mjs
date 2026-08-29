/**
 * WalletReservation accounting — ambiguous-settlement path (#128).
 * No network: balance is seeded so hold() never hits RPC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { walletReservation, AMBIGUOUS_GRACE_MS } = await import('../dist/wallet/reservation.js');

test('markAmbiguous keeps the amount counted and survives a later release()', async () => {
  walletReservation._resetForTests();
  walletReservation._seedBalanceForTests(0.10);

  const a = await walletReservation.hold(0.06);
  assert.ok(a, 'first hold fits');
  assert.equal(await walletReservation.hold(0.06), null, 'second hold blocked by first');

  // Paid request dispatched, then aborted: outcome ambiguous.
  walletReservation.markAmbiguous(a);
  // Caller's finally still runs release() — must be a no-op now.
  walletReservation.release(a);
  walletReservation._seedBalanceForTests(0.10); // on-chain read still shows old balance

  const snap = walletReservation.snapshot();
  assert.equal(snap.count, 0);
  assert.equal(snap.ambiguousCount, 1);
  assert.equal(snap.totalUsd, 0.06, 'ambiguous spend still counted against headroom');
  assert.equal(await walletReservation.hold(0.06), null, 'cap errs tight, not loose');
});

test('ambiguous holds self-heal after the grace window on a fresh balance fetch', async () => {
  let fetches = 0;
  walletReservation._resetForTests(async () => { fetches++; return 0.10; });
  const a = await walletReservation.hold(0.06);
  walletReservation.markAmbiguous(a);

  // Inside the window a fresh on-chain read does NOT prune the entry.
  assert.equal(await walletReservation.hold(0.06), null);
  assert.ok(fetches >= 2, 'markAmbiguous invalidated the cache, forcing a refetch');

  // Past the window, the next fresh fetch prunes it.
  walletReservation._ageAmbiguousForTests(AMBIGUOUS_GRACE_MS + 1);
  walletReservation.invalidateBalance();
  const b = await walletReservation.hold(0.06);
  assert.ok(b, 'hold succeeds once the ambiguous entry is pruned');
  assert.equal(walletReservation.snapshot().ambiguousCount, 0);
  walletReservation.release(b);
});

test('markAmbiguous is a no-op for free tokens and unknown ids', () => {
  walletReservation._resetForTests();
  walletReservation.markAmbiguous({ id: 'free-x', amountUsd: 0 });
  walletReservation.markAmbiguous('res-does-not-exist');
  walletReservation.markAmbiguous(null);
  assert.equal(walletReservation.snapshot().ambiguousCount, 0);
});
