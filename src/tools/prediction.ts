/**
 * PredictionMarket — unified access to Polymarket / Kalshi / cross-platform
 * matching / smart-money endpoints via the BlockRun gateway. Each call
 * settles via x402 against the user's USDC wallet.
 *
 * Powered server-side by Predexon; surfaced to the agent as a single
 * action-dispatched tool so the inventory stays small. Keep one cohesive
 * tool — the way TradingMarket bundles 6 actions — instead of forty
 * one-shot capabilities, otherwise weak models start hallucinating tool
 * names.
 *
 *   searchPolymarket   $0.001  query Polymarket markets (event filter, sort)
 *   searchKalshi       $0.001  query Kalshi markets
 *   crossPlatform      $0.005  matching market pairs across Polymarket+Kalshi
 *                              (the arbitrage / consensus signal)
 *   smartMoney         $0.005  smart-money positioning on one Polymarket
 *                              condition_id (top wallet flow + side bias)
 *
 * Output is filtered + truncated on the way back so a single call never
 * dumps 100 markets into the agent's context. Default 20 rows; agents that
 * need more should narrow the search.
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
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { loadChain, API_URLS, VERSION } from '../config.js';
import { logger } from '../logger.js';

const TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// ─── Shared GET-with-x402 flow ────────────────────────────────────────────

async function getWithPayment<T>(path: string, query: Record<string, string | number | undefined>, ctx: ExecutionScope): Promise<T> {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    qs.set(k, String(v));
  }
  const queryStr = qs.toString();
  const endpoint = `${apiUrl}${path}${queryStr ? `?${queryStr}` : ''}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    let response = await fetch(endpoint, { method: 'GET', signal: controller.signal, headers });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`PredictionMarket ${path} failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
): Promise<Record<string, string> | null> {
  try {
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
          resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
    const wallet = await getOrCreateWallet();
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
        resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] PredictionMarket payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch {
      /* ignore */
    }
  }
  return header;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}

// Both gateways return slightly different shapes; we intentionally use
// loose typing here because we re-shape into our own markdown anyway.
type PolyMarket = {
  question?: string;
  market_slug?: string;
  condition_id?: string;
  volume?: number;
  liquidity?: number;
  end_date?: string;
  outcomes?: string[];
  outcome_prices?: number[];
  status?: string;
};
type KalshiMarket = {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  yes_bid?: number;
  yes_ask?: number;
  volume?: number;
  open_interest?: number;
  status?: string;
  close_time?: string;
};
type MatchedPair = {
  polymarket_condition_id?: string;
  polymarket_question?: string;
  kalshi_ticker?: string;
  kalshi_title?: string;
  similarity?: number;
};
type SmartMoneyResp = {
  buyers?: Array<{ wallet?: string; size?: number; outcome?: string }>;
  sellers?: Array<{ wallet?: string; size?: number; outcome?: string }>;
  net_yes_size?: number;
  net_no_size?: number;
};

// API responses sometimes come wrapped as `{data: [...], pagination: ...}`,
// other times as a bare array. Normalise to an array.
function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.markets)) return obj.markets as T[];
    if (Array.isArray(obj.pairs)) return obj.pairs as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
  }
  return [];
}

// ─── PredictionMarket capability ──────────────────────────────────────────

