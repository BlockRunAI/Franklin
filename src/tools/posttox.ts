/**
 * PostToX capability — post a reply to a tweet on X.
 * The agent MUST confirm the reply text with the user before calling this tool.
 * Requires the pre_key from a SearchX result.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { checkSocialReady } from '../social/preflight.js';
import { browserPool } from '../social/browser-pool.js';
import {
  extractArticleBlocks,
  findRefs,
  findStaticText,
  X_TIME_LINK_PATTERN,
} from '../social/a11y.js';
import { computePreKey, commitPreKey, hasPosted, logReply } from '../social/db.js';
import { loadConfig } from '../social/config.js';
import { postReply } from '../social/x.js';
import { bus } from '../events/bus.js';
import { makeEvent } from '../events/types.js';
import type { PostPublishedEvent } from '../events/types.js';

interface PostToXInput {
  pre_key: string;
  reply_text: string;
  search_query: string;
}

async function execute(
  input: Record<string, unknown>,
  _ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { pre_key, reply_text, search_query } = input as unknown as PostToXInput;

  if (!pre_key || !reply_text || !search_query) {
    return {
      output: 'Error: pre_key, reply_text, and search_query are all required',
      isError: true,
    };
  }

  // ── Preflight: config + login ──────────────────────────────────────────
  const preflight = await checkSocialReady();
  if (!preflight.ready) {
    return {
      output: `PostToX not ready: ${preflight.reason}`,
      isError: true,
    };
  }

  const config = loadConfig();
  const handle = config.handle || 'unknown';

  let browser;
  try {
    browser = await browserPool.getBrowser();

    // ── Navigate to search results to re-find the target post ────────
    const searchUrl =
      `https://x.com/search?q=${encodeURIComponent(search_query)}&src=typed_query&f=live`;
    await browser.open(searchUrl);
    await browser.waitForTimeout(3500);
    const tree = await browser.snapshot();

    // ── Find the article matching the given pre_key ──────────────────
    const articles = extractArticleBlocks(tree);
    let matchedTimeRef: string | null = null;

    for (const article of articles) {
      const timeRefs = findRefs(article.text, 'link', X_TIME_LINK_PATTERN);
      if (timeRefs.length === 0) continue;

      const texts = findStaticText(article.text);
      const snippet = texts.slice(0, 3).join(' ').trim();
      if (!snippet) continue;

      const timeLinkMatch = new RegExp(
        `\\[${timeRefs[0]}\\]\\s+link:\\s*(.+)`,
      ).exec(article.text);
      const timeText = timeLinkMatch ? timeLinkMatch[1].trim() : '';

      const candidatePreKey = computePreKey({ snippet, time: timeText });
      if (candidatePreKey === pre_key) {
        matchedTimeRef = timeRefs[0];
        break;
      }
    }

    if (!matchedTimeRef) {
      return {
        output: 'Post not found in current results. It may have scrolled off or been deleted.',
        isError: true,
      };
    }

    // ── Click through to the tweet page ──────────────────────────────
    await browser.click(matchedTimeRef);
    await browser.waitForTimeout(3000);
    const canonicalUrl = await browser.getUrl();

    // ── Check if already posted to this URL ──────────────────────────
    if (hasPosted('x', handle, canonicalUrl)) {
      return {
        output: `Already replied to this post: ${canonicalUrl}`,
        isError: true,
      };
    }

    // ── Post the reply ───────────────────────────────────────────────
    await postReply(browser, reply_text);

    // ── Record success ───────────────────────────────────────────────
    commitPreKey('x', handle, pre_key);
    logReply({
      platform: 'x',
      handle,
      post_url: canonicalUrl,
      post_title: '',
      post_snippet: '',
      reply_text,
      status: 'posted',
    });

    // ── Emit post.published event ────────────────────────────────────
    await bus.emit(
      makeEvent<PostPublishedEvent>({
        type: 'post.published',
        source: 'social',
        data: {
          platform: 'x',
          url: canonicalUrl,
          text: reply_text,
        },
      }),
    );

    return {
      output: `Reply posted successfully to ${canonicalUrl}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `PostToX error: ${msg}`, isError: true };
  } finally {
    browserPool.releaseBrowser();
  }
}

export const postToXCapability: CapabilityHandler = {
  spec: {
    name: 'PostToX',
    description:
      'Post a reply to a tweet on X. The agent MUST confirm the reply text with ' +
      'the user before calling this tool. Requires the pre_key from a SearchX result.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pre_key: {
          type: 'string',
          description: 'preKey of the target post (from SearchX results)',
        },
        reply_text: {
          type: 'string',
          description: 'The reply text to post',
        },
        search_query: {
          type: 'string',
          description: 'The original search query (to re-find the post)',
        },
      },
      required: ['pre_key', 'reply_text', 'search_query'],
    },
  },
  execute,
  concurrent: false,
};
