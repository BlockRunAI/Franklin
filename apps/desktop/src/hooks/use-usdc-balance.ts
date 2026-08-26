// USDC balance — local shim over useWallet().
//
// franklin-run reads the *connected browser wallet's* on-chain USDC via wagmi.
// Locally the CLI owns the wallet and already publishes its USDC balance through
// the agent socket (wallet.info / wallet.event), so we just re-expose that here
// in the shape WalletPanel expects.

import { useWallet } from "./use-wallet";

export function useUsdcBalance(): { balance: number | undefined; hasEnough: (usd: number) => boolean } {
  const { wallet } = useWallet();
  const balance = wallet?.balanceUsd;
  const hasEnough = (usd: number) => (balance === undefined ? false : balance >= usd);
  return { balance, hasEnough };
}