interface PredictionInput {
  action: 'searchPolymarket' | 'searchKalshi' | 'crossPlatform' | 'smartMoney';
  search?: string;
  status?: string;
  sort?: string;
  limit?: number;
  conditionId?: string;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, search, status, sort, limit, conditionId } = input as unknown as PredictionInput;
  const cappedLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  if (!action) {
    return { output: 'Error: action is required (searchPolymarket | searchKalshi | crossPlatform | smartMoney)', isError: true };
  }

  try {
    switch (action) {
      case 'searchPolymarket': {
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/markets', {
          search,
          status: status ?? 'active',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<PolyMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Polymarket markets matched the filters.' };
        }
        const lines: string[] = [
          `## Polymarket — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            (status ? ` · status=${status}` : '') +
            ` · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          const yesPx = m.outcomes && m.outcome_prices && m.outcomes.length === m.outcome_prices.length
            ? m.outcomes.map((o, j) => `${o}=${formatPct(m.outcome_prices![j])}`).join(' / ')
            : 'n/a';
          const cid = m.condition_id ? ` · condition_id=\`${m.condition_id.slice(0, 14)}…\`` : '';
          lines.push(
            `${i + 1}. **${m.question || m.market_slug || 'untitled'}**${cid}\n` +
            `   prices: ${yesPx} · vol: ${formatUsd(m.volume)} · liq: ${formatUsd(m.liquidity)}` +
            (m.end_date ? ` · ends ${m.end_date.slice(0, 10)}` : '')
          );
        });
        lines.push('', `_$0.001 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'searchKalshi': {
        const raw = await getWithPayment<unknown>('/v1/pm/kalshi/markets', {
          search,
          status: status ?? 'open',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<KalshiMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Kalshi markets matched the filters.' };
        }
        const lines: string[] = [
          `## Kalshi — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            ` · status=${status ?? 'open'} · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          // Kalshi quotes prices in cents (0–100). Surface them as a tight
          // bid/ask so the agent can read implied probability at a glance.
          const bid = m.yes_bid != null ? `${m.yes_bid}¢` : 'n/a';
          const ask = m.yes_ask != null ? `${m.yes_ask}¢` : 'n/a';
          const ticker = m.ticker ? ` · ticker=\`${m.ticker}\`` : '';
          lines.push(
            `${i + 1}. **${m.title || m.ticker || 'untitled'}**${ticker}\n` +
            `   yes ${bid}/${ask} · vol: ${m.volume?.toLocaleString() ?? 'n/a'} · OI: ${m.open_interest?.toLocaleString() ?? 'n/a'}` +
            (m.close_time ? ` · closes ${m.close_time.slice(0, 10)}` : '')
          );
        });
        lines.push('', `_$0.001 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'crossPlatform': {
        const raw = await getWithPayment<unknown>('/v1/pm/matching-markets/pairs', {
          limit: cappedLimit,
        }, ctx);
        const pairs = unwrapList<MatchedPair>(raw);
        if (pairs.length === 0) {
          return { output: 'No matched market pairs available right now.' };
        }
        const lines: string[] = [
          `## Cross-platform matched pairs — ${pairs.length}`,
          '_Polymarket ↔ Kalshi equivalent markets. Use these to compare implied probabilities across venues._',
          '',
        ];
        pairs.forEach((p, i) => {
          const sim = p.similarity != null ? ` · similarity ${formatPct(p.similarity, 0)}` : '';
          lines.push(
            `${i + 1}. **Polymarket:** ${p.polymarket_question || '(untitled)'}\n` +
            `   **Kalshi:** ${p.kalshi_title || '(untitled)'}` +
            (p.kalshi_ticker ? ` · ticker=\`${p.kalshi_ticker}\`` : '') +
            sim
          );
        });
        lines.push('', `_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      case 'smartMoney': {
        if (!conditionId) {
          return { output: 'Error: conditionId is required for smartMoney (Polymarket condition_id from a prior searchPolymarket call)', isError: true };
        }
        const path = `/v1/pm/polymarket/market/${encodeURIComponent(conditionId)}/smart-money`;
        const data = await getWithPayment<SmartMoneyResp>(path, {}, ctx);
        const buyers = (data.buyers ?? []).slice(0, 5);
        const sellers = (data.sellers ?? []).slice(0, 5);
        const lines: string[] = [
          `## Smart money — \`${conditionId.slice(0, 14)}…\``,
        ];
        if (data.net_yes_size != null || data.net_no_size != null) {
          const yesSize = formatUsd(data.net_yes_size);
          const noSize = formatUsd(data.net_no_size);
          lines.push(`**Net flow:** YES ${yesSize} / NO ${noSize}`);
        }
        if (buyers.length > 0) {
          lines.push('', '**Top buyers**');
          buyers.forEach((b, i) => {
            const w = b.wallet ? `${b.wallet.slice(0, 8)}…${b.wallet.slice(-4)}` : 'unknown';
            lines.push(`${i + 1}. ${w} — ${formatUsd(b.size)} on ${b.outcome ?? 'unknown side'}`);
          });
        }
        if (sellers.length > 0) {
          lines.push('', '**Top sellers**');
          sellers.forEach((s, i) => {
            const w = s.wallet ? `${s.wallet.slice(0, 8)}…${s.wallet.slice(-4)}` : 'unknown';
            lines.push(`${i + 1}. ${w} — ${formatUsd(s.size)} on ${s.outcome ?? 'unknown side'}`);
          });
        }
        if (buyers.length === 0 && sellers.length === 0) {
          lines.push('No smart-money flow recorded for this market yet.');
        }
        lines.push('', `_$0.005 paid via x402._`);
        return { output: lines.join('\n') };
      }

      default:
        return {
          output: `Error: unknown action "${action}". Use: searchPolymarket, searchKalshi, crossPlatform, smartMoney`,
          isError: true,
        };
    }
  } catch (err) {
    return { output: `Error: ${(err as Error).message}`, isError: true };
  }
}

export const predictionMarketCapability: CapabilityHandler = {
  spec: {
    name: 'PredictionMarket',
    description:
      'Real prediction market data via the BlockRun gateway (powered by Predexon). Use for any "what are the odds of X" / "Polymarket on Y" / "Kalshi market for Z" question. ' +
      'Actions: ' +
      '`searchPolymarket` (search Polymarket markets — $0.001), ' +
      '`searchKalshi` (search Kalshi markets — $0.001), ' +
      '`crossPlatform` (matched pairs across Polymarket+Kalshi for arbitrage / consensus — $0.005), ' +
      '`smartMoney` (smart-money positioning on a Polymarket condition_id — $0.005). ' +
      'Polymarket and Kalshi are the two largest legit prediction markets; cross-platform matching is unique to BlockRun. ' +
      'For "should I bet on X" / "what does the market price imply": run searchPolymarket AND searchKalshi in parallel and compare implied probabilities — divergence is the signal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['searchPolymarket', 'searchKalshi', 'crossPlatform', 'smartMoney'],
          description: 'Which prediction-market query to run. See tool description for cost per action.',
        },
        search: {
          type: 'string',
          description: 'Search query (3-100 chars). Used by searchPolymarket / searchKalshi. Skip for crossPlatform/smartMoney.',
        },
        status: {
          type: 'string',
          description: 'Polymarket: active | closed | archived (default active). Kalshi: open | closed (default open).',
        },
        sort: {
          type: 'string',
          description: 'Polymarket: volume | liquidity | created (default volume). Kalshi: volume | open_interest | price_desc | price_asc | close_time (default volume).',
        },
        limit: {
          type: 'number',
          description: `Max results (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
        },
        conditionId: {
          type: 'string',
          description: 'Polymarket condition_id. Required for smartMoney. Get one from a prior searchPolymarket call.',
        },
      },
      required: ['action'],
    },
  },
  execute,
  concurrent: true,
};
