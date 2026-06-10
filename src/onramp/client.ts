/**
 * Coinbase Onramp link client.
 *
 * Exchanges the user's Base wallet address for a one-time Coinbase Onramp
 * URL via the BlockRun gateway. The gateway holds the CDP API key, signs the
 * JWT, and mints a single-use `sessionToken` (Coinbase requires Secure Init
 * since 2025-07-31 — plain appId URLs are deprecated). The returned URL is
 * one-time and expires in ~5 minutes, so it must be minted at click time and
 * never cached.
 *
 * Base / USDC only. Mirrors the gateway-call pattern in src/phone/client.ts
 * and reuses the shared x402 POST helper.
 */

import { API_URLS } from '../config.js';
import { postWithPayment } from '../payments/post-with-payment.js';

export interface OnrampLinkResult {
  /** One-time https://pay.coinbase.com/... URL prefilled for this wallet. */
  url: string;
}

/**
 * Mint a one-time Coinbase Onramp link that funds `address` (Base USDC).
 * Throws if the gateway is unreachable, not configured, or returns no URL.
 */
export async function getOnrampUrl(address: string): Promise<OnrampLinkResult> {
  const endpoint = `${API_URLS.base}/v1/onramp/token`;
  const result = await postWithPayment(
    endpoint,
    { address, network: 'base', asset: 'USDC' },
    'Mint a Coinbase Onramp session link to fund this wallet',
  );

  if (!result.ok) {
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
