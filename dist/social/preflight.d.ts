/**
 * Pre-flight checks before social tools can run.
 * Validates config readiness and browser login state.
 */
import type { SocialBrowser } from './browser.js';
/**
 * Verify that social config is ready and the user is logged in to X.
 * Returns the browser instance on success so callers can reuse it.
 */
export declare function checkSocialReady(): Promise<{
    ready: boolean;
    reason?: string;
    browser?: SocialBrowser;
}>;
