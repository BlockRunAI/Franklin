/**
 * Wallet-balance retry helper.
 *
 * Used by the agent UI's startup balance fetch and the post-turn refresh.
 * Some wallet client paths return `0` transiently — for example, when the
 * SDK is queried before the chain provider has finished initializing — even
 * when the on-chain balance is non-zero. A single defensive retry catches
 * that case without lengthening the path for a genuinely empty wallet:
 * empty wallets still resolve to `0` in roughly two RPC round-trips.
 */

export interface RetryOptions {
  /** Delay between the first and second attempt, in milliseconds. */
  delayMs?: number;
}

export async function retryFetchBalance(
  fetchOnce: () => Promise<number>,
  opts: RetryOptions = {},
): Promise<number> {
  const first = await fetchOnce();
  if (first !== 0) return first;
  await sleep(opts.delayMs ?? 750);
  return fetchOnce();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
