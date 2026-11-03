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

/** The auth token `franklin init` writes; marks the env block as ours. */
export const PROXY_AUTH_PLACEHOLDER = 'x402-proxy-handles-auth';

export function proxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/api`;
}

const LEGACY_BASE_URL = /^http:\/\/localhost:(\d{1,5})\/api\/?$/;

/**
 * Rewrite a `localhost` ANTHROPIC_BASE_URL written by `franklin init` to
 * 127.0.0.1. Only touches an env block that is Franklin's (our placeholder
 * auth token) and a URL in exactly the form init wrote, so a user's own
 * settings are left alone. Returns true when it changed the file.
 */
export function migrateClaudeSettingsBaseUrl(file: string = CLAUDE_SETTINGS_FILE): boolean {
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
  if (!env || env.ANTHROPIC_AUTH_TOKEN !== PROXY_AUTH_PLACEHOLDER) return false;
  const current = env.ANTHROPIC_BASE_URL;
  if (typeof current !== 'string') return false;
  const m = LEGACY_BASE_URL.exec(current);
  if (!m) return false;
  env.ANTHROPIC_BASE_URL = proxyBaseUrl(Number(m[1]));
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    return true;
  } catch {
    return false;
  }
}
