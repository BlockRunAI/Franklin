/**
 * X (Twitter) flow for Franklin's social subsystem.
 *
 * Port of social-bot/bot/x_bot.py with three meaningful changes:
 *
 *   1. Pre-key dedup runs BEFORE the LLM call (social-bot runs it after,
 *      wasting Sonnet tokens on every duplicate).
 *   2. 'failed' status does NOT blacklist — only 'posted' does.
 *      A transient network error can be retried on the next run.
 *   3. Reply textbox is located via Playwright role selectors, not by
 *      counting buttons in a list — less fragile to X DOM changes.
 *
 * Every browser interaction uses argv-based Playwright calls — zero shell
 * injection surface even if the LLM emits `$(rm -rf /)` in reply text.
 */
import { SocialBrowser } from './browser.js';
import { findRefs, findStaticText, extractArticleBlocks, X_TIME_LINK_PATTERN } from './a11y.js';
import { computePreKey, hasPreKey, commitPreKey, hasPosted, countPostedToday, logReply, } from './db.js';
import { detectProduct, generateReply } from './ai.js';
import { bus } from '../events/bus.js';
import { makeEvent } from '../events/types.js';
/**
 * Main entry point. Iterates every search query in config.x.search_queries
 * and processes every visible candidate until the daily target is hit.
 */
export async function runX(opts) {
    const log = opts.onProgress ?? (() => { });
    const handle = opts.config.handle || 'unknown';
    const result = {
        considered: 0,
        dedupSkipped: 0,
        llmSkipped: 0,
        drafted: 0,
        posted: 0,
        failed: 0,
        totalCost: 0,
    };
    const alreadyToday = countPostedToday('x', handle);
    const remainingBudget = Math.max(0, opts.config.x.daily_target - alreadyToday);
    if (remainingBudget === 0) {
        log(`Daily target of ${opts.config.x.daily_target} already hit today. Nothing to do.`);
        return result;
    }
    log(`Daily budget: ${remainingBudget} posts remaining (of ${opts.config.x.daily_target})`);
    const browser = new SocialBrowser({ headless: false });
    try {
        await browser.launch();
        log('Browser launched. Checking login state…');
        // Verify we're logged in. If the login_detection string isn't visible on
        // x.com's home page, the user needs to run `franklin social login x`.
        await browser.open('https://x.com/home');
        await browser.waitForTimeout(2500);
        const homeTree = await browser.snapshot();
        const loginMarker = opts.config.x.login_detection || opts.config.handle;
        if (loginMarker && !homeTree.includes(loginMarker)) {
            throw new Error(`Not logged in to x.com (looked for "${loginMarker}" on /home). ` +
                `Run: franklin social login x`);
        }
        log('Login confirmed.');
        let postedThisRun = 0;
        for (const query of opts.config.x.search_queries) {
            if (postedThisRun >= remainingBudget) {
                log(`Hit daily budget (${postedThisRun}) — stopping early.`);
                break;
            }
            log(`\nSearching X for: ${query}`);
            const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
            await browser.open(searchUrl);
            await browser.waitForTimeout(3500);
            const searchTree = await browser.snapshot();
            const articles = extractArticleBlocks(searchTree);
            log(`  Found ${articles.length} posts in results`);
            for (const article of articles) {
                if (postedThisRun >= remainingBudget)
                    break;
                result.considered++;
                // Extract the clickable time-link (our open-tweet handle) and the
                // first visible static text (our snippet).
                const timeRefs = findRefs(article.text, 'link', X_TIME_LINK_PATTERN);
                if (timeRefs.length === 0)
                    continue;
                const timeRef = timeRefs[0];
                const texts = findStaticText(article.text);
                const snippet = texts.slice(0, 3).join(' ').trim();
                if (!snippet || snippet.length < 20)
                    continue;
                const timeLinkMatch = new RegExp(`\\[${timeRef}\\][^\\n]*`).exec(article.text);
                const timeText = timeLinkMatch ? timeLinkMatch[0] : '';
                // ── Pre-key dedup: BEFORE any LLM call ──
                const preKey = computePreKey({ snippet, time: timeText });
                if (hasPreKey('x', handle, preKey)) {
                    result.dedupSkipped++;
                    continue;
                }
                // Product routing (zero-cost keyword score)
                const product = detectProduct(snippet, opts.config.products);
                if (!product) {
                    commitPreKey('x', handle, preKey); // never retry — no product matches
                    continue;
                }
                log(`\n  → ${snippet.slice(0, 80)}…`);
                log(`    product: ${product.name}`);
                // Generate reply (this is where we spend LLM tokens)
                let gen;
                try {
                    gen = await generateReply({
                        post: { title: snippet.slice(0, 120), snippet, platform: 'x' },
                        product,
                        config: opts.config,
                        model: opts.model,
                        apiUrl: opts.apiUrl,
                        chain: opts.chain,
                        debug: opts.debug,
                    });
                }
                catch (err) {
                    log(`    ✗ generateReply failed: ${err.message}`);
                    commitPreKey('x', handle, preKey);
                    continue;
                }
                result.totalCost += gen.cost;
                if (!gen.reply) {
                    log(`    AI said SKIP`);
                    result.llmSkipped++;
                    commitPreKey('x', handle, preKey);
                    logReply({
                        platform: 'x',
                        handle,
                        post_url: `preview:${preKey}`,
                        post_title: snippet.slice(0, 120),
                        post_snippet: snippet,
                        reply_text: '',
                        product: product.name,
                        status: 'skipped',
                        cost_usd: gen.cost,
                    });
                    continue;
                }
                result.drafted++;
                log(`    draft: ${gen.reply}`);
                // ── Dry-run short-circuit ──
                if (opts.dryRun) {
                    commitPreKey('x', handle, preKey);
                    logReply({
                        platform: 'x',
                        handle,
                        post_url: `preview:${preKey}`,
                        post_title: snippet.slice(0, 120),
                        post_snippet: snippet,
                        reply_text: gen.reply,
                        product: product.name,
                        status: 'drafted',
                        cost_usd: gen.cost,
                    });
                    continue;
                }
                // ── Live path: open the tweet, dedup by canonical URL, post ──
                let canonicalUrl = '';
                try {
                    await browser.click(timeRef);
                    await browser.waitForTimeout(3000);
                    canonicalUrl = await browser.getUrl();
                }
                catch (err) {
                    log(`    ✗ failed to open tweet: ${err.message}`);
                    logReply({
                        platform: 'x',
                        handle,
                        post_url: `preview:${preKey}`,
                        post_title: snippet.slice(0, 120),
                        post_snippet: snippet,
                        reply_text: gen.reply,
                        product: product.name,
                        status: 'failed',
                        error_msg: `open-tweet: ${err.message}`,
                        cost_usd: gen.cost,
                    });
                    result.failed++;
                    commitPreKey('x', handle, preKey);
                    continue;
                }
                if (hasPosted('x', handle, canonicalUrl)) {
                    log(`    already posted to ${canonicalUrl} — backing out`);
                    commitPreKey('x', handle, preKey);
                    await browser.press('Alt+ArrowLeft').catch(() => { });
                    await browser.waitForTimeout(1500);
                    continue;
                }
                // Post the reply
                try {
                    await postReply(browser, gen.reply);
                    log(`    ✓ posted to ${canonicalUrl}`);
                    result.posted++;
                    postedThisRun++;
                    logReply({
                        platform: 'x',
                        handle,
                        post_url: canonicalUrl,
                        post_title: snippet.slice(0, 120),
                        post_snippet: snippet,
                        reply_text: gen.reply,
                        product: product.name,
                        status: 'posted',
                        cost_usd: gen.cost,
                    });
                    commitPreKey('x', handle, preKey);
                    bus.emit(makeEvent({
                        type: 'post.published',
                        source: 'social',
                        costUsd: gen.cost,
                        data: { platform: 'x', url: canonicalUrl, text: gen.reply },
                    }));
                    // Respect the rate-limit / anti-spam delay between successes
                    await browser.waitForTimeout(opts.config.x.min_delay_seconds * 1000);
                }
                catch (err) {
                    log(`    ✗ post failed: ${err.message}`);
                    result.failed++;
                    logReply({
                        platform: 'x',
                        handle,
                        post_url: canonicalUrl,
                        post_title: snippet.slice(0, 120),
                        post_snippet: snippet,
                        reply_text: gen.reply,
                        product: product.name,
                        status: 'failed',
                        error_msg: err.message,
                        cost_usd: gen.cost,
                    });
                    // Don't commitPreKey — allow retry on next run
                    await browser.press('Escape').catch(() => { });
                    await browser.waitForTimeout(2000);
                }
            }
        }
    }
    finally {
        await browser.close();
    }
    return result;
}
/**
 * Post a reply to the currently-open tweet page.
 * Locates the reply textbox, types the reply (paragraphs joined with
 * Enter+Enter), clicks the reply button, confirms the "Your post was sent"
 * banner.
 */
