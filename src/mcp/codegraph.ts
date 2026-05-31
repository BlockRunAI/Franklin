/**
 * CodeGraph built-in MCP server integration.
 *
 * CodeGraph (https://github.com/colbymchenry/codegraph, MIT) builds a local
 * SQLite knowledge graph of a repo's symbols, call edges, and files via
 * tree-sitter, then serves it over MCP. For Franklin this is a direct USDC win:
 * agents answer "how does X work / what calls Y / trace this flow" from the
 * pre-built index instead of looping grep + read, which cuts tool calls (and
 * therefore paid LLM round-trips) sharply on real codebases.
 *
 * Shipped as a dependency, so `franklin` users get it with no extra install.
 * The npm package is a thin shim (`npm-shim.js`) that locates a per-platform
 * bundle (vendored Node 24 + app) and execs it — so we always launch it via
 * the user's own node against the shim, never a global `codegraph` on PATH.
 *
 * Opt out with FRANKLIN_CODEGRAPH=0 (or "false").
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from './client.js';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

/** True unless the user explicitly disabled CodeGraph via env. */
function userEnabled(): boolean {
  const v = (process.env.FRANKLIN_CODEGRAPH || '').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * Resolve the CodeGraph npm shim entry point, or null if the dependency
 * isn't installed / resolvable. The shim is plain JS runnable by any node.
 */
export function resolveCodegraphShim(): string | null {
  try {
    const shim = require.resolve('@colbymchenry/codegraph/npm-shim.js');
    return fs.existsSync(shim) ? shim : null;
  } catch {
    return null;
  }
}

/** Whether CodeGraph is available and not disabled. */
export function isCodegraphEnabled(): boolean {
  return userEnabled() && resolveCodegraphShim() !== null;
}

/**
 * Build the built-in MCP server config for CodeGraph, pinned to `workDir`.
 *
 * We launch via the user's node + the shim (the shim re-execs the bundled
 * Node 24 runtime internally). `--path` is required because Franklin's MCP
 * client doesn't advertise a `roots` capability, so the server can't infer
 * the project from a rootUri — without it CodeGraph wouldn't know which repo
 * to index. Returns null when CodeGraph is unavailable or disabled.
 */
export function getCodegraphServerConfig(workDir: string): McpServerConfig | null {
  if (!userEnabled()) return null;
  const shim = resolveCodegraphShim();
  if (!shim) return null;
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [shim, 'serve', '--mcp', '--path', workDir],
    label: 'CodeGraph (built-in)',
  };
}

/**
 * Build the initial index for `workDir` if it has no `.codegraph/` yet.
 *
 * Non-blocking: spawns `codegraph init <workDir> -i` detached and returns
 * immediately. The serving MCP process watches the project, so it picks up
 * the freshly built index; until it's ready, codegraph tools report
 * "not initialized" and the agent falls back to grep/read (no regression).
 * No-op when CodeGraph is disabled, unavailable, or already initialized.
 */
export function ensureCodegraphIndex(workDir: string): void {
  if (!isCodegraphEnabled()) return;
  const indexDir = path.join(workDir, '.codegraph');
  if (fs.existsSync(indexDir)) return; // already initialized — watcher keeps it fresh

  const shim = resolveCodegraphShim();
  if (!shim) return;

  try {
    const child = spawn(process.execPath, [shim, 'init', workDir, '-i'], {
      cwd: workDir,
      // Discard output: this is best-effort background indexing. Failures are
      // non-fatal — the agent simply keeps using grep/read until (and if) the
      // index appears. Surfacing a stack trace here would just be noise.
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', (err) => {
      logger.debug(`[franklin] codegraph index build failed: ${err.message}`);
    });
    // Don't keep the event loop alive waiting on the indexer.
    child.unref();
    logger.info(`[franklin] CodeGraph: building initial index for ${workDir}`);
  } catch (err) {
    logger.debug(`[franklin] codegraph index spawn error: ${(err as Error).message}`);
  }
}
