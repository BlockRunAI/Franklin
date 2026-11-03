/**
 * Where Anthropic-compatible CLI agents (Claude Code) are pointed at the
 * Franklin proxy, and the one-time fix for links written by older releases.
 *
 * The proxy binds 127.0.0.1 only. `localhost` resolves to ::1 first in Node
 * and most clients, and another account on the machine can listen on
 * [::1]:<port> beside our 127.0.0.1:<port> without a bind conflict. A
 * `localhost` base URL would send that listener every prompt, and its
 * replies would reach the agent as model output, tool calls included.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * The auth value `franklin init` wrote before 3.49.23, when the proxy took no
 * token. It still marks an env block as Franklin's for the migration below.
 */
export const PROXY_AUTH_PLACEHOLDER = 'x402-proxy-handles-auth';

export function proxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/api`;
}

/** The settings file now holds the proxy token: owner-only, like the token file. */
export function restrictToOwner(file: string): void {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

const LEGACY_BASE_URL = /^http:\/\/localhost:(\d{1,5})\/api\/?$/;

/**
 * Bring the env block an older `franklin init` wrote up to date: a
 * `localhost` ANTHROPIC_BASE_URL becomes 127.0.0.1, and the placeholder
 * ANTHROPIC_AUTH_TOKEN becomes the proxy's real token. Only touches a block
 * that is Franklin's (placeholder or current token), so a user's own
 * settings are left alone. Returns true when it changed the file.
 */
export function migrateClaudeSettings(token: string, file: string = CLAUDE_SETTINGS_FILE): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    return false; // never rewrite a file we cannot parse
  }
  const env = settings.env as Record<string, unknown> | undefined;
  if (!env) return false;
  const auth = env.ANTHROPIC_AUTH_TOKEN;
  if (auth !== PROXY_AUTH_PLACEHOLDER && auth !== token) return false;
  let changed = false;
  if (auth === PROXY_AUTH_PLACEHOLDER) {
    env.ANTHROPIC_AUTH_TOKEN = token;
    changed = true;
  }
  const current = env.ANTHROPIC_BASE_URL;
  const m = typeof current === 'string' ? LEGACY_BASE_URL.exec(current) : null;
  if (m) {
    env.ANTHROPIC_BASE_URL = proxyBaseUrl(Number(m[1]));
    changed = true;
  }
  if (!changed) return false;
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    restrictToOwner(file);
    return true;
  } catch {
    return false;
  }
}
