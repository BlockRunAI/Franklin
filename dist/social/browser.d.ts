/**
 * Native Playwright-core wrapper for Franklin's social subsystem.
 *
 * Mirrors the 9 browser primitives social-bot exposes via its `browse` CLI
 * (open, snapshot, click, type, press, scroll, screenshot, getUrl, close).
 * Persistent context so login state survives across runs:
 *
 *   ~/.blockrun/social-chrome-profile/
 *
 * Unlike social-bot's shell=True subprocess calls, every interaction goes
 * through Playwright's argv-based API — no shell injection surface even if
 * the LLM generates `$(rm -rf /)` as reply text.
 */
export declare const SOCIAL_PROFILE_DIR: string;
/**
 * Ref assigned to every interactive AX node. Format matches social-bot:
 *   [depth-index]
 * e.g. [0-3], [2-17]. Depth is the tree nesting level; index is the
 * order within that level.
 */
export interface AxRef {
    id: string;
    role: string;
    name: string;
    selector: string;
}
interface AxNode {
    role?: string;
    name?: string;
    value?: string;
    description?: string;
    children?: AxNode[];
}
/**
 * Walk an AX tree and produce:
 *   1. A flat text dump with [depth-idx] refs (for regex-based element finding)
 *   2. A map of ref ID → role/name/selector for click-by-ref lookups
 *
 * The flat text shape intentionally mirrors social-bot's `browse snapshot`
 * output so code patterns and regexes are directly portable.
 */
export declare function serializeAxTree(root: AxNode): {
    tree: string;
    refs: Map<string, AxRef>;
};
export interface BrowserOptions {
    headless?: boolean;
    channel?: 'chrome' | 'chromium' | 'msedge';
    slowMo?: number;
    viewport?: {
        width: number;
        height: number;
    };
}
/**
 * Franklin's social browser driver. Lazy-imports playwright-core so the
 * rest of the CLI stays fast to start.
 */
export declare class SocialBrowser {
    private context;
    private page;
    private lastRefs;
    private opts;
    constructor(opts?: BrowserOptions);
    launch(): Promise<void>;
    close(): Promise<void>;
    open(url: string): Promise<void>;
    /**
     * Capture the page as a flat [N-M] ref tree (social-bot style).
     * Also stores the ref map internally so click(ref) can find the node.
     */
    snapshot(): Promise<string>;
    /**
     * Click by ref from the last snapshot. Throws if the ref isn't known.
     * The ref map is reset on every snapshot() call.
     */
    click(ref: string): Promise<void>;
    clickXY(x: number, y: number): Promise<void>;
    /**
     * Type text into the currently focused element. Safe against any content
     * in `text` — Playwright passes it as argv, not through a shell.
     */
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
    screenshot(filePath: string): Promise<void>;
    getUrl(): Promise<string>;
    getTitle(): Promise<string>;
    waitForTimeout(ms: number): Promise<void>;
    /**
     * Resolve a ref from the last snapshot to its href attribute.
     * Returns the href string, or null if the ref isn't a link or has no href.
     */
    getHref(ref: string): Promise<string | null>;
    /**
     * Block until the user closes the browser tab (used by the login flow).
     * Resolves when the context is closed.
     */
    waitForClose(): Promise<void>;
    private requirePage;
}
export {};
