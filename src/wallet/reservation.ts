/**
 * WalletReservation — local accounting layer for concurrent paid tool calls.
 *
 * Problem this solves: when N batch tools (ImageGen / VideoGen) run in
 * parallel, each independently checks balance and dispatches its x402
 * payment. With balance $0.20 and 6 calls × $0.04 each, all 6 see "$0.20
 * available, $0.04 fits" and start; only 5 can actually settle on-chain,
 * the rest fail mid-flight with insufficient-funds and the user sees
 * partial completion with no preflight warning.
 *
 * The fix is *not* on-chain — x402 is fire-and-forget per-request, there's
 * no real "hold" capability. Instead this is a per-process bookkeeping
 * layer:
 *   1. Tool calls hold(amount) before paying.
 *   2. hold() refuses if (balance - sum(active reservations)) < amount.
 *   3. After payment succeeds OR fails, tool calls release(token).
 *   4. If the outcome is AMBIGUOUS — the signed request was dispatched and
 *      then aborted / timed out before a response came back — the caller
 *      marks the token ambiguous instead. The gateway may have settled the
 *      payment on-chain, so the amount stays counted against headroom for
 *      a grace window and is dropped on the next fresh balance fetch after
 *      that window (which reflects the real on-chain state). The cap can
 *      only err tight, never loose.
 *
 * Single-process JS guarantees the check-and-set is atomic (no real race),
 * and balance is cached briefly so we don't hit the RPC for every hold.
 */

import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { loadChain } from '../config.js';

export interface ReservationToken {
  id: string;
  amountUsd: number;
}

const BALANCE_CACHE_MS = 5_000;
/**
 * How long an ambiguous-settlement hold stays counted before a fresh
 * balance fetch is trusted to reflect it. x402 settlement on Base / Solana
 * lands well inside this; the window only bounds how long we err tight.
 */
export const AMBIGUOUS_GRACE_MS = 30_000;

async function readChainBalance(): Promise<number> {
  if (loadChain() === 'solana') {
    const client = await setupAgentSolanaWallet({ silent: true });
    return client.getBalance();
  }
  const client = setupAgentWallet({ silent: true });
  return client.getBalance();
}

class WalletReservationManager {
  private reserved = new Map<string, number>();
  private ambiguous = new Map<string, { amountUsd: number; at: number }>();
  private cachedBalance: { value: number; fetchedAt: number } | null = null;
  private balanceFetchInflight: Promise<number> | null = null;
  private balanceFetcher: () => Promise<number> = readChainBalance;

  private async fetchBalance(): Promise<number> {
    if (this.cachedBalance && Date.now() - this.cachedBalance.fetchedAt < BALANCE_CACHE_MS) {
      return this.cachedBalance.value;
    }
    if (this.balanceFetchInflight) return this.balanceFetchInflight;

    this.balanceFetchInflight = (async () => {
      try {
        return await this.balanceFetcher();
      } catch {
        // If balance fetch fails, return Infinity so reservations don't
        // block — the actual payment will surface the real error. We'd
        // rather under-protect than block all paid tools on RPC flakiness.
        return Number.POSITIVE_INFINITY;
      }
    })()
      .then((v) => {
        const now = Date.now();
        this.cachedBalance = { value: v, fetchedAt: now };
        this.balanceFetchInflight = null;
        // A fresh on-chain read already includes any ambiguous spend that
        // actually settled; drop entries past the grace window so a
        // genuinely-absent spend self-heals instead of pinning headroom.
        for (const [id, entry] of this.ambiguous) {
          if (now - entry.at >= AMBIGUOUS_GRACE_MS) this.ambiguous.delete(id);
        }
        return v;
      });

    return this.balanceFetchInflight;
  }

  private totalReserved(): number {
    let sum = 0;
    for (const v of this.reserved.values()) sum += v;
    for (const e of this.ambiguous.values()) sum += e.amountUsd;
    return sum;
  }

  /**
   * Try to reserve `amountUsd`. Returns a token on success, or null if
   * insufficient (balance - already-reserved < amountUsd). Caller MUST
   * release the token after the actual payment resolves, success or fail.
   */
  async hold(amountUsd: number): Promise<ReservationToken | null> {
    if (amountUsd <= 0) {
      // Free / zero-cost calls don't need accounting.
      return { id: `free-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, amountUsd: 0 };
    }
    const balance = await this.fetchBalance();
    const available = balance - this.totalReserved();
    if (available < amountUsd) return null;

    const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.reserved.set(id, amountUsd);
    return { id, amountUsd };
  }

  /**
   * Release a hold. Idempotent — releasing the same token twice is a no-op.
   * Invalidate the balance cache so the next hold sees up-to-date state.
   */
  release(token: ReservationToken | string | null | undefined): void {
    if (!token) return;
    const id = typeof token === 'string' ? token : token.id;
    if (this.reserved.delete(id)) {
      // A real payment may have just settled on-chain; force re-fetch
      // next time so subsequent holds see the post-payment balance.
      this.cachedBalance = null;
    }
  }

  /**
   * Mark a hold as ambiguous: the signed payment was dispatched but the
   * request aborted / timed out before we saw the outcome. The money may be
   * gone, so keep the amount counted against headroom (see header). A later
   * release() of the same token is a no-op — the ambiguous entry outlives it.
   */
  markAmbiguous(token: ReservationToken | string | null | undefined): void {
    if (!token) return;
    const id = typeof token === 'string' ? token : token.id;
    const amountUsd = this.reserved.get(id);
    if (amountUsd === undefined || amountUsd <= 0) return;
    this.reserved.delete(id);
    this.ambiguous.set(id, { amountUsd, at: Date.now() });
    this.cachedBalance = null;
  }

  /** Force the next hold() to refetch balance from chain. */
  invalidateBalance(): void {
    this.cachedBalance = null;
  }

  /** Snapshot of current reservation state — diagnostic / testing only. */
  snapshot(): { count: number; totalUsd: number; ambiguousCount: number; ambiguousUsd: number } {
    let ambiguousUsd = 0;
    for (const e of this.ambiguous.values()) ambiguousUsd += e.amountUsd;
    return {
      count: this.reserved.size,
      totalUsd: this.totalReserved(),
      ambiguousCount: this.ambiguous.size,
      ambiguousUsd,
    };
  }

  /** Testing only — reset all bookkeeping and cached balance. */
  _resetForTests(fetcher?: () => Promise<number>): void {
    this.reserved.clear();
    this.ambiguous.clear();
    this.cachedBalance = null;
    this.balanceFetchInflight = null;
    this.balanceFetcher = fetcher ?? readChainBalance;
  }

  /** Testing only — seed the balance cache so hold() never touches RPC. */
  _seedBalanceForTests(value: number): void {
    this.cachedBalance = { value, fetchedAt: Date.now() };
  }

  /** Testing only — backdate an ambiguous entry past the grace window. */
  _ageAmbiguousForTests(ms: number): void {
    for (const e of this.ambiguous.values()) e.at -= ms;
  }
}

export const walletReservation = new WalletReservationManager();
