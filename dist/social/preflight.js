/**
 * Pre-flight checks before social tools can run.
 * Validates config readiness and browser login state.
 */
import { loadConfig, isConfigReady } from './config.js';
import { browserPool } from './browser-pool.js';
/**
 * Verify that social config is ready and the user is logged in to X.
 * Returns the browser instance on success so callers can reuse it.
 */
export async function checkSocialReady() {
    const cfg = loadConfig();
    const configStatus = isConfigReady(cfg);
    if (!configStatus.ready) {
        return { ready: false, reason: configStatus.reason };
    }
    const browser = await browserPool.getBrowser();
    await browser.open('https://x.com/home');
    await browser.waitForTimeout(2500);
    const tree = await browser.snapshot();
    if (!tree.includes(cfg.x.login_detection)) {
        browserPool.releaseBrowser();
        return { ready: false, reason: 'Not logged in to X. Run: franklin social login x' };
    }
    return { ready: true, browser };
}
