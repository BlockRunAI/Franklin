/**
 * SearchX capability — search X (Twitter) for posts matching a query.
 * Returns candidate posts with snippets, tweet URLs, and product relevance scores.
 *
 * Works in two modes:
 *   - **Basic** (no config): browser-only search, returns snippets + URLs
 *   - **Enhanced** (with social config): adds product routing, dedup, login detection
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
import { loadConfig, isConfigReady } from '../social/config.js';
import { browserPool } from '../social/browser-pool.js';

interface SearchXInput {
  query: string;
  max_results?: number;
  mode?: 'search' | 'notifications';
}

interface Candidate {
  index: number;
  snippet: string;
  timeText: string;
  tweetUrl: string | null;
  preKey: string;
  productMatch: string | null;
  alreadySeen: boolean;
}

// ─── Intent detection (code-level, not LLM-level) ──────────────────────────
// When the user asks "check my @handle mentions/notifications/互动",
// the tool itself routes to x.com/notifications. No LLM judgment needed.

const NOTIFICATION_KEYWORDS = [
  'notification', 'notifications',
  'mention', 'mentions', 'mentioned',
  'reply', 'replies',
  'interact', 'interaction', 'interactions',
  '互动', '通知', '提及', '回复', '看看',
  'check my', 'my account', 'my x',
  'to:', 'from:', '@',
];

export function detectNotificationsIntent(
  query: string | undefined,
  handle: string,
  knownHandles?: string[],
): boolean {
  if (!query) return false;
  const q = query.toLowerCase();

  // Collect all handles the user might reference (personal + org accounts)
  const handles = new Set<string>();
  const addHandle = (h: string) => {
    const clean = h.replace(/^@/, '').toLowerCase().trim();
    if (clean.length >= 3) handles.add(clean);
  };
  addHandle(handle);
  if (knownHandles) knownHandles.forEach(addHandle);

  // Check if query mentions any known handle
  let mentionsOwnHandle = false;
  let matchedHandle = '';
  for (const h of handles) {
    if (q.includes(h)) {
      mentionsOwnHandle = true;
      matchedHandle = h;
      break;
    }
  }

  const hasInteractionKeyword = NOTIFICATION_KEYWORDS.some(kw => q.includes(kw));

  // Route to notifications if: mentions own handle + interaction keyword
  // OR query is literally just the handle (e.g. "blockrunai", "@BlockRunAI")
  if (mentionsOwnHandle && hasInteractionKeyword) return true;
  if (mentionsOwnHandle && q.replace(/[@:]/g, '').trim() === matchedHandle) return true;

  return false;
}

async function execute(
  input: Record<string, unknown>,
  _ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { query, max_results, mode } = input as unknown as SearchXInput;

  if (!query && mode !== 'notifications') {
    return { output: 'Error: query is required (or set mode to "notifications")', isError: true };
  }

  const maxResults = Math.min(Math.max(max_results ?? 10, 1), 50);

  // ── Config: load if available, degrade gracefully if not ────────────
  const config = loadConfig();
  const configStatus = isConfigReady(config);
  const enhanced = configStatus.ready;
  const handle = config.handle || 'unknown';

  // ── Auto-detect notifications intent from query ─────────────────────
  // Skill-level routing: the code decides, not the LLM.
  // If the query mentions any known handle + interaction keywords,
  // or explicitly asks for notifications, route to notifications page.
  // Extract known handles from config: search queries may contain org handles
  // like "BlockRunAI" even if the personal handle is "@bc1beat".
  const knownHandles: string[] = [];
  if (config.x?.search_queries) {
    for (const sq of config.x.search_queries) {
      // Extract @-handles and capitalized brand names from search queries
      const atHandles = sq.match(/@\w+/g);
      if (atHandles) knownHandles.push(...atHandles);
      // Also add single-word brand tokens (like "BlockRunAI")
      const words = sq.split(/\s+/).filter(w => /^[A-Z]/.test(w) && w.length >= 5);
      knownHandles.push(...words);
    }
  }
  const isNotifications = mode === 'notifications' || detectNotificationsIntent(query, handle, knownHandles);

  // In enhanced mode, verify login via preflight
  if (enhanced) {
    const preflight = await checkSocialReady();
    if (!preflight.ready) {
      if (isNotifications) {
        return {
          output: 'Not logged in to X. Run `franklin social login x` first — notifications require authentication.',
          isError: true,
        };
      }
      // Search can sometimes work without login — fall through
    }
  }

  let browser;
  try {
    browser = await browserPool.getBrowser();

    // ── Choose page: notifications vs search ──────────────────────────
    const targetUrl = isNotifications
      ? 'https://x.com/notifications'
      : `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
    try {
      await browser.open(targetUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      browserPool.releaseBrowser();
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        return {
          output: `SearchX: X.com timed out (network issue or blocked). Try again later or check your connection.`,
          isError: true,
        };
      }
      return { output: `SearchX: Failed to open X.com: ${msg.slice(0, 200)}`, isError: true };
    }
    await browser.waitForTimeout(4000);
    const tree = await browser.snapshot();

    // ── Diagnose page state ───────────────────────────────────────────
    const isLoginWall = tree.includes('Sign in') && tree.includes('Create account');
    const isRateLimit = tree.includes('Rate limit') || tree.includes('Something went wrong');
    const treeLen = tree.length;

    if (isLoginWall) {
      return {
        output: `SearchX: X is showing a login wall. Run \`franklin social login x\` to authenticate.\n\nTree preview (${treeLen} chars):\n${tree.slice(0, 500)}`,
        isError: true,
      };
    }
    if (isRateLimit) {
      return {
        output: `SearchX: X returned an error page (rate limit or server issue). Try again in a minute.\n\nTree preview (${treeLen} chars):\n${tree.slice(0, 500)}`,
        isError: true,
      };
    }

    // ── Extract articles ───────────────────────────────────────────────
    const articles = extractArticleBlocks(tree);
    const candidates: Candidate[] = [];

    for (const article of articles) {
      if (candidates.length >= maxResults) break;

      // Extract snippet from static text (first 3 lines)
      const texts = findStaticText(article.text);
      const snippet = texts.slice(0, 3).join(' ').trim();
      if (!snippet || snippet.length < 10) continue;

      // Find time-link ref (permalink to the tweet) — optional
      const timeRefs = findRefs(article.text, 'link', X_TIME_LINK_PATTERN);
      const timeRef = timeRefs[0] ?? null;

      // Fallback: if no time-link, try to find ANY link in the article
      // that looks like a tweet permalink (/username/status/...)
      let tweetUrl: string | null = null;
      let timeText = '';

      if (timeRef) {
        const timeLinkMatch = new RegExp(`\\[${timeRef}\\]\\s+link:\\s*(.+)`).exec(
          article.text,
        );
        timeText = timeLinkMatch ? timeLinkMatch[1].trim() : '';
        try {
          const href = await browser.getHref(timeRef);
          if (href) {
            tweetUrl = href.startsWith('http')
              ? href
              : `https://x.com${href.startsWith('/') ? '' : '/'}${href}`;
          }
        } catch {
          // Non-fatal — we still have the snippet
        }
      } else {
        // No time-link matched — try all links in the article for a permalink
        const allLinks = findRefs(article.text, 'link');
        for (const linkRef of allLinks.slice(0, 5)) {
          try {
            const href = await browser.getHref(linkRef);
            if (href && /\/status\/\d+/.test(href)) {
              tweetUrl = href.startsWith('http')
                ? href
                : `https://x.com${href.startsWith('/') ? '' : '/'}${href}`;
              // Extract time text from this link's label
              const labelMatch = new RegExp(`\\[${linkRef}\\]\\s+link:\\s*(.+)`).exec(
                article.text,
              );
              timeText = labelMatch ? labelMatch[1].trim() : '';
              break;
            }
          } catch { /* try next */ }
        }
      }

      // Dedup (enhanced mode only)
      const preKey = enhanced ? computePreKey({ snippet, time: timeText }) : '';
      const alreadySeen = enhanced ? hasPreKey('x', handle, preKey) : false;

      // Product routing (enhanced mode only)
      const product = enhanced ? detectProduct(snippet, config.products) : null;

      candidates.push({
        index: candidates.length + 1,
        snippet,
        timeText,
        tweetUrl,
        preKey,
        productMatch: product?.name ?? null,
        alreadySeen,
      });
    }

    // ── Format output ──────────────────────────────────────────────────
    if (candidates.length === 0) {
      // Include diagnostic info — show first article block so we can debug the parser
      let diag: string;
      if (articles.length === 0) {
        diag = `No article blocks found in AX tree (${treeLen} chars). Tree preview:\n${tree.slice(0, 800)}`;
      } else {
        const sample = articles[0].text.slice(0, 600);
        diag = `Found ${articles.length} article blocks but extracted 0 candidates.\nFirst article AX dump:\n${sample}`;
      }
      return { output: `No candidate posts found for query: "${query}"\n\n[debug] ${diag}` };
    }

    const lines = candidates.map((c) => {
      const url = c.tweetUrl ? `\n   url: ${c.tweetUrl}` : '';
      if (enhanced) {
        const seen = c.alreadySeen ? ' [SEEN]' : '';
        const product = c.productMatch ? ` | product: ${c.productMatch}` : ' | product: none';
        return (
          `${c.index}. ${c.snippet.slice(0, 200)}${url}\n` +
          `   time: ${c.timeText} | pre_key: ${c.preKey}${product}${seen}`
        );
      }
      // Basic mode: simpler output
      return (
        `${c.index}. ${c.snippet.slice(0, 200)}${url}\n` +
        `   time: ${c.timeText}`
      );
    });

    const header = isNotifications
      ? `X Notifications (${candidates.length} items):`
      : `SearchX results for "${query}" (${candidates.length} candidates):`;
    let output = `${header}\n\n${lines.join('\n\n')}`;

    if (!enhanced) {
      output += '\n\n---\nTip: Run `franklin social setup` to enable product routing, dedup, and auto-replies.';
    }

    return { output };
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
      'Search X (Twitter) for posts, or check notifications for interactions that need replies. ' +
      'Use mode "notifications" to check mentions/replies/interactions. ' +
      'Use mode "search" (default) to search for posts by keyword. ' +
      'Works immediately; social config optional for enhanced features.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (required for search mode, optional for notifications mode)' },
        max_results: {
          type: 'number',
          description: 'Max posts to return (default 10)',
        },
        mode: {
          type: 'string',
          enum: ['search', 'notifications'],
          description: 'Mode: "search" to find posts by keyword, "notifications" to check your mentions/replies/interactions that need response. Default: search',
        },
      },
      required: [],
    },
  },
  execute,
  concurrent: false,
};
