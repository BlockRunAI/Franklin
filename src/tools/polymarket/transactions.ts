// src/utils/polymarket/transactions.ts
//
// viem's waitForTransactionReceipt resolves for BOTH successful and reverted
// transactions — it only throws when the receipt cannot be fetched. So awaiting
// it proves the transaction was mined, not that it did anything. Every money
// path here must assert the status explicitly.
//
// This was open-coded in three places (redeem, setup, withdraw) with three
// slightly different error strings, and withdraw's copy was missing entirely
// until 0.32.3 — a reverted pUSD transfer printed "✅ Withdrawal submitted".
// One helper, so the next money path cannot forget.
//
// Extracted per @KillerQueen-Z's design in #66.

/** Minimal shape so callers can pass a viem receipt without importing its type. */
export interface TransactionStatusLike {
  status?: string;
}

/**
 * Throw unless the receipt says the transaction actually succeeded.
 * `description` names the operation for the error message ("Redeem transaction").
 */
export function assertTransactionSucceeded(
  receipt: TransactionStatusLike,
  description: string,
  txHash?: string,
): void {
  if (receipt.status !== "success") {
    throw new Error(
      `execution reverted: ${description}${txHash ? ` ${txHash}` : ""} reverted on-chain — no state change was applied.`,
    );
  }
}
