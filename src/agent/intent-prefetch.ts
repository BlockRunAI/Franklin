/**
 * Proactive prefetch for live-world questions.
 *
 * Why this exists:
 * When a user asks "what is CRCL trading at?", the agent has TradingMarket
 * in CORE and the system prompt demands it be used. The evaluator catches
 * refusals. The auto-retry loop feeds findings back. All four layers run
 * every turn. It still isn't enough — Sonnet 4.6 (the strongest model we
 * route to) confidently answers "Circle is a private company" from 2022
 * training data, refusing the tool across retries.
 *
 * The lesson: every mechanism above depends on the model *agreeing* to call
 * a tool. When the model is confident-but-wrong about current-world state,
 * it doesn't reach for the tool at all. No prompt tweak will fix this —
 * fine-tuning priors beat prompt priors.
 *
 * Harness-level fix: prefetch the data *before* the model decides. When
 * the user's message contains a ticker or a current-events ask, Franklin's
 * harness spends the $0.001 unprompted, injects the result into context,
 * and then the model answers a question it already has evidence for —
 * not a question its training data has a prior about.
 *
 * This is the pattern Anthropic's harness-design writeup calls out:
 * "Remove components that encode a stale assumption (the model will
 * reach for tools on its own), replace with components that handle the
 * coordination gap (harness fetches, model synthesizes)."
 */

import type { ModelClient } from './llm.js';
import type { Dialogue } from './types.js';
import type { MarketCode } from '../trading/providers/standard-models.js';
import { getStockPrice, getPrice } from '../trading/data.js';

// ─── Intent types ────────────────────────────────────────────────────────

export interface TickerIntent {
  kind: 'ticker';
  /** Raw symbol as the user wrote it; may be company name or ticker. */
  symbol: string;
  /** Resolved market if the classifier was confident; `us` default when `assetClass === 'stock'`. */
  market?: MarketCode;
  /** Asset class — stock prefers paid Gateway path; crypto stays free on CoinGecko. */
  assetClass: 'stock' | 'crypto';
  /** Does the user also want the news / "why did it move"? */
  wantNews: boolean;
}

export type Intent = TickerIntent | null;

export interface PrefetchResult {
  /** Markdown snippet that gets prepended to the user's message for the LLM. */
  contextBlock: string;
  /** User-visible status line ("*Prefetched CRCL ...*"). */
  statusLine: string;
  /** Spend incurred by prefetch. For telemetry + Markets panel display. */
  costUsd: number;
  /** Did any prefetch call actually succeed? If all failed, the caller may
   *  decide to skip injection entirely and let the model try its own way. */
  anyOk: boolean;
}

// ─── Intent source ──────────────────────────────────────────────────────
//
// Historical note: this file used to host its own LLM classifier
// (`classifyIntent` + `parseIntentReply` + a ~40-line STOCK/CRYPTO/NONE
// prompt). Since v3.8.27 the unified `turn-analyzer.ts` produces intent
// as part of a single pre-turn call, and `loop.ts` reads
// `turnAnalysis.intent` directly — the standalone classifier was dead
// code with no remaining callers. Removed in v3.8.29. The TurnIntent
// shape lives in turn-analyzer and is consumed by `prefetchForIntent`
// below.

// ─── Prefetch dispatcher ─────────────────────────────────────────────────

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** Run the prefetch for an intent. Concurrent fan-out for price + news. */
export async function prefetchForIntent(
  intent: Intent,
  client: ModelClient,
): Promise<PrefetchResult | null> {
  if (!intent) return null;

  const tasks: Promise<{ ok: boolean; line: string; cost: number }>[] = [];
  let cost = 0;

  // 1. Price
  if (intent.kind === 'ticker') {
    if (intent.assetClass === 'stock') {
      const market: MarketCode = intent.market || 'us';
      tasks.push(
        getStockPrice(intent.symbol, market).then((r) => {
          if (typeof r === 'string') {
            return { ok: false, line: `- ${intent.symbol} (${market}): lookup failed — ${r.slice(0, 80)}`, cost: 0 };
          }
          return {
            ok: true,
            line: `- ${intent.symbol} (${market}) live price: ${formatUsd(r.price)} (BlockRun Gateway / Pyth)`,
            cost: 0.001,
          };
        }),
      );
    } else {
      // crypto
      tasks.push(
        getPrice(intent.symbol, 'crypto').then((r) => {
          if (typeof r === 'string') {
            return { ok: false, line: `- ${intent.symbol}: lookup failed — ${r.slice(0, 80)}`, cost: 0 };
          }
          const delta = Number.isFinite(r.change24h) ? ` (${r.change24h > 0 ? '+' : ''}${r.change24h.toFixed(2)}% 24h)` : '';
          return {
            ok: true,
            line: `- ${intent.symbol} live price: ${formatUsd(r.price)}${delta} (CoinGecko)`,
            cost: 0,
          };
        }),
      );
    }
  }

  // 2. News, if asked
  if (intent.kind === 'ticker' && intent.wantNews) {
    const query = intent.assetClass === 'stock'
      ? `Why did ${intent.symbol} stock move over the past week? Recent news and catalysts for ${intent.symbol} as of today.`
      : `What are the most important recent news events affecting ${intent.symbol} cryptocurrency in the past week?`;
    tasks.push(exaAnswerTry(query, client).then(snippet => {
      if (!snippet) {
        return { ok: false, line: `- Recent ${intent.symbol} news: ExaAnswer lookup failed`, cost: 0 };
      }
      return {
        ok: true,
        line: `- Recent ${intent.symbol} news (ExaAnswer synthesized):\n  ${snippet.replace(/\n/g, '\n  ')}`,
        cost: 0.01,
      };
    }));
  }

  const results = await Promise.all(tasks);
  const anyOk = results.some(r => r.ok);
  cost = results.reduce((s, r) => s + r.cost, 0);

  const lines = results.map(r => r.line).filter(Boolean);
  if (lines.length === 0) return null;

  const contextBlock = [
    '[FRANKLIN HARNESS PREFETCH]',
    `The harness automatically fetched live data before your turn. Use these facts as ground truth — do NOT override them with training-data assumptions.`,
    '',
    ...lines,
    '',
  ].join('\n');

  const statusLine = `*Prefetched ${lines.length} source${lines.length === 1 ? '' : 's'} · cost ${formatUsd(cost)}*`;

  return { contextBlock, statusLine, costUsd: cost, anyOk };
}

