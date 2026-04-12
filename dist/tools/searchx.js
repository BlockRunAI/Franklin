/**
 * SearchX capability — search X (Twitter) for posts matching a query.
 * Returns candidate posts with snippets, tweet URLs, and product relevance scores.
 *
 * Works in two modes:
 *   - **Basic** (no config): browser-only search, returns snippets + URLs
 *   - **Enhanced** (with social config): adds product routing, dedup, login detection
 */
import { checkSocialReady } from '../social/preflight.js';
import { extractArticleBlocks, findRefs, findStaticText, X_TIME_LINK_PATTERN, } from '../social/a11y.js';
import { computePreKey, hasPreKey } from '../social/db.js';
import { detectProduct } from '../social/ai.js';
import { loadConfig, isConfigReady } from '../social/config.js';
import { browserPool } from '../social/browser-pool.js';
async function execute(input, _ctx) {
    const { query, max_results } = input;
    if (!query) {
        return { output: 'Error: query is required', isError: true };
    }
    const maxResults = Math.min(Math.max(max_results ?? 10, 1), 50);
    // ── Config: load if available, degrade gracefully if not ────────────
    const config = loadConfig();
    const configStatus = isConfigReady(config);
    const enhanced = configStatus.ready;
    const handle = config.handle || 'unknown';
    // In enhanced mode, verify login via preflight
    if (enhanced) {
        const preflight = await checkSocialReady();
        if (!preflight.ready) {
            // Login check failed — fall back to basic mode (search still works without login)
        }
    }
    let browser;
    try {
        browser = await browserPool.getBrowser();
        // ── Navigate to X search ───────────────────────────────────────────
        const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
        await browser.open(searchUrl);
        await browser.waitForTimeout(3500);
        const tree = await browser.snapshot();
        // ── Extract articles ───────────────────────────────────────────────
        const articles = extractArticleBlocks(tree);
        const candidates = [];
        for (const article of articles) {
            if (candidates.length >= maxResults)
                break;
            // Find time-link ref (permalink to the tweet)
            const timeRefs = findRefs(article.text, 'link', X_TIME_LINK_PATTERN);
            if (timeRefs.length === 0)
                continue;
            const timeRef = timeRefs[0];
            // Extract snippet from static text (first 3 lines)
            const texts = findStaticText(article.text);
            const snippet = texts.slice(0, 3).join(' ').trim();
            if (!snippet || snippet.length < 10)
                continue;
            // Extract time text from the ref line
            const timeLinkMatch = new RegExp(`\\[${timeRef}\\]\\s+link:\\s*(.+)`).exec(article.text);
            const timeText = timeLinkMatch ? timeLinkMatch[1].trim() : '';
            // Dedup (enhanced mode only)
            const preKey = enhanced ? computePreKey({ snippet, time: timeText }) : '';
            const alreadySeen = enhanced ? hasPreKey('x', handle, preKey) : false;
            // Resolve the actual tweet permalink URL from the time-link ref
            let tweetUrl = null;
            try {
                const href = await browser.getHref(timeRef);
                if (href) {
                    tweetUrl = href.startsWith('http')
                        ? href
                        : `https://x.com${href.startsWith('/') ? '' : '/'}${href}`;
                }
            }
            catch {
                // Non-fatal — we still have the snippet
            }
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
            return { output: `No candidate posts found for query: "${query}"` };
        }
        const lines = candidates.map((c) => {
            const url = c.tweetUrl ? `\n   url: ${c.tweetUrl}` : '';
            if (enhanced) {
                const seen = c.alreadySeen ? ' [SEEN]' : '';
                const product = c.productMatch ? ` | product: ${c.productMatch}` : ' | product: none';
                return (`${c.index}. ${c.snippet.slice(0, 200)}${url}\n` +
                    `   time: ${c.timeText} | pre_key: ${c.preKey}${product}${seen}`);
            }
            // Basic mode: simpler output
            return (`${c.index}. ${c.snippet.slice(0, 200)}${url}\n` +
                `   time: ${c.timeText}`);
        });
        let output = `SearchX results for "${query}" (${candidates.length} candidates):\n\n` +
            lines.join('\n\n');
        if (!enhanced) {
            output += '\n\n---\nTip: Run `franklin social setup` to enable product routing, dedup, and auto-replies.';
        }
        return { output };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `SearchX error: ${msg}`, isError: true };
    }
    finally {
        browserPool.releaseBrowser();
    }
}
export const searchXCapability = {
    spec: {
        name: 'SearchX',
        description: 'Search X (Twitter) for posts matching a query. Returns candidate posts ' +
            'with snippets and tweet URLs. Works immediately; social config optional for enhanced features.',
        input_schema: {
            type: 'object',
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
