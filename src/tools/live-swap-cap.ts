/**
 * Process-wide live-swap safety cap, shared by every swap venue.
 *
 * A live on-chain swap is irreversible, so it gets a hard count cap even
 * though the per-turn $-cap was removed in v3.11.0. Default 10 swaps per
 * Franklin process across ALL venues (Jupiter, 0x Base, 0x gasless) —
 * previously each venue kept its own counter, so the effective cap was 30.
 * Override via FRANKLIN_LIVE_SWAP_CAP (0 disables). Resets on restart.
 */
const DEFAULT_LIVE_SWAP_CAP = 10;
export const liveSwapCap = (() => {
  const raw = process.env.FRANKLIN_LIVE_SWAP_CAP;
  if (!raw) return DEFAULT_LIVE_SWAP_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIVE_SWAP_CAP;
  if (n <= 0) return Infinity;
  return Math.floor(n);
})();

let count = 0;

export function getLiveSwapCount(): number {
  return count;
}

/** Call once per swap that actually submitted on-chain. */
export function recordLiveSwap(): void {
  count += 1;
}

/** Test helper. */
export function resetLiveSwapCount(): void {
  count = 0;
}

/**
 * USD value above which the confirm prompt shows a "Large swap" line (only
 * computable for stablecoin inputs). Override via FRANKLIN_LIVE_SWAP_WARN_USD.
 */
const DEFAULT_LARGE_SWAP_USD = 20;
export const largeSwapThresholdUsd = (() => {
  const raw = process.env.FRANKLIN_LIVE_SWAP_WARN_USD;
  if (!raw) return DEFAULT_LARGE_SWAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LARGE_SWAP_USD;
  return n;
})();
