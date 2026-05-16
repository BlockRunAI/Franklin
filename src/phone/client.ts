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

import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import { loadChain, API_URLS, USER_AGENT, type Chain } from '../config.js';
import { writeCache, type PhoneNumberRecord } from './cache.js';

function phoneEndpoint(chain: Chain, path: string): string {
  return `${API_URLS[chain]}/v1/phone/${path}`;
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* not JSON, no header */ }
  }
  return header;
}

async function signPayment(
  response: Response,
  chain: Chain,
  endpoint: string,
  resourceDescription: string,
): Promise<Record<string, string> | null> {
  const paymentHeader = await extractPaymentReq(response);
  if (!paymentHeader) return null;

  if (chain === 'solana') {
    const wallet = await getOrCreateSolanaWallet();
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
    const secretBytes = await solanaKeyToBytes(wallet.privateKey);
    const feePayer = details.extra?.feePayer || details.recipient;
    const payload = await createSolanaPaymentPayload(
      secretBytes,
      wallet.address,
      details.recipient,
      details.amount,
      feePayer as string,
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || resourceDescription,
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } else {
    const wallet = getOrCreateWallet();
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || resourceDescription,
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );
    return { 'PAYMENT-SIGNATURE': payload };
  }
}

interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function postWithPayment(
  endpoint: string,
  body: Record<string, unknown>,
  resourceDescription: string,
  timeoutMs = 30_000,
): Promise<PostResult> {
  const chain = loadChain();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const payload = JSON.stringify(body);
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: payload,
    });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint, resourceDescription);
      if (!paymentHeaders) {
        return { ok: false, status: 402, body: { error: 'payment signing failed' }, raw: '' };
      }
      response = await fetch(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { ...headers, ...paymentHeaders },
        body: payload,
      });
    }

    const raw = await response.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave as {} */ }
    return { ok: response.ok, status: response.status, body: parsed, raw };
  } finally {
    clearTimeout(timer);
  }
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

  return { numbers, count: numbers.length, paid: 0.001 };
}

export interface RenewResult {
  phone_number: string;
  expires_at: string;
  paid: number;
}

export async function renewNumber(phoneNumber: string): Promise<RenewResult> {
  const chain = loadChain();
  const result = await postWithPayment(
    phoneEndpoint(chain, 'numbers/renew'),
    { phoneNumber },
    `Renew BlockRun phone number ${phoneNumber}`,
  );
  if (!result.ok) {
    const message = typeof result.body.error === 'string' ? result.body.error : `gateway ${result.status}`;
    throw new Error(message);
  }
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
