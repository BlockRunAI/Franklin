/**
 * Shared cache for the user's BlockRun-provisioned phone numbers.
 *
 * Why a cache: `POST /v1/phone/numbers/list` costs $0.001 per call. The
 * panel ticks countdowns once per minute and the terminal status bar
 * re-renders on every prompt cycle — both surfaces hitting the gateway
 * directly would burn pointless micropayments. We hit the gateway only
 * on cache-miss, panel-reload, or after a state-changing call (buy /
 * renew / release).
 *
 * Storage: ~/.blockrun/phone-numbers.json. Read by both the Ink terminal
 * status bar and the web panel, so they always agree on which numbers
 * the wallet owns and how many days remain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, type Chain } from '../config.js';

export interface PhoneNumberRecord {
  phone_number: string;          // E.164 format (leading "+", country code, digits)
  chain: Chain;                  // which chain provisioned it
  expires_at: string;            // ISO date string
  active: boolean;               // computed by gateway: expires_at > now
}

interface CacheFile {
  fetchedAt: number;             // ms epoch
  wallet: string;                // address that owns these numbers
  chain: Chain;                  // chain in use when cached
  numbers: PhoneNumberRecord[];
}

const CACHE_PATH = path.join(BLOCKRUN_DIR, 'phone-numbers.json');

/** 6 hours — long enough to not thrash the gateway, short enough that
 * a number provisioned on another device shows up the same day. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function readCache(): CacheFile | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || !Array.isArray(parsed.numbers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache(data: {
  wallet: string;
  chain: Chain;
  numbers: PhoneNumberRecord[];
}): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    const payload: CacheFile = {
      fetchedAt: Date.now(),
      wallet: data.wallet,
      chain: data.chain,
      numbers: data.numbers,
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2) + '\n', {
      mode: 0o600,
    });
  } catch {
    /* best-effort — cache is an optimization, not a source of truth */
  }
}

export function clearCache(): void {
  try { fs.unlinkSync(CACHE_PATH); } catch { /* not there, fine */ }
}

export function isFresh(cache: CacheFile | null, wallet: string, chain: Chain): boolean {
  if (!cache) return false;
  if (cache.wallet !== wallet) return false;
  if (cache.chain !== chain) return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

/**
 * Compute days-remaining for a number's lease. Negative when expired.
 * UI uses this for the colour ladder (green / amber / red).
 */
export function daysRemaining(expiresAt: string): number {
  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();
  return Math.floor((expiry - now) / (24 * 60 * 60 * 1000));
}
