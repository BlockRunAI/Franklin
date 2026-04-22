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

// ─── Classifier ──────────────────────────────────────────────────────────

// llama-4-maverick: same rationale as the router classifier — emits plain
// text under tight max_tokens rather than routing through thinking blocks.
const CLASSIFIER_MODEL = process.env.FRANKLIN_PREFETCH_MODEL || 'nvidia/llama-4-maverick';
const CLASSIFIER_TIMEOUT_MS = 2_500;

const CLASSIFIER_PROMPT = `You extract PREFETCH INTENT from a user message for a CLI agent that has live market-data tools.

Your job: decide whether Franklin should fetch live data BEFORE the main model answers, so the answer is grounded in real data instead of model memory.

Output one of:

1. STOCK <TICKER> <MARKET> <NEWS>
   When the user asks about a specific publicly-traded equity — by ticker (CRCL, AAPL, NVDA, 7203, 0005) or by company name that maps to one (Circle → CRCL, Apple → AAPL, Toyota → 7203, HSBC → 0005).
   MARKET: us | hk | jp | kr | gb | de | fr | nl | ie | lu | cn | ca
   NEWS: yes if the user also asks "why / what happened / analysis"; no otherwise.
   Default market: us.

2. CRYPTO <SYMBOL> <NEWS>
   When the user asks about a cryptocurrency by symbol or name (BTC, ETH, Bitcoin, Ethereum, SOL, Solana).
   NEWS: yes if asks why / recent news.

3. NONE
   Any other message: greetings, coding questions, general chat, questions about non-traded entities.

Rules:
- If the company could be either public or private and you're unsure, assume PUBLIC and emit STOCK with your best ticker guess. The tool will 404 gracefully if wrong.
- One output line only. No explanation. No punctuation beyond what's shown.
- Ticker in UPPERCASE.

Examples:
User: 帮我看看 CRCL 股票                → STOCK CRCL us no
User: should I sell Circle stock?      → STOCK CRCL us no
User: why did CRCL drop this week      → STOCK CRCL us yes
User: BTC 现在价格                       → CRYPTO BTC no
User: 为什么以太坊跌了                   → CRYPTO ETH yes
User: Toyota 股价                        → STOCK 7203 jp no
User: hi how are you                   → NONE
User: fix the bug in foo.ts            → NONE

Answer with just the one-line directive.`;

/** Parse the classifier's one-line reply. Very strict — any junk → null. */
export function parseIntentReply(reply: string): Intent {
  const line = reply.trim().split('\n')[0].trim().toUpperCase();
  if (!line || line.startsWith('NONE')) return null;

  const stockMatch = line.match(/^STOCK\s+([A-Z0-9.\-]+)\s+([A-Z]{2})\s+(YES|NO)\b/);
  if (stockMatch) {
    const market = stockMatch[2].toLowerCase();
    const validMarkets: readonly string[] = ['us', 'hk', 'jp', 'kr', 'gb', 'de', 'fr', 'nl', 'ie', 'lu', 'cn', 'ca'];
    if (!validMarkets.includes(market)) return null;
    return {
      kind: 'ticker',
      symbol: stockMatch[1],
      market: market as MarketCode,
      assetClass: 'stock',
      wantNews: stockMatch[3] === 'YES',
    };
  }

  const cryptoMatch = line.match(/^CRYPTO\s+([A-Z0-9.\-]+)\s+(YES|NO)\b/);
  if (cryptoMatch) {
    return {
      kind: 'ticker',
      symbol: cryptoMatch[1],
      assetClass: 'crypto',
      wantNews: cryptoMatch[2] === 'YES',
    };
  }

  return null;
}

export async function classifyIntent(userInput: string, client: ModelClient): Promise<Intent> {
  if (process.env.FRANKLIN_NO_PREFETCH === '1') return null;
  const trimmed = userInput.trim();
  // Only the cheapest gate — skip very short inputs that can't be a real
  // market question ("hi", "ok", "thanks"). 6 chars covers those while
  // still letting short-form Chinese / ticker prompts through, e.g.
  // "BTC 价格" (6), "CRCL 多少" (7). Longer prompts all route to the LLM
  // classifier, which decides NONE cheaply when not market-related.
  if (trimmed.length < 6) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const result = await client.complete(
      {
        model: CLASSIFIER_MODEL,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: 'user', content: trimmed.slice(0, 800) }],
        tools: [],
        max_tokens: 24,
      },
      ctrl.signal,
    );
    let raw = '';
    for (const part of result.content) {
      if (typeof part === 'object' && part.type === 'text' && part.text) raw += part.text;
    }
    return parseIntentReply(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
