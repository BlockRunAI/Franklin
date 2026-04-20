/**
 * Exa research capabilities — neural web search, cited Q&A, and batch
 * URL content fetch via the BlockRun `/v1/exa/*` endpoints.
 *
 * Three tools:
 *  - ExaSearch     — semantic search for URLs ($0.01/call)
 *  - ExaAnswer     — synthesized answer with citations ($0.01/call)
 *  - ExaReadUrls   — batch-fetch clean Markdown from URLs ($0.002/URL)
 *
 * Why these matter for an economic agent: ExaAnswer is Perplexity-in-a-
 * tool — the agent gets a grounded reply with sources, avoiding the
 * usual hallucination problem without needing to chain search + fetch
 * + synthesize by hand. ExaReadUrls is roughly 5× cheaper than the
 * Playwright-backed `WebFetch` for batch reading, and returns clean
 * Markdown ready to drop into an LLM context window.
 *
 * All three share the same x402 payment flow (Base or Solana) — a
 * 402 triggers a signed USDC transfer, retry succeeds.
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

const GEN_TIMEOUT_MS = 30_000;

// ─── Shared payment flow ─────────────────────────────────────────────

async function postWithPayment<T>(
  path: string,
  body: unknown,
  ctx: ExecutionScope,
): Promise<T> {
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const endpoint = `${apiUrl}${path}`;
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: bodyStr,
    });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
        body: bodyStr,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Exa ${path} failed (${response.status}): ${errText.slice(0, 200)}`);
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
          resourceDescription: details.resource?.description || 'Franklin Exa research',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
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
        resourceDescription: details.resource?.description || 'Franklin Exa research',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    console.error(`[franklin] Exa payment error: ${(err as Error).message}`);
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

// ─── ExaSearch ───────────────────────────────────────────────────────

interface ExaSearchInput {
  query: string;
  numResults?: number;
  category?: string;
  startPublishedDate?: string;
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

interface ExaSearchResponse {
  data: {
    results: Array<{
      id: string;
      title: string;
      url: string;
      publishedDate?: string;
      score?: number;
    }>;
    costDollars?: { total: number };
  };
}

export const exaSearchCapability: CapabilityHandler = {
  spec: {
    name: 'ExaSearch',
    description:
      'Neural web search via Exa ($0.01/call). Returns a ranked list of ' +
      'URLs + titles for a natural-language query. Understands meaning, ' +
      'not just keywords. Optional `category` narrows to github / news / ' +
      '`research paper` / tweet / pdf / company / etc. Prefer this over ' +
      'WebSearch when the query is semantic (e.g. "projects implementing ' +
      'x402 payment middleware") rather than a literal phrase.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        numResults: { type: 'number', description: 'Max results (default 10, max 100)' },
        category: {
          type: 'string',
          description:
            'Restrict to: github, news, research paper, linkedin profile, ' +
            'personal site, tweet, financial report, pdf, company',
        },
        startPublishedDate: { type: 'string', description: 'ISO 8601 lower bound (e.g. 2026-03-01)' },
        endPublishedDate: { type: 'string', description: 'ISO 8601 upper bound' },
        includeDomains: { type: 'array', items: { type: 'string' } },
        excludeDomains: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as ExaSearchInput;
    if (!params.query) return { output: 'Error: query is required', isError: true };

    try {
      const res = await postWithPayment<ExaSearchResponse>('/v1/exa/search', params, ctx);
      const hits = res.data?.results ?? [];
      if (hits.length === 0) {
        return { output: `No Exa results for "${params.query}".` };
      }
      const lines: string[] = [`## Exa search — ${hits.length} result${hits.length === 1 ? '' : 's'}`];
      for (const h of hits) {
        const date = h.publishedDate ? ` _(${h.publishedDate.slice(0, 10)})_` : '';
        const score = h.score ? ` · score ${h.score.toFixed(2)}` : '';
        lines.push(`\n**${h.title}**${date}${score}\n${h.url}`);
      }
      const cost = res.data?.costDollars?.total;
      if (cost) lines.push(`\n_Cost: $${cost.toFixed(4)}_`);
      return { output: lines.join('\n') };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── ExaAnswer ───────────────────────────────────────────────────────

interface ExaAnswerInput {
  query: string;
}

interface ExaAnswerResponse {
  data: {
    answer: string;
    citations?: Array<{ id: string; title: string; url: string }>;
    costDollars?: { total: number };
  };
}

export const exaAnswerCapability: CapabilityHandler = {
  spec: {
    name: 'ExaAnswer',
    description:
      "Ask a factual question, get a synthesized answer with real source " +
      "citations ($0.01/call). Like Perplexity in a tool — grounded in " +
      "live web content, not LLM memory. Best for 'what is X?', 'how does " +
      "Y work?', 'what's the current state of Z?'. Prefer this over " +
      "chaining ExaSearch + ExaReadUrls + LLM synthesis when the user " +
      "just wants an answer with sources.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The factual question to answer' },
      },
      required: ['query'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as ExaAnswerInput;
    if (!params.query) return { output: 'Error: query is required', isError: true };

    try {
      const res = await postWithPayment<ExaAnswerResponse>('/v1/exa/answer', params, ctx);
      const ans = res.data?.answer ?? '';
      const cites = res.data?.citations ?? [];
      const lines: string[] = [ans];
      if (cites.length > 0) {
        lines.push('\n**Sources**');
        for (const c of cites) lines.push(`- [${c.title}](${c.url})`);
      }
      const cost = res.data?.costDollars?.total;
      if (cost) lines.push(`\n_Cost: $${cost.toFixed(4)}_`);
      return { output: lines.join('\n') };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── ExaReadUrls ─────────────────────────────────────────────────────

interface ExaContentsInput {
  urls: string[];
}

interface ExaContentsResponse {
  data: {
    results: Array<{
      id: string;
      url: string;
      title?: string;
      text: string;
      author?: string | null;
    }>;
    costDollars?: { total: number };
  };
}

export const exaReadUrlsCapability: CapabilityHandler = {
  spec: {
    name: 'ExaReadUrls',
    description:
      "Batch-fetch clean Markdown content from a list of URLs ($0.002/URL). " +
      "Up to 100 URLs per call. Much cheaper than chaining 100× WebFetch, " +
      "and returns text already stripped of HTML/boilerplate — ready to " +
      "feed into an LLM context window. Prefer over WebFetch when reading " +
      "multiple URLs at once or when you want clean Markdown.",
    input_schema: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to fetch (up to 100)',
        },
      },
      required: ['urls'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as ExaContentsInput;
    if (!params.urls || params.urls.length === 0) {
      return { output: 'Error: urls array is required and must be non-empty', isError: true };
    }
    if (params.urls.length > 100) {
      return { output: `Error: max 100 URLs per call (got ${params.urls.length})`, isError: true };
    }

    try {
      const res = await postWithPayment<ExaContentsResponse>('/v1/exa/contents', params, ctx);
      const results = res.data?.results ?? [];
      if (results.length === 0) {
        return { output: `No readable content returned for the ${params.urls.length} URL(s).` };
      }
      const lines: string[] = [`## Fetched ${results.length} URL${results.length === 1 ? '' : 's'}`];
      for (const r of results) {
        lines.push(`\n### ${r.title ?? r.url}\n_Source: ${r.url}_\n\n${r.text}`);
      }
      const cost = res.data?.costDollars?.total;
      if (cost) lines.push(`\n_Cost: $${cost.toFixed(4)}_`);
      return { output: lines.join('\n') };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};
