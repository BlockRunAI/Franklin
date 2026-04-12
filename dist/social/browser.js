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
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// ─── Persistent profile location ───────────────────────────────────────────
export const SOCIAL_PROFILE_DIR = path.join(os.homedir(), '.blockrun', 'social-chrome-profile');
function ensureProfileDir() {
    if (!fs.existsSync(SOCIAL_PROFILE_DIR)) {
        fs.mkdirSync(SOCIAL_PROFILE_DIR, { recursive: true });
    }
}
/**
 * Walk an AX tree and produce:
 *   1. A flat text dump with [depth-idx] refs (for regex-based element finding)
 *   2. A map of ref ID → role/name/selector for click-by-ref lookups
 *
 * The flat text shape intentionally mirrors social-bot's `browse snapshot`
 * output so code patterns and regexes are directly portable.
 */
export function serializeAxTree(root) {
    const lines = [];
    const refs = new Map();
    // Counter per-depth so each depth gets sequential indexes
    const depthCounters = [];
    // Counter per (role,name) to disambiguate multiple same-named elements
    const nameOccurrences = new Map();
    function walk(node, depth) {
        if (!node)
            return;
        const role = node.role || '';
        const name = (node.name || '').trim().slice(0, 120);
        // Skip uninteresting nodes — they'd pollute the tree
        const isInteresting = role && role !== 'none' && role !== 'presentation' && role !== 'generic';
        if (isInteresting) {
            while (depthCounters.length <= depth)
                depthCounters.push(0);
            const idx = depthCounters[depth]++;
            const id = `${depth}-${idx}`;
            const labelStr = name || (node.value || '').trim().slice(0, 120);
            const indent = '  '.repeat(depth);
            lines.push(`${indent}[${id}] ${role}: ${labelStr}`);
            // Build a Playwright locator. Prefer getByRole+name, fall back to
            // nth match if there are duplicates.
            const key = `${role}||${labelStr}`;
            const occ = nameOccurrences.get(key) || 0;
            nameOccurrences.set(key, occ + 1);
            let selector;
            if (labelStr) {
                // Escape quotes in the name
                const escaped = labelStr.replace(/"/g, '\\"');
                selector = occ === 0
                    ? `role=${role}[name="${escaped}"]`
                    : `role=${role}[name="${escaped}"] >> nth=${occ}`;
            }
            else {
                selector = `role=${role} >> nth=${idx}`;
            }
            refs.set(id, { id, role, name: labelStr, selector });
        }
        if (node.children) {
            for (const child of node.children) {
                walk(child, isInteresting ? depth + 1 : depth);
            }
        }
    }
    walk(root, 0);
    return { tree: lines.join('\n'), refs };
}
/**
 * Franklin's social browser driver. Lazy-imports playwright-core so the
 * rest of the CLI stays fast to start.
 */
export class SocialBrowser {
    context = null;
    page = null;
    lastRefs = new Map();
    opts;
    constructor(opts = {}) {
        this.opts = {
            headless: opts.headless ?? false,
            channel: opts.channel ?? 'chrome',
            slowMo: opts.slowMo ?? 150,
            viewport: opts.viewport ?? { width: 1280, height: 900 },
        };
    }
    async launch() {
        ensureProfileDir();
        // Lazy import — playwright-core is ~2MB and we don't want to pay the
        // import cost on every franklin command (e.g. `franklin --version`)
        const { chromium } = await import('playwright-core');
        try {
            this.context = await chromium.launchPersistentContext(SOCIAL_PROFILE_DIR, {
                headless: this.opts.headless,
                channel: this.opts.channel,
                slowMo: this.opts.slowMo,
                viewport: this.opts.viewport,
                // Pretend to be a regular Chrome (not headless fingerprint)
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-default-browser-check',
                ],
            });
        }
        catch (err) {
            const msg = err.message;
            if (msg.includes('Executable doesn') || msg.includes("wasn't found")) {
                throw new Error(`Chrome/Chromium not found. Run:\n  franklin social setup\n\n` +
                    `Or install manually:\n  npx playwright install chromium\n\n` +
                    `Original error: ${msg}`);
            }
            throw err;
        }
        // Reuse existing tab if any, else open new
        const existing = this.context.pages();
        this.page = existing.length > 0 ? existing[0] : await this.context.newPage();
    }
    async close() {
        if (this.context) {
            await this.context.close().catch(() => { });
            this.context = null;
            this.page = null;
        }
    }
    // ─── Primitives ────────────────────────────────────────────────────────
    async open(url) {
        this.requirePage();
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    /**
     * Capture the page as a flat [N-M] ref tree (social-bot style).
     * Also stores the ref map internally so click(ref) can find the node.
     */
    async snapshot() {
        this.requirePage();
        // Playwright's accessibility snapshot returns a full AX tree
        const axRoot = await this.page.accessibility.snapshot({ interestingOnly: false });
        if (!axRoot)
            return '';
        const { tree, refs } = serializeAxTree(axRoot);
        this.lastRefs = refs;
        return tree;
    }
    /**
     * Click by ref from the last snapshot. Throws if the ref isn't known.
     * The ref map is reset on every snapshot() call.
     */
    async click(ref) {
        this.requirePage();
        const axRef = this.lastRefs.get(ref);
        if (!axRef) {
            throw new Error(`Unknown ref "${ref}". Refs are only valid until the next snapshot() call. Known refs: ${this.lastRefs.size}`);
        }
        await this.page.locator(axRef.selector).first().click({ timeout: 15000 });
    }
    async clickXY(x, y) {
        this.requirePage();
        await this.page.mouse.click(x, y);
    }
    /**
     * Type text into the currently focused element. Safe against any content
     * in `text` — Playwright passes it as argv, not through a shell.
     */
    async type(text) {
        this.requirePage();
        await this.page.keyboard.type(text, { delay: 20 });
    }
    async press(key) {
        this.requirePage();
        await this.page.keyboard.press(key);
    }
    async scroll(x, y, dx, dy) {
        this.requirePage();
        await this.page.mouse.move(x, y);
        await this.page.mouse.wheel(dx, dy);
    }
    async screenshot(filePath) {
        this.requirePage();
        await this.page.screenshot({ path: filePath, fullPage: false });
    }
    async getUrl() {
        this.requirePage();
        return this.page.url();
    }
    async getTitle() {
        this.requirePage();
        return this.page.title();
    }
    async waitForTimeout(ms) {
        this.requirePage();
        await this.page.waitForTimeout(ms);
    }
    /**
     * Resolve a ref from the last snapshot to its href attribute.
     * Returns the href string, or null if the ref isn't a link or has no href.
     */
    async getHref(ref) {
        this.requirePage();
        const axRef = this.lastRefs.get(ref);
        if (!axRef)
            return null;
        try {
            const el = this.page.locator(axRef.selector).first();
            // Try the element itself, then walk up to find the nearest <a>
            const href = await el.evaluate((node) => {
                const anchor = node.closest('a') || (node.tagName === 'A' ? node : null);
                return anchor ? anchor.href : null;
            });
            return href;
        }
        catch {
            return null;
        }
    }
    /**
     * Block until the user closes the browser tab (used by the login flow).
     * Resolves when the context is closed.
     */
    async waitForClose() {
        this.requirePage();
        await new Promise((resolve) => {
            this.context.on('close', () => resolve());
            this.page.on('close', () => resolve());
        });
    }
    requirePage() {
        if (!this.page)
            throw new Error('SocialBrowser not launched — call launch() first');
    }
}
