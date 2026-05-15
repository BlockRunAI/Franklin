/**
 * BrowserX capability — low-level primitives over Franklin's social Chrome
 * profile. Use this when SearchX's pattern matcher is too rigid and the
 * agent needs to drive the browser iteratively: open arbitrary URLs, take
 * fresh snapshots, scroll to load more, screenshot the viewport.
 *
 * Shares the same persistent profile as SearchX/PostToX (~/.blockrun/
 * social-chrome-profile) so the X login session is reused for free.
 *
 * Intentionally OMITS post-side actions (type/press/click on form fields).
 * Replying still goes through PostToX, which has its own confirmation flow.
 * `click` IS exposed because clicking is how you navigate on an SPA — the
 * model is instructed to only click navigation elements (tweet permalinks,
 * profile links, "Show more"), never reply/like/follow buttons.
 */

import path from 'node:path';
import os from 'node:os';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { browserPool } from '../social/browser-pool.js';

type BrowserAction = 'open' | 'snapshot' | 'click' | 'scroll' | 'screenshot' | 'getUrl' | 'wait';

interface BrowserXInput {
  action: BrowserAction;
  url?: string;        // for 'open'
  ref?: string;        // for 'click' (AX ref from last snapshot)
  dy?: number;         // for 'scroll' — vertical delta px (positive = down)
  ms?: number;         // for 'wait' — milliseconds (capped at 15000)
  path?: string;       // for 'screenshot' — output path; defaults to ~/.blockrun/screenshots/<ts>.png
}

const MAX_WAIT_MS = 15_000;

function summariseTree(tree: string, max = 8000): string {
  if (tree.length <= max) return tree;
  return tree.slice(0, max) + `\n\n[…truncated; tree was ${tree.length} chars total]`;
}

async function execute(
  input: Record<string, unknown>,
  _ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const { action, url, ref, dy, ms, path: outPath } = input as unknown as BrowserXInput;

  if (!action) {
    return { output: 'Error: action is required (open|snapshot|click|scroll|screenshot|getUrl|wait)', isError: true };
  }

  let browser;
  try {
    browser = await browserPool.getBrowser();

    switch (action) {
      case 'open': {
        if (!url) return { output: 'Error: open requires url', isError: true };
        try {
          await browser.open(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX open(${url}) failed: ${msg.slice(0, 200)}`, isError: true };
        }
        return { output: `Opened ${url}. Call action="snapshot" next to inspect the page.` };
      }

      case 'snapshot': {
        try {
          const tree = await browser.snapshot();
          const out = `Page snapshot (${tree.length} chars):\n\n${summariseTree(tree)}\n\n` +
            `Refs are valid until the next snapshot. Use action="click" with a ref to navigate.`;
          return { output: out };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX snapshot failed: ${msg.slice(0, 200)}`, isError: true };
        }
      }

      case 'click': {
        if (!ref) return { output: 'Error: click requires ref (from last snapshot)', isError: true };
        try {
          await browser.click(ref);
          // Give the navigation a moment to start, then return — model can
          // call snapshot next to see the result.
          await browser.waitForTimeout(1500);
          const newUrl = await browser.getUrl();
          return { output: `Clicked ref [${ref}]. Current URL: ${newUrl}. Call action="snapshot" to see the result.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX click(${ref}) failed: ${msg.slice(0, 200)}`, isError: true };
        }
      }

      case 'scroll': {
        const delta = Number.isFinite(dy) ? Math.max(-2000, Math.min(2000, Number(dy))) : 600;
        try {
          await browser.scroll(640, 450, 0, delta);
          await browser.waitForTimeout(800);
          return { output: `Scrolled ${delta > 0 ? 'down' : 'up'} ${Math.abs(delta)}px. Call action="snapshot" to see new content.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX scroll failed: ${msg.slice(0, 200)}`, isError: true };
        }
      }

      case 'screenshot': {
        const finalPath = outPath
          ? outPath
          : path.join(os.homedir(), '.blockrun', 'screenshots', `browsex-${Date.now()}.png`);
        try {
          const fs = await import('node:fs');
          fs.mkdirSync(path.dirname(finalPath), { recursive: true });
          await browser.screenshot(finalPath);
          return { output: `Screenshot saved to ${finalPath}. Use the Read tool to view it.` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX screenshot failed: ${msg.slice(0, 200)}`, isError: true };
        }
      }

      case 'getUrl': {
        try {
          const u = await browser.getUrl();
          return { output: `Current URL: ${u}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `BrowserX getUrl failed: ${msg.slice(0, 200)}`, isError: true };
        }
      }

      case 'wait': {
        const waitMs = Number.isFinite(ms) ? Math.min(MAX_WAIT_MS, Math.max(0, Number(ms))) : 2000;
        await browser.waitForTimeout(waitMs);
        return { output: `Waited ${waitMs}ms.` };
      }

      default:
        return { output: `Error: unknown action "${action}" (use open|snapshot|click|scroll|screenshot|getUrl|wait)`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `BrowserX error: ${msg}`, isError: true };
  } finally {
    browserPool.releaseBrowser();
  }
}

export const browserXCapability: CapabilityHandler = {
  spec: {
    name: 'BrowserX',
    description:
      'Drive Franklin\'s social Chrome profile (logged-in to X) iteratively. ' +
      'Use when SearchX returns empty or the page needs scrolling/clicking to surface content. ' +
      'Actions: open(url), snapshot(), click(ref), scroll(dy), screenshot(), getUrl(), wait(ms). ' +
      'Snapshot returns an accessibility tree with [depth-idx] refs you pass to click. ' +
      'Refs reset on every snapshot. SAFE: do NOT use this to like/follow/post — replies go through PostToX with confirmation. ' +
      'Typical flow: open → snapshot → click a permalink → snapshot → read content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'snapshot', 'click', 'scroll', 'screenshot', 'getUrl', 'wait'],
          description: 'open: navigate to a URL. snapshot: capture the page as a ref tree. click: click an element by ref. scroll: scroll vertically by dy px. screenshot: save a PNG. getUrl: return the current URL. wait: pause for ms.',
        },
        url: { type: 'string', description: 'URL for open' },
        ref: { type: 'string', description: 'AX ref (e.g. "2-17") from the last snapshot, for click' },
        dy: { type: 'number', description: 'Vertical scroll delta in px (positive = down). Defaults to 600. Clamped to [-2000, 2000].' },
        ms: { type: 'number', description: 'Milliseconds to wait. Defaults to 2000. Capped at 15000.' },
        path: { type: 'string', description: 'Output path for screenshot. Defaults to ~/.blockrun/screenshots/browsex-<ts>.png.' },
      },
      required: ['action'],
    },
  },
  execute,
  concurrent: false,
};
