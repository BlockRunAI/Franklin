/**
 * Coinbase Onramp link client.
 *
 * Exchanges the user's wallet address for a one-time Coinbase Onramp URL via
 * the BlockRun gateway of the active chain (Base → blockrun.ai, Solana →
 * sol.blockrun.ai). The gateway holds the CDP API key, signs the JWT, and
 * mints a single-use `sessionToken` (Coinbase requires Secure Init since
 * 2025-07-31 — plain appId URLs are deprecated). The returned URL is one-time
 * and expires in ~5 minutes, so it must be minted at click time and never
 * cached.
 *
 * USDC only, on the active chain. The $0 x402 handshake doubles as wallet
 * authentication — postWithPayment signs with the active chain's wallet, and
 * the gateway binds the funding address to that signer. Mirrors the
 * gateway-call pattern in src/phone/client.ts and reuses the shared x402 POST
 * helper.
 */

import { loadChain } from '../config.js';
import { gatewayBase } from '../payments/auth-mode.js';
import { postWithPayment } from '../payments/post-with-payment.js';

export interface OnrampLinkResult {
  /** One-time https://pay.coinbase.com/... URL prefilled for this wallet. */
  url: string;
}

/**
 * Mint a one-time Coinbase Onramp link that funds `address` with USDC on the
 * active chain. Throws if the gateway is unreachable, not configured, or
 * returns no URL.
 */
export async function getOnrampUrl(address: string): Promise<OnrampLinkResult> {
  const chain = loadChain();
  const endpoint = `${gatewayBase()}/v1/onramp/token`;
  const result = await postWithPayment(
    endpoint,
    { address, network: chain, asset: 'USDC' },
    'Mint a Coinbase Onramp session link to fund this wallet',
  );

  if (!result.ok) {
    // A 404 means this gateway has not shipped the onramp route yet (gateway
    // deploys are manual) — name the real situation instead of a bare status.
    if (result.status === 404) {
      throw new Error(`Onramp is not available on the ${chain} gateway yet — try again later.`);
    }
    const msg = typeof result.body.error === 'string'
      ? result.body.error
      : `gateway ${result.status}`;
    throw new Error(msg);
  }

  const url = String(result.body.url ?? '');
  if (!url.startsWith('https://pay.coinbase.com/')) {
    throw new Error('gateway returned no onramp url');
  }
  return { url };
}
