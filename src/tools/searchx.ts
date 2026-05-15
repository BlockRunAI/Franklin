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
  mode?: 'search' | 'notifications' | 'url';
}

// Detect a tweet permalink the user (or a paste) handed us instead of a
// keyword. Treat twitter.com and x.com interchangeably; trim the tracking
// suffix (?s=20 etc.) and normalise to the canonical x.com host so the
// browser doesn't waste a redirect hop.
const TWEET_URL_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/\s]+\/status\/(\d+)/i;

export function canonicalTweetUrl(input: string): string | null {
  const m = TWEET_URL_RE.exec((input ?? '').trim());
  if (!m) return null;
  return input.trim().replace(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com/i, 'https://x.com')
    .replace(/[?#].*$/, '');
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
// When the user asks "check my @handle mentions/notifications", the tool
// itself routes to x.com/notifications. English-only keyword fast-path;
// the LLM-level classifier handles non-English queries before this point.

const NOTIFICATION_KEYWORDS = [
  'notification', 'notifications',
  'mention', 'mentions', 'mentioned',
  'reply', 'replies',
  'interact', 'interaction', 'interactions',
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

async function readTweetByUrl(rawUrl: string): Promise<CapabilityResult> {
  const url = canonicalTweetUrl(rawUrl) ?? rawUrl;
  let browser;
  try {
    browser = await browserPool.getBrowser();
    try {
      await browser.open(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: `SearchX (url mode): failed to open ${url}: ${msg.slice(0, 200)}`,
        isError: true,
      };
    }
    // Tweet pages are SPAs that lazy-render the article block. A single
    // 4s wait + single snapshot misses content on slow networks or when
    // X briefly shows the auth-wall during hydration even for logged-in
    // sessions. Retry up to 3 times with progressive backoff and a small
    // scroll to nudge the virtual list into rendering.
    let tree = '';
    let articles: ReturnType<typeof extractArticleBlocks> = [];
    const WAIT_MS = [2500, 4000, 5000];
    let attempt = 0;
    while (attempt < WAIT_MS.length) {
      await browser.waitForTimeout(WAIT_MS[attempt]);
      try {
        tree = await browser.snapshot();
      } catch (snapErr) {
        const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
        return {
          output: `SearchX (url mode): snapshot failed (${snapMsg.slice(0, 100)}). The browser session likely closed mid-flight — retry, or ask the user to run \`franklin social setup\` in a separate terminal.`,
          isError: true,
        };
      }
      if (tree.includes('Rate limit') || tree.includes('Something went wrong')) {
        return {
          output: `SearchX: X returned an error page on ${url} (rate limit or server issue). Try again in a minute.`,
          isError: true,
        };
      }
      if (/this post is unavailable|tweet was deleted|page (doesn'?t|does not) exist|account.*suspended/i.test(tree)) {
        return {
          output: `SearchX: tweet at ${url} is unavailable, deleted, or its author is suspended.`,
          isError: true,
        };
      }
      articles = extractArticleBlocks(tree);
      if (articles.length > 0) break;
      // Nudge the page so X mounts the lazy article block.
      try { await browser.scroll(400, 400, 0, 400); } catch { /* ignore */ }
      attempt++;
    }

    const treeLen = tree.length;
    if (articles.length === 0 && tree.includes('Sign in') && tree.includes('Create account')) {
      return {
        output: `SearchX: X is showing a login wall on ${url} after ${WAIT_MS.length} attempts. If you ARE logged in, the cached session may have expired — ask the user to run \`franklin social login x\` in a separate terminal (interactive: opens a Chrome window).`,
        isError: true,
      };
    }
    if (articles.length === 0) {
      return {
        output: `SearchX (url mode): no article extracted from ${url} after ${WAIT_MS.length} attempts. ` +
          `Page rendered ${treeLen} chars. The tweet may load with a non-standard layout — drive the browser ` +
          `directly with BrowserX (action="snapshot" to inspect, action="scroll" to load more, ` +
          `action="open" url=<other> to navigate).\n\n[debug] tree preview:\n${tree.slice(0, 600)}`,
        isError: true,
      };
    }
    const primary = articles[0];
    const texts = findStaticText(primary.text);
    const snippet = texts.join(' ').trim().slice(0, 1200);

    let output = `Tweet at ${url}:\n\n${snippet}\n\n---\n`;
    output += 'IMPORTANT: This is the real post content. ';
    output += 'Do NOT fabricate additional context, replies, or metrics. ';
    output += 'If the user asked for replies/comments, draft them from THIS text only.';
    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `SearchX (url mode) error: ${msg}`, isError: true };
  } finally {
    browserPool.releaseBrowser();
  }
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

  // ── URL fast-path: user pasted a tweet permalink ────────────────────
  // SearchX is the only X-aware tool. If the input is a tweet URL we read
  // the post directly instead of searching for its URL as a keyword (which
  // always returns empty). Triggers on mode="url" OR auto-detected URL.
  const tweetUrl = canonicalTweetUrl(query ?? '');
  if (mode === 'url' || tweetUrl) {
    return await readTweetByUrl(tweetUrl ?? query!);
  }

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
          output: 'Not logged in to X. Ask the user to run `franklin social login x` in a separate terminal (it opens a Chrome window for them to log in and is NOT runnable by you via Bash) first — notifications require authentication.',
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
    // Defensive: snapshot() has historically thrown "Cannot read properties
    // of undefined (reading 'snapshot')" when Playwright's underlying page
    // closes between waitForTimeout and the snapshot call (verified in
    // failures.jsonl 2026-04-20). Convert the cryptic error into a useful
    // hint instead of leaking it into the audit log unchanged.
    let tree: string;
    try {
      tree = await browser.snapshot();
    } catch (snapErr) {
      const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
      return {
        output: `SearchX: Page snapshot failed (${snapMsg.slice(0, 100)}). The browser session likely closed mid-flight — retry, or run \`franklin social setup\` to refresh.`,
        isError: true,
      };
    }

    // ── Diagnose page state ───────────────────────────────────────────
    const isLoginWall = tree.includes('Sign in') && tree.includes('Create account');
    const isRateLimit = tree.includes('Rate limit') || tree.includes('Something went wrong');
    const treeLen = tree.length;

    if (isLoginWall) {
      return {
        output: `SearchX: X is showing a login wall. Ask the user to run \`franklin social login x\` in a separate terminal (interactive — opens a Chrome window they must drive). Do NOT try to run that command from Bash; it will hang and time out.\n\nTree preview (${treeLen} chars):\n${tree.slice(0, 500)}`,
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
      return {
        output: `No candidate posts found for query: "${query}"\n\n` +
          'Tell the user: "No X posts found for this query. Try a different keyword or check back later."\n' +
          'Do NOT use WebSearch or WebFetch as a fallback — they cannot access X.com content.\n' +
          'Do NOT fabricate or invent X post links.\n\n' +
          `[debug] ${diag}`,
      };
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

    // Explicit instructions to prevent model from hallucinating additional posts
    output += '\n\n---\n';
    output += 'IMPORTANT: The posts above are the ONLY real X posts found. ';
    output += 'Present ONLY these posts to the user. Do NOT fabricate additional posts. ';
    output += 'Do NOT use WebSearch or WebFetch to find X posts — they cannot access X.com content. ';
    output += 'If the user wants more, suggest refining the search query.';

    if (!enhanced) {
      output += '\nTip: Run `franklin social setup` to enable product routing, dedup, and auto-replies.';
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
      'The ONLY tool that can access X (Twitter). Returns real posts with URLs. ' +
      'Use mode "search" to find posts by keyword, "notifications" to check mentions/replies, ' +
      'or "url" to read a specific tweet — you can also just pass a tweet URL as the query and ' +
      'this tool will auto-detect URL mode. Call ONCE per topic — do not retry. ' +
      'WebSearch/WebFetch CANNOT access X.com.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query for "search" mode, OR a tweet URL (https://x.com/<user>/status/<id>) for "url" mode — URL is auto-detected if passed in query. Optional for "notifications" mode.' },
        max_results: {
          type: 'number',
          description: 'Max posts to return (default 10, ignored in "url" mode)',
        },
        mode: {
          type: 'string',
          enum: ['search', 'notifications', 'url'],
          description: 'Mode: "search" finds posts by keyword, "notifications" checks your mentions/replies, "url" reads a specific tweet. Default: auto (URL → "url" mode, otherwise "search").',
        },
      },
      required: [],
    },
  },
  execute,
  concurrent: false,
};
