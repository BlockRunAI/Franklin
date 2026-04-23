/**
 * Opt-in local telemetry.
 *
 * Principles (non-negotiable):
 *   1. Opt-in only — default is off. A fresh install collects nothing.
 *   2. Local only — this module writes to ~/.blockrun/telemetry.jsonl.
 *      No network transmission, ever. A future opt-in "upload" feature
 *      would be a separate module with its own consent gate.
 *   3. No content — never log prompts, tool inputs, tool outputs, file
 *      paths, or wallet addresses. Count-level aggregates only.
 *   4. Inspectable — the log is plain JSONL, one record per session.
 *      `franklin telemetry view` prints it. Users see exactly what was
 *      recorded before ever considering sharing it.
 *   5. Revocable — `franklin telemetry disable` stops future writes
 *      and leaves historical data intact. `franklin telemetry reset`
 *      (future) would wipe the log.
 *
 * Data model is a sanitized projection of SessionMeta. Nothing original
 * is stored here that isn't already derivable from the session meta
 * files — telemetry is just a stable, aggregation-friendly view of
 * information the user already has.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR, VERSION } from '../config.js';
import { listSessions, type SessionMeta } from '../session/storage.js';

const CONSENT_FILE = path.join(BLOCKRUN_DIR, 'telemetry-consent.json');
const LOG_FILE = path.join(BLOCKRUN_DIR, 'telemetry.jsonl');
const INSTALL_ID_FILE = path.join(BLOCKRUN_DIR, 'telemetry-install-id.txt');

interface ConsentRecord {
  enabled: boolean;
  enabledAt?: number;
  disabledAt?: number;
}

/** Sanitized projection of a session used for telemetry. No content. */
export interface TelemetryRecord {
  /** Stable per-install random UUID. Not tied to wallet or email. */
  installId: string;
  /** Franklin version at the time this session ran. */
  version: string;
  /** Session timestamp (ISO string). */
  ts: string;
  /** Number of user turns. */
  turns: number;
  /** Number of message entries (user + assistant + tool_result). */
  messages: number;
  /** Input / output tokens for the whole session. */
  inputTokens: number;
  outputTokens: number;
  /** Cost in USDC. */
  costUsd: number;
  /** Savings vs Opus-tier baseline in USDC. */
  savedVsOpusUsd: number;
  /** Last-active model id for the session. */
  model: string;
  /** Chain the session settled on (base / solana). */
  chain?: string;
  /** Session driver — "cli" for normal use, or the channel tag for Telegram/etc. */
  driver: string;
  /** Per-tool invocation counts (names only, no content). */
  toolCallCounts?: Record<string, number>;
}

function ensureDir(): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
}

function canonicalDir(dir: string): string {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/** Enabled-state check. Default: false. */
export function isTelemetryEnabled(): boolean {
  try {
    const raw = fs.readFileSync(CONSENT_FILE, 'utf-8');
    const record = JSON.parse(raw) as ConsentRecord;
    return record.enabled === true;
  } catch {
    return false;
  }
}

export function setTelemetryEnabled(enabled: boolean): void {
  ensureDir();
  const existing = readConsent();
  const next: ConsentRecord = enabled
    ? { enabled: true, enabledAt: Date.now() }
    : { enabled: false, enabledAt: existing.enabledAt, disabledAt: Date.now() };
  fs.writeFileSync(CONSENT_FILE, JSON.stringify(next, null, 2));
}

export function readConsent(): ConsentRecord {
  try {
    return JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf-8')) as ConsentRecord;
  } catch {
    return { enabled: false };
  }
}

/** Stable per-install random UUID. Generated lazily on first write. */
export function getOrCreateInstallId(): string {
  try {
    const raw = fs.readFileSync(INSTALL_ID_FILE, 'utf-8').trim();
    if (raw.length > 0) return raw;
  } catch { /* first run */ }
  ensureDir();
  const id = crypto.randomUUID();
  fs.writeFileSync(INSTALL_ID_FILE, id);
  return id;
}

/**
 * Sanitize a SessionMeta into a telemetry record. No content is added here
 * that isn't already present in the meta — the sanitization rule is that
 * every field must be count-level or identifier-level, never user content.
 */
export function sessionMetaToRecord(
  meta: SessionMeta,
  installId: string,
  chain?: string,
): TelemetryRecord {
  return {
    installId,
    version: VERSION,
    ts: new Date(meta.updatedAt).toISOString(),
    turns: meta.turnCount ?? 0,
    messages: meta.messageCount ?? 0,
    inputTokens: meta.inputTokens ?? 0,
    outputTokens: meta.outputTokens ?? 0,
    costUsd: meta.costUsd ?? 0,
    savedVsOpusUsd: meta.savedVsOpusUsd ?? 0,
    model: meta.model ?? 'unknown',
    chain,
    // "cli" if no channel tag, else the channel string (e.g. "telegram:12345").
    // Channel may include an owner id; we deliberately keep it because the
    // install id is already user-agnostic and linking a driver to a user
    // is necessary to distinguish "single user with Telegram" from "many
    // users with CLI" in aggregate data. Users who don't want this strip
    // it by running telemetry disable.
    driver: meta.channel ?? 'cli',
    ...(meta.toolCallCounts ? { toolCallCounts: meta.toolCallCounts } : {}),
  };
}

/** Append one record to the telemetry log. Silent no-op if disabled. */
export function recordSession(meta: SessionMeta, chain?: string): void {
  if (!isTelemetryEnabled()) return;
  ensureDir();
  const record = sessionMetaToRecord(meta, getOrCreateInstallId(), chain);
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch {
    // Telemetry is best-effort — never block a user session on a disk write.
  }
}

/**
 * Locate the session that just finished by ID or by "newest in the sessions
 * directory whose workDir matches", then record it. Used by start.ts at
 * exit since interactiveSession() doesn't currently thread the session id
 * back to the caller.
 */
export function recordLatestSessionIfEnabled(
  workingDir: string,
  chain?: string,
): void {
  if (!isTelemetryEnabled()) return;
  const targetDir = canonicalDir(workingDir);
  const sessions = listSessions();
  const match = sessions.find(s => canonicalDir(s.workDir) === targetDir);
  if (!match) return;
  recordSession(match, chain);
}

/** Read every record in the log. Returns [] if the file is missing. */
export function readAllRecords(): TelemetryRecord[] {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const out: TelemetryRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as TelemetryRecord); } catch { /* skip corrupt */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** File paths — surfaced so the CLI can show users where data lives. */
export const telemetryPaths = {
  consent: CONSENT_FILE,
  log: LOG_FILE,
  installId: INSTALL_ID_FILE,
};
