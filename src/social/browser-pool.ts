/**
 * Singleton browser pool for Franklin's social subsystem.
 * Wraps SocialBrowser with idle-timeout lifecycle management so the
 * browser stays warm across sequential social tool calls but shuts
 * down automatically after 5 minutes of inactivity.
 */

import { SocialBrowser } from './browser.js';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

class BrowserPool {
  private browser: SocialBrowser | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Get a ready-to-use browser instance. If one is already running,
   * reset the idle timer and return it. Otherwise launch a new one.
   */
  async getBrowser(): Promise<SocialBrowser> {
    if (this.browser) {
      this.resetIdleTimer();
      return this.browser;
    }

    const browser = new SocialBrowser({ headless: false });
    await browser.launch();
    this.browser = browser;
    this.resetIdleTimer();
    return this.browser;
  }

  /**
   * Signal that the caller is done with the browser for now.
   * Starts (or resets) the idle timer. When it fires the browser
   * is closed automatically.
   */
  releaseBrowser(): void {
    this.resetIdleTimer();
  }

  /**
   * Immediately close the browser and clear the idle timer.
   */
  async closeBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(async () => {
      await this.closeBrowser();
    }, IDLE_TIMEOUT);
  }
}

export const browserPool = new BrowserPool();
