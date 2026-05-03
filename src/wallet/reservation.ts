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

class WalletReservationManager {
  private reserved = new Map<string, number>();
  private cachedBalance: { value: number; fetchedAt: number } | null = null;
  private balanceFetchInflight: Promise<number> | null = null;

  private async fetchBalance(): Promise<number> {
    if (this.cachedBalance && Date.now() - this.cachedBalance.fetchedAt < BALANCE_CACHE_MS) {
      return this.cachedBalance.value;
    }
    if (this.balanceFetchInflight) return this.balanceFetchInflight;

    const chain = loadChain();
    this.balanceFetchInflight = (async () => {
      try {
        if (chain === 'solana') {
          const client = await setupAgentSolanaWallet({ silent: true });
          return await client.getBalance();
        }
        const client = setupAgentWallet({ silent: true });
        return await client.getBalance();
      } catch {
        // If balance fetch fails, return Infinity so reservations don't
        // block — the actual payment will surface the real error. We'd
        // rather under-protect than block all paid tools on RPC flakiness.
        return Number.POSITIVE_INFINITY;
      }
    })()
      .then((v) => {
        this.cachedBalance = { value: v, fetchedAt: Date.now() };
        this.balanceFetchInflight = null;
        return v;
      });

    return this.balanceFetchInflight;
  }

  private totalReserved(): number {
    let sum = 0;
    for (const v of this.reserved.values()) sum += v;
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

  /** Force the next hold() to refetch balance from chain. */
  invalidateBalance(): void {
    this.cachedBalance = null;
  }

  /** Snapshot of current reservation state — diagnostic / testing only. */
  snapshot(): { count: number; totalUsd: number } {
    return { count: this.reserved.size, totalUsd: this.totalReserved() };
  }
}

export const walletReservation = new WalletReservationManager();
