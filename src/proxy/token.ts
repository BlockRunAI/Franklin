/**
 * The local proxy's access token.
 *
 * The proxy signs x402 payments from the user's wallet on every request, so
 * reaching 127.0.0.1:<port> must not be enough to spend: any other account
 * on the machine, or any page on a local dev server, can reach that port.
 * Clients prove they are the user's own by sending this token, which lives
 * in an owner-only file. `franklin init` writes it into Claude Code's
 * settings as ANTHROPIC_AUTH_TOKEN, which Claude Code sends as
 * `Authorization: Bearer <token>`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

export const PROXY_TOKEN_FILE = path.join(BLOCKRUN_DIR, 'proxy-token');

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Read the token, creating it (0600) on first use. Stable across restarts. */
export function getOrCreateProxyToken(file: string = PROXY_TOKEN_FILE): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(existing)) {
      try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
      return existing;
    }
  } catch { /* missing: create below */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

function safeEqual(got: string, want: string): boolean {
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/**
 * True when the request carries the token as `Authorization: Bearer <t>`
 * (ANTHROPIC_AUTH_TOKEN) or `x-api-key: <t>` (ANTHROPIC_API_KEY).
 */
export function hasProxyToken(
  headers: Record<string, string | string[] | undefined>,
  token: string,
): boolean {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const auth = pick(headers['authorization']);
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m && safeEqual(m[1], token)) return true;
  }
  const key = pick(headers['x-api-key']);
  return typeof key === 'string' && safeEqual(key.trim(), token);
}
