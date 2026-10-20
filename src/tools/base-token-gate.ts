/**
 * BaseTokenGate — read-only pre-trade safety check for a Base ERC-20.
 *
 * Calls Grey Ridge's x402 endpoint GET /gate/swap (honeypot/sellability
 * simulation + admin-control checks + Uniswap v3 liquidity vs. trade size)
 * and returns a one-word GO / HOLD / BLOCK decision with a reason. Meant to
 * be called BEFORE Base0xQuote / a swap into a token that is not in the
 * built-in symbol list.
 *
 *   - Price: $0.008 USDC per call, paid with the local Base wallet through the
 *     same x402 handshake the other paid tools use. No key, no account.
 *   - Free sample: /gate/swap/preview?token=usdc|weth|cbbtc|aero|degen
 *   - Fail-open on transport errors (the tool reports "unchecked", it never
 *     blocks a trade by itself); the model decides what to do with the result.
 */

import {
  getOrCreateWallet,
  createPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
} from '@blockrun/llm';
import type { CapabilityHandler, ExecutionScope } from '../agent/types.js';
import { loadChain, VERSION } from '../config.js';
import { gatewayHeaders, walletMayPay } from '../payments/auth-mode.js';
import { frameUntrusted } from './untrusted.js';
import { recordUsage } from '../stats/tracker.js';

const GATE_BASE = process.env.FRANKLIN_TOKEN_GATE_URL || 'https://x402-data-api.sigrunner.workers.dev';
const GATE_PRICE_USD = 0.008;
const GATE_TIMEOUT_MS = 20_000;

interface GateInput {
  token: string;
  side?: 'buy' | 'sell';
  notional_usd?: number;
}

interface GateResult {
  decision?: 'go' | 'hold' | 'block';
  reason?: string;
  verdict?: string;
  risk_score?: number;
  liquidity_usd?: number | null;
  impact_pct_of_pool?: number | null;
  flags?: string[];
  token_meta?: { symbol?: string; name?: string };
}

async function paymentHeader(res: Response): Promise<string | null> {
  const h = res.headers.get('payment-required');
  if (h) return h;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (body.x402 || body.accepts) return btoa(JSON.stringify(body));
  } catch { /* not JSON */ }
  return null;
}

async function executeGate(
  input: GateInput,
  ctx: ExecutionScope,
): Promise<{ output: string; isError?: boolean }> {
  const token = (input.token || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return { output: 'token must be a Base ERC-20 address (0x + 40 hex chars).', isError: true };
  }
  if (loadChain() === 'solana') {
    return { output: 'BaseTokenGate needs the Base chain (current chain is Solana).', isError: true };
  }
  const qs = new URLSearchParams({
    token,
    side: input.side === 'sell' ? 'sell' : 'buy',
    notional_usd: String(input.notional_usd ?? 100),
  });
  const endpoint = `${GATE_BASE}/gate/swap?${qs}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  const start = Date.now();
  try {
    const headers = { 'User-Agent': `franklin/${VERSION}` };
    let res = await fetch(endpoint, { signal: ctrl.signal, headers });
    let paid = false;
    if (res.status === 402 && walletMayPay(gatewayHeaders())) {
      const ph = await paymentHeader(res);
      if (!ph) return { output: `Token gate unchecked: 402 without payment requirements.`, isError: true };
      const wallet = getOrCreateWallet();
      const details = extractPaymentDetails(parsePaymentRequired(ph));
      const payload = await createPaymentPayload(
        wallet.privateKey as `0x${string}`,
        wallet.address,
        details.recipient,
        details.amount,
        details.network || 'eip155:8453',
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'Base token pre-trade gate',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      res = await fetch(endpoint, { signal: ctrl.signal, headers: { ...headers, 'PAYMENT-SIGNATURE': payload } });
      paid = res.ok;
    }
    if (!res.ok) {
      return { output: `Token gate unchecked: HTTP ${res.status}. Treat the token as unverified.`, isError: true };
    }
    const r = (await res.json()) as GateResult;
    if (paid) {
      try { recordUsage('BaseTokenGate', 0, 0, GATE_PRICE_USD, Date.now() - start, false, false); } catch { /* best-effort */ }
    }
    const sym = r.token_meta?.symbol ? ` (${r.token_meta.symbol})` : '';
    const lines = [
      `Decision: ${(r.decision || 'unknown').toUpperCase()} — ${r.reason || 'no reason given'}`,
      `Token: ${token}${sym}  verdict=${r.verdict ?? '?'}  risk_score=${r.risk_score ?? '?'}`,
      `Liquidity: ${r.liquidity_usd != null ? '$' + Math.round(r.liquidity_usd) : 'n/a'}  impact=${r.impact_pct_of_pool ?? 'n/a'}% of pool`,
      r.flags?.length ? `Flags: ${r.flags.join('; ')}` : '',
      'Heuristic risk signal, not a guarantee. BLOCK/HOLD means do not buy without explicit user confirmation.',
    ].filter(Boolean);
    return { output: frameUntrusted('BaseTokenGate', lines.join('\n')) };
  } catch (err) {
    return { output: `Token gate unchecked: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

export const baseTokenGateCapability: CapabilityHandler = {
  spec: {
    name: 'BaseTokenGate',
    description:
      'Pre-trade safety gate for a Base ERC-20 that is NOT a well-known symbol (honeypot/sellability simulation, admin controls, liquidity vs. trade size). Returns GO / HOLD / BLOCK with a reason. $0.008 USDC per call from the Base wallet. Call before Base0xQuote when the buy token is an arbitrary address.',
    input_schema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: { type: 'string', description: 'Base ERC-20 contract address (0x...).' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Trade direction (default buy).' },
        notional_usd: { type: 'number', description: 'Intended trade size in USD, for the price-impact check (default 100).' },
      },
    },
  },
  execute: async (input: unknown, ctx: ExecutionScope) => executeGate(input as GateInput, ctx),
  concurrent: true,
};
