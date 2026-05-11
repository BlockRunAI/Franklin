/**
 * Update-check utility.
 *
 * Quietly pings npm once per day, caches the latest published version in
 * `~/.blockrun/version-check.json`, and exposes a sync helper the CLI
 * uses to nudge users when they're behind. The check is non-blocking:
 * fire-and-forget at startup, render the notice on the *next* run if the
 * network was slow the first time. Users never wait on it.
 *
 * Respects two opt-outs:
 *   - `FRANKLIN_NO_UPDATE_CHECK=1` — explicit user preference
 *   - CI-like environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, etc.)
 *
 * Cache format is intentionally small and forward-compatible: new fields
 * may be added, old fields are tolerated on read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, VERSION, USER_AGENT } from './config.js';

const CACHE_FILE = path.join(BLOCKRUN_DIR, 'version-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 2_000;
const REGISTRY_URL = 'https://registry.npmjs.org/@blockrun/franklin/latest';

interface CacheShape {
  latestVersion: string;
  checkedAt: number;
}

function isDisabled(): boolean {
  if (process.env.FRANKLIN_NO_UPDATE_CHECK === '1') return true;
  // Common CI signals — no point nagging headless runners.
  return Boolean(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.BUILDKITE ||
    process.env.CIRCLECI,
  );
}

function readCache(): CacheShape | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    if (typeof parsed.latestVersion === 'string' && typeof parsed.checkedAt === 'number') {
      return { latestVersion: parsed.latestVersion, checkedAt: parsed.checkedAt };
    }
  } catch { /* no cache, bad JSON, first run — all handled by returning null */ }
  return null;
}

function writeCache(data: CacheShape): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch { /* cache write is best-effort — never crash startup over it */ }
}

/**
 * Compare two semver strings (stripping a leading `v` and any pre-release
 * tag after a hyphen — we don't publish prereleases). Returns:
 *   1  if a > b
 *  -1  if a < b
 *   0  if equal or unparseable
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const core = v.replace(/^v/, '').split('-')[0];
    const parts = core.split('.').map(n => Number.parseInt(n, 10));
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2]];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the cache in the background if it's stale. Never throws, never
 * awaited by callers — result lands before next startup.
 */
export function kickoffVersionCheck(): void {
  if (isDisabled()) return;
  const cache = readCache();
  if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return;

  // Detach from the event loop so startup doesn't wait on network.
  // Node keeps the process alive until the fetch settles, which is fine
  // for short-lived CLI invocations and irrelevant for long-running
  // interactive sessions.
  void fetchLatestVersion().then(latest => {
    if (!latest) return;
    writeCache({ latestVersion: latest, checkedAt: Date.now() });
  });
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * Sync check against the cached latest. Returns update info if the cache
 * knows of a newer version, null otherwise. Safe to call before the first
 * background check settles — returns null (we don't speculate).
 */
export function getAvailableUpdate(): UpdateInfo | null {
  if (isDisabled()) return null;
  const cache = readCache();
  if (!cache) return null;
  if (compareSemver(cache.latestVersion, VERSION) > 0) {
    return { current: VERSION, latest: cache.latestVersion };
  }
  return null;
}

/**
 * Authoritative check that forces a fresh fetch (up to FETCH_TIMEOUT_MS).
 * Use for on-demand diagnostics like `franklin doctor` where the user
 * explicitly asked "am I up to date?" and a 24h-stale cache is the wrong
 * answer. Verified 2026-05-11: between two same-day releases (3.15.91 →
 * 3.15.92), the daily cache made `franklin doctor` show green for a user
 * who was actually 4 versions behind (3.15.88), because they ran doctor
 * in the brief gap between npm publish and the next cache refresh.
 *
 * Falls back to the cached value if the fetch fails (offline, slow npm,
 * etc.) — same behavior as the cached check, just refreshed when
 * possible.
 */
export async function getAvailableUpdateFresh(): Promise<UpdateInfo | null> {
  if (isDisabled()) return getAvailableUpdate();
  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache({ latestVersion: latest, checkedAt: Date.now() });
    if (compareSemver(latest, VERSION) > 0) {
      return { current: VERSION, latest };
    }
    return null;
  }
  // Fetch failed — fall back to whatever the cache says.
  return getAvailableUpdate();
}
