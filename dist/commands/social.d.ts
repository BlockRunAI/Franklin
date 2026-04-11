/**
 * franklin social <action>
 *
 * Native X bot subsystem. No MCP, no plugin SDK, no external CLI deps.
 * Ships as part of the core npm package; only runtime dep is playwright-core,
 * which is lazy-imported so startup stays fast.
 *
 * Actions:
 *   setup     — install chromium via playwright, write default config
 *   login x   — open browser to x.com and wait for user to log in; save state
 *   run       — search X, generate drafts, post (requires --live) or dry-run
 *   stats     — show posted/skipped/drafted counts and total cost
 *   config    — open ~/.blockrun/social-config.json for manual editing
 */
export interface SocialCommandOptions {
    dryRun?: boolean;
    live?: boolean;
    model?: string;
    debug?: boolean;
}
/**
 * Entry point wired from src/index.ts as `franklin social [action] [arg]`.
 */
export declare function socialCommand(action: string | undefined, arg: string | undefined, options: SocialCommandOptions): Promise<void>;