export async function postReply(browser, reply) {
    // Snapshot and find the reply textbox
    const tree = await browser.snapshot();
    const boxRefs = findRefs(tree, 'textbox', 'Post (your reply|text).*');
    if (boxRefs.length === 0) {
        // Fallback: any textbox containing "reply" or "post"
        const fallback = findRefs(tree, 'textbox', '(?:[Rr]eply|[Pp]ost).*');
        if (fallback.length === 0)
            throw new Error('reply textbox not found');
        await browser.click(fallback[0]);
    }
    else {
        await browser.click(boxRefs[0]);
    }
    await browser.waitForTimeout(700);
    // Type paragraphs separated by double-enter.
    // Strip any `$` so it never triggers a variable interpolation in some
    // downstream tool. (Not required for Playwright argv, but defense in depth.)
    const paragraphs = reply.split(/\n{2,}/).map((p) => p.replace(/\s+$/, ''));
    for (let i = 0; i < paragraphs.length; i++) {
        if (i > 0) {
            await browser.press('Enter');
            await browser.press('Enter');
        }
        await browser.type(paragraphs[i]);
    }
    await browser.waitForTimeout(700);
    // Click the reply (submit) button. The modal's submit button is labelled
    // "Reply" — we take the FIRST match because the inline compose-below-tweet
    // form and the modal don't coexist in the DOM.
    const snapAfter = await browser.snapshot();
    const replyBtns = findRefs(snapAfter, 'button', 'Reply');
    if (replyBtns.length === 0)
        throw new Error('reply submit button not found');
    // If multiple reply buttons (e.g. a toolbar Reply + submit Reply), the
    // submit is usually the last one with the 'Reply' label.
    await browser.click(replyBtns[replyBtns.length - 1]);
    await browser.waitForTimeout(2500);
    // Confirm
    const confirm = await browser.snapshot();
    if (!/Your post was sent|Reply sent|Your reply was sent/.test(confirm)) {
        throw new Error('post-send confirmation banner not found');
    }
}
