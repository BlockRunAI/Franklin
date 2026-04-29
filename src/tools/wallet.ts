/**
 * Wallet capability — direct read of Franklin's wallet status.
 *
 * Why this exists as a first-class tool: without it, "what's my balance"
 * routes through Bash (`franklin balance`) plus parsing, which costs both
 * extra tool turns and ~1KB of bash-tool framing in the model's input
 * window every turn. With Wallet as a dedicated zero-arg tool, the agent
 * can answer balance questions in one cheap call. It also preserves the
 * Economic-Agent positioning: the wallet is a first-class concept, not a
 * shell command.
 *
 * Bash is still available for non-trivial wallet operations (sending,
 * signing arbitrary tx) — Wallet is read-only by design.
 */

import { loadChain } from '../config.js';
import type { CapabilityHandler, CapabilityResult } from '../agent/types.js';

export interface WalletReportInput {
  chain: 'base' | 'solana';
  address: string;
  balanceUsd: number;
}

/** Pure formatter — small, deterministic, easy to unit-test. */
export function formatWalletReport(input: WalletReportInput): string {
  return [
    `Chain: ${input.chain}`,
    `Address: ${input.address}`,
    `USDC Balance: $${input.balanceUsd.toFixed(2)}`,
  ].join('\n');
}

async function execute(): Promise<CapabilityResult> {
  const chain = loadChain();
  try {
    if (chain === 'solana') {
      const { setupAgentSolanaWallet } = await import('@blockrun/llm');
      const c = await setupAgentSolanaWallet({ silent: true });
      const address = await c.getWalletAddress();
      const balance = await c.getBalance();
      return { output: formatWalletReport({ chain, address, balanceUsd: balance }) };
    }
    const { setupAgentWallet } = await import('@blockrun/llm');
    const c = setupAgentWallet({ silent: true });
    const address = c.getWalletAddress();
    const balance = await c.getBalance();
    return { output: formatWalletReport({ chain, address, balanceUsd: balance }) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output:
        `Wallet read failed (${msg}). The user may not have run \`franklin setup\` yet, ` +
        `or the chain RPC is temporarily unreachable. Surface this to the user as-is.`,
      isError: true,
    };
  }
}

export const walletCapability: CapabilityHandler = {
  spec: {
    name: 'Wallet',
    description:
      'Read Franklin\'s wallet status — chain, address, and USDC balance. ' +
      'Use this for any "what\'s my balance / how much money / 钱包余额 / wallet status" question. ' +
      'Cheaper and more direct than running `franklin balance` via Bash, and never costs USDC.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  execute,
  concurrent: true,
};
