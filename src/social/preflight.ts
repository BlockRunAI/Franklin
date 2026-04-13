/**
 * Pre-flight checks before social tools can run.
 * Validates config readiness and browser login state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, isConfigReady } from './config.js';
import { browserPool } from './browser-pool.js';
import { SOCIAL_PROFILE_DIR } from './browser.js';
import type { SocialBrowser } from './browser.js';

/**
 * Quick cookie check — verify auth_token exists in the profile's Cookies DB.
 * Much faster and more reliable than loading X in a browser and inspecting
 * the accessibility tree for a username string.
 */
function hasSavedAuthCookie(): boolean {
  const cookiesPath = path.join(SOCIAL_PROFILE_DIR, 'Default', 'Cookies');
  if (!fs.existsSync(cookiesPath)) return false;
  try {
    // Read the SQLite file as binary and look for the auth_token cookie.
    // This avoids requiring sqlite3 as a dependency — the cookie name is
    // stored as plain text in the DB file.
    const raw = fs.readFileSync(cookiesPath);
    return raw.includes('auth_token');
  } catch {
    return false;
  }
}

/**
 * Verify that social config is ready and the user is logged in to X.
 * Returns the browser instance on success so callers can reuse it.
 *
 * Login detection order:
 * 1. Check Cookies DB for auth_token (fast, no browser needed)
 * 2. Fallback: open x.com/home and check AX tree for login_detection string
 */
export async function checkSocialReady(): Promise<{
  ready: boolean;
  reason?: string;
  browser?: SocialBrowser;
}> {
  const cfg = loadConfig();
  const configStatus = isConfigReady(cfg);
  if (!configStatus.ready) {
    return { ready: false, reason: configStatus.reason };
  }

  // Fast path: check saved cookies first
  if (!hasSavedAuthCookie()) {
    return { ready: false, reason: 'Not logged in to X (no auth_token cookie). Run: franklin social login x' };
  }

  // Cookies exist — browser login should work. Open browser for caller to use.
  const browser = await browserPool.getBrowser();

  await browser.open('https://x.com/home');
  await browser.waitForTimeout(2500);
  const tree = await browser.snapshot();

  // If login_detection is set, verify it as a secondary check.
  // But don't fail if cookies exist — X may just not show the handle in AX tree.
  if (cfg.x.login_detection && !tree.includes(cfg.x.login_detection)) {
    // Check if we're actually on the home feed (not redirected to login page)
    const isLoginPage = tree.includes('Sign in') && tree.includes('Create account');
    if (isLoginPage) {
      browserPool.releaseBrowser();
      return { ready: false, reason: 'Cookie expired. Run: franklin social login x' };
    }
    // Cookies valid, just handle not found in AX tree — proceed anyway
  }

  return { ready: true, browser };
}
