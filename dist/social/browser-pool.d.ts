/**
 * Singleton browser pool for Franklin's social subsystem.
 * Wraps SocialBrowser with idle-timeout lifecycle management so the
 * browser stays warm across sequential social tool calls but shuts
 * down automatically after 5 minutes of inactivity.
 */
import { SocialBrowser } from './browser.js';
declare class BrowserPool {
    private browser;
    private idleTimer;
    /**
     * Get a ready-to-use browser instance. If one is already running,
     * reset the idle timer and return it. Otherwise launch a new one.
     */
    getBrowser(): Promise<SocialBrowser>;
    /**
     * Signal that the caller is done with the browser for now.
     * Starts (or resets) the idle timer. When it fires the browser
     * is closed automatically.
     */
    releaseBrowser(): void;
    /**
     * Immediately close the browser and clear the idle timer.
     */
    closeBrowser(): Promise<void>;
    private resetIdleTimer;
}
export declare const browserPool: BrowserPool;
export {};
