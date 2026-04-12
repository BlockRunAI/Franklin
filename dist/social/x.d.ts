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
import type { SocialConfig } from './config.js';
import type { Chain } from '../config.js';
export interface RunOptions {
    config: SocialConfig;
    model: string;
    apiUrl: string;
    chain: Chain;
    dryRun: boolean;
    debug?: boolean;
    onProgress?: (msg: string) => void;
}
export interface RunResult {
    considered: number;
    dedupSkipped: number;
    llmSkipped: number;
    drafted: number;
    posted: number;
    failed: number;
    totalCost: number;
}
export interface CandidatePost {
    snippetRef: string;
    articleRef: string;
    snippet: string;
    timeText: string;
}
/**
 * Main entry point. Iterates every search query in config.x.search_queries
 * and processes every visible candidate until the daily target is hit.
 */
export declare function runX(opts: RunOptions): Promise<RunResult>;
/**
 * Post a reply to the currently-open tweet page.
 * Locates the reply textbox, types the reply (paragraphs joined with
 * Enter+Enter), clicks the reply button, confirms the "Your post was sent"
 * banner.
 */
export declare function postReply(browser: SocialBrowser, reply: string): Promise<void>;
