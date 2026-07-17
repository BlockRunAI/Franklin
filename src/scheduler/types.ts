/**
 * Durable prompt scheduler — recurring or one-shot prompts that fire as
 * synthetic user inputs at turn boundaries (via the input multiplexer).
 */

export interface ScheduledTask {
  id: string;
  prompt: string;
  /** Seconds between firings. Minimum 60. */
  intervalSec: number;
  /** Recurring tasks re-arm after each firing; one-shots disable. */
  recurring: boolean;
  /**
   * Durable tasks persist across sessions: if a firing was missed while no
   * session was running, the next session start fires it once (catch-up).
   * Non-durable tasks live only as long as the session that created them.
   */
  durable: boolean;
  createdAt: number;
  /** Hard expiry — the task stops firing and is pruned after this. */
  expiresAt: number;
  nextFireAt: number;
  lastFiredAt?: number;
  firedCount: number;
  enabled: boolean;
  /** Session that created the task — owner of non-durable tasks. */
  sessionId: string;
}

export const MIN_INTERVAL_SEC = 60;
export const MAX_LIVE_TASKS = 50;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // auto-expire after 7 days

/**
 * Parse "90s" / "5m" / "2h" / "1d" into seconds. Bare numbers are seconds.
 * Returns null for unparseable input; callers surface usage help.
 */
export function parseInterval(text: string): number | null {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return n * mult;
}

export function formatInterval(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
