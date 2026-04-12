/**
 * SearchX capability — search X (Twitter) for posts matching a query.
 * Returns candidate posts with snippets and product relevance scores.
 * Requires social config and X login.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { checkSocialReady } from '../social/preflight.js';
import {
  extractArticleBlocks,
  findRefs,
  findStaticText,
  X_TIME_LINK_PATTERN,
} from '../social/a11y.js';
import { computePreKey, hasPreKey } from '../social/db.js';
import { detectProduct } from '../social/ai.js';
import { loadConfig } from '../social/config.js';
import { browserPool } from '../social/browser-pool.js';

interface SearchXInput {
  query: string;
  max_results?: number;
}

interface Candidate {
  index: number;
  snippet: string;
  timeText: string;
  preKey: string;
  productMatch: string | null;
  alreadySeen: boolean;
}

async function execute(
  input: Record<string, unknown>,
  _ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { query, max_results } = input as unknown as SearchXInput;

  if (!query) {
    return { output: 'Error: query is required', isError: true };
  }

  const maxResults = Math.min(Math.max(max_results ?? 10, 1), 50);

  // ── Preflight: config + login ──────────────────────────────────────────
  const preflight = await checkSocialReady();
  if (!preflight.ready) {
    return {
      output: `SearchX not ready: ${preflight.reason}`,
      isError: true,
    };
  }

  const config = loadConfig();
  const handle = config.handle || 'unknown';

  let browser;
  try {
    browser = await browserPool.getBrowser();

    // ── Navigate to X search ───────────────────────────────────────────
    const searchUrl =
      `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    await browser.open(searchUrl);
    await browser.waitForTimeout(3500);
    const tree = await browser.snapshot();

    // ── Extract articles ───────────────────────────────────────────────
    const articles = extractArticleBlocks(tree);
    const candidates: Candidate[] = [];

    for (const article of articles) {
      if (candidates.length >= maxResults) break;

      // Find time-link ref (permalink to the tweet)
      const timeRefs = findRefs(article.text, 'link', X_TIME_LINK_PATTERN);
      if (timeRefs.length === 0) continue;
      const timeRef = timeRefs[0];

      // Extract snippet from static text (first 3 lines)
      const texts = findStaticText(article.text);
      const snippet = texts.slice(0, 3).join(' ').trim();
      if (!snippet || snippet.length < 10) continue;

      // Extract time text from the ref line
      const timeLinkMatch = new RegExp(`\\[${timeRef}\\]\\s+link:\\s*(.+)`).exec(
        article.text,
      );
      const timeText = timeLinkMatch ? timeLinkMatch[1].trim() : '';

      // Compute pre-key for dedup
      const preKey = computePreKey({ snippet, time: timeText });
      const alreadySeen = hasPreKey('x', handle, preKey);

      // Product routing (zero-cost keyword score)
      const product = detectProduct(snippet, config.products);

      candidates.push({
        index: candidates.length + 1,
        snippet,
        timeText,
        preKey,
        productMatch: product?.name ?? null,
        alreadySeen,
      });
    }

    // ── Format output ──────────────────────────────────────────────────
    if (candidates.length === 0) {
      return { output: `No candidate posts found for query: "${query}"` };
    }

    const lines = candidates.map((c) => {
      const seen = c.alreadySeen ? ' [SEEN]' : '';
      const product = c.productMatch ? ` | product: ${c.productMatch}` : ' | product: none';
      return (
        `${c.index}. ${c.snippet.slice(0, 200)}\n` +
        `   time: ${c.timeText} | pre_key: ${c.preKey}${product}${seen}`
      );
    });

    return {
      output:
        `SearchX results for "${query}" (${candidates.length} candidates):\n\n` +
        lines.join('\n\n'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `SearchX error: ${msg}`, isError: true };
  } finally {
    browserPool.releaseBrowser();
  }
}

export const searchXCapability: CapabilityHandler = {
  spec: {
    name: 'SearchX',
    description:
      'Search X (Twitter) for posts matching a query. Returns candidate posts ' +
      'with snippets and product relevance scores. Requires social config and X login.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: {
          type: 'number',
          description: 'Max posts to return (default 10)',
        },
      },
      required: ['query'],
    },
  },
  execute,
  concurrent: false,
};
