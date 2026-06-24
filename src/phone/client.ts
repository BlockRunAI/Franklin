/**
 * BlockRun phone API client.
 *
 * Thin wrapper over `/v1/phone/numbers/{list,buy,renew,release}` that
 * handles the x402 payment handshake using the wallet Franklin already
 * loads at startup. Pattern mirrors `src/tools/modal.ts` — first POST
 * returns 402 with payment requirements, we sign with the local wallet,
 * retry once with X-PAYMENT.
 *
 * Used by:
 *   - panel server (renew button, buy flow, refresh button)
 *   - phone cache refresh (background)
 *   - future Phone/Call tools surfaced to the agent
 */

import { API_URLS, loadChain, type Chain } from '../config.js';
import { postWithPayment } from '../payments/post-with-payment.js';
import { recordUsage } from '../stats/tracker.js';
import { writeCache, type PhoneNumberRecord } from './cache.js';

function phoneEndpoint(chain: Chain, path: string): string {
  return `${API_URLS[chain]}/v1/phone/${path}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface ListNumbersResult {
  numbers: PhoneNumberRecord[];
  count: number;
  /** $0.001 was paid for this list call. UI can show it. */
  paid: number;
}

/**
 * Fetch the wallet's owned numbers from BlockRun. Refreshes the local
 * cache on success so the terminal status bar picks up the same data.
 */
export async function listNumbers(opts: { walletAddress: string }): Promise<ListNumbersResult> {
  const chain = loadChain();
  const startedAt = Date.now();
  const result = await postWithPayment(
    phoneEndpoint(chain, 'numbers/list'),
    {},
    'List wallet-owned BlockRun phone numbers',
  );

  if (!result.ok) {
    const message = typeof result.body.error === 'string' ? result.body.error : `gateway ${result.status}`;
    throw new Error(message);
  }

  const numbers = Array.isArray(result.body.numbers)
    ? (result.body.numbers as PhoneNumberRecord[])
    : [];

  writeCache({ wallet: opts.walletAddress, chain, numbers });

  // Record the $0.001 x402 spend so panel/background list calls land in
  // franklin stats — same label the agent's ListPhoneNumbers tool uses so the
  // two aggregate (panel-initiated spend was previously dropped entirely).
  try { recordUsage('ListPhoneNumbers', 0, 0, 0.001, Date.now() - startedAt); } catch { /* best-effort */ }

  return { numbers, count: numbers.length, paid: 0.001 };
}

export interface RenewResult {
  phone_number: string;
  expires_at: string;
  paid: number;
}

export async function renewNumber(phoneNumber: string): Promise<RenewResult> {
  const chain = loadChain();
  const startedAt = Date.now();
  const result = await postWithPayment(
    phoneEndpoint(chain, 'numbers/renew'),
    { phoneNumber },
    `Renew BlockRun phone number ${phoneNumber}`,
  );
  if (!result.ok) {
    const message = typeof result.body.error === 'string' ? result.body.error : `gateway ${result.status}`;
    throw new Error(message);
  }
  // Record the $5 x402 spend (parity with the agent's RenewPhoneNumber tool).
  try { recordUsage('RenewPhoneNumber', 0, 0, 5.0, Date.now() - startedAt); } catch { /* best-effort */ }
  return {
    phone_number: String(result.body.phone_number ?? phoneNumber),
    expires_at: String(result.body.expires_at ?? ''),
    paid: 5.0,
  };
}

export interface BuyResult {
  phone_number: string;
  expires_at: string;
  chain: Chain;
  paid: number;
}

export async function buyNumber(opts: {
  country?: string;
  areaCode?: string;
}): Promise<BuyResult> {
  const chain = loadChain();
  const startedAt = Date.now();
  const body: Record<string, unknown> = { country: opts.country || 'US' };
  if (opts.areaCode) body.areaCode = opts.areaCode;
  const result = await postWithPayment(
    phoneEndpoint(chain, 'numbers/buy'),
    body,
    `Provision a new BlockRun phone number (${opts.country || 'US'})`,
  );
  if (!result.ok) {
    const message = typeof result.body.error === 'string' ? result.body.error : `gateway ${result.status}`;
    throw new Error(message);
  }
  // Record the $5 x402 spend (parity with the agent's BuyPhoneNumber tool) so a
  // panel-initiated buy is no longer invisible to franklin stats / the ledger.
  try { recordUsage('BuyPhoneNumber', 0, 0, 5.0, Date.now() - startedAt); } catch { /* best-effort */ }
  return {
    phone_number: String(result.body.phone_number ?? ''),
    expires_at: String(result.body.expires_at ?? ''),
    chain: (result.body.chain as Chain) || chain,
    paid: 5.0,
  };
}

export interface ReleaseResult {
  released: boolean;
  phone_number: string;
}

export async function releaseNumber(phoneNumber: string): Promise<ReleaseResult> {
  const chain = loadChain();
  const result = await postWithPayment(
    phoneEndpoint(chain, 'numbers/release'),
    { phoneNumber },
    `Release BlockRun phone number ${phoneNumber}`,
  );
  if (!result.ok) {
    const message = typeof result.body.error === 'string' ? result.body.error : `gateway ${result.status}`;
    throw new Error(message);
  }
  return {
    released: Boolean(result.body.released),
    phone_number: String(result.body.phone_number ?? phoneNumber),
  };
}