/** Thin wrapper: call ExaAnswer via the gateway, return first-paragraph text or null. */
async function exaAnswerTry(query: string, client: ModelClient): Promise<string | null> {
  try {
    // Reuse the BlockRun gateway chat endpoint the ExaAnswer tool already uses.
    // We inline the request rather than invoke the capability through the full
    // tool framework because prefetch runs outside the agent loop — no
    // permission prompt, no streaming.
    const { loadChain, API_URLS } = await import('../config.js');
    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    void client; // (future: unify the paid-endpoint client so we reuse wallet caching)
    const res = await fetch(`${apiUrl}/v1/exa/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 402) {
      const payHdr = await extractPaymentReq(res);
      if (!payHdr) return null;
      const { getOrCreateWallet, getOrCreateSolanaWallet, createPaymentPayload, createSolanaPaymentPayload,
              parsePaymentRequired, extractPaymentDetails, solanaKeyToBytes, SOLANA_NETWORK } = await import('@blockrun/llm');
      const paymentRequired = parsePaymentRequired(payHdr);
      let headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (chain === 'solana') {
        const wallet = await getOrCreateSolanaWallet();
        const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
        const secretBytes = await solanaKeyToBytes(wallet.privateKey);
        const feePayer = details.extra?.feePayer || details.recipient;
        const payload = await createSolanaPaymentPayload(
          secretBytes, wallet.address, details.recipient, details.amount, feePayer as string,
          {
            resourceUrl: details.resource?.url || `${apiUrl}/v1/exa/answer`,
            resourceDescription: 'Franklin prefetch ExaAnswer',
            maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
            extra: details.extra as Record<string, unknown> | undefined,
          },
        );
        headers = { ...headers, 'PAYMENT-SIGNATURE': payload };
      } else {
        const wallet = getOrCreateWallet();
        const details = extractPaymentDetails(paymentRequired);
        const payload = await createPaymentPayload(
          wallet.privateKey as `0x${string}`, wallet.address, details.recipient, details.amount,
          details.network || 'eip155:8453',
          {
            resourceUrl: details.resource?.url || `${apiUrl}/v1/exa/answer`,
            resourceDescription: 'Franklin prefetch ExaAnswer',
            maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
            extra: details.extra as Record<string, unknown> | undefined,
          },
        );
        headers = { ...headers, 'PAYMENT-SIGNATURE': payload };
      }
      const res2 = await fetch(`${apiUrl}/v1/exa/answer`, {
        method: 'POST', headers, body: JSON.stringify({ query }),
      });
      if (!res2.ok) return null;
      const body = await res2.json() as { data?: { answer?: string } };
      return (body.data?.answer || '').slice(0, 600).trim() || null;
    }
    if (!res.ok) return null;
    const body = await res.json() as { data?: { answer?: string } };
    return (body.data?.answer || '').slice(0, 600).trim() || null;
  } catch {
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* ignore */ }
  }
  return header;
}

// ─── Injection helper ────────────────────────────────────────────────────

/**
 * Augment a user message with the prefetch context block prepended. The
 * final model sees the data as part of the "incoming" user turn — no
 * synthetic tool_use fabrication needed, history stays clean.
 */
export function augmentUserMessage(originalInput: string, prefetch: PrefetchResult): Dialogue {
  return {
    role: 'user',
    content: `${prefetch.contextBlock}\n\nOriginal user message:\n${originalInput}`,
  };
}
