/**
 * Unified logger — always persists to ~/.blockrun/franklin-debug.log,
 * optionally mirrors to stderr when debug mode is on.
 *
 * Why this exists: before this module, agent diagnostics were emitted with
 * `if (config.debug) console.error(...)`. That meant `franklin logs` showed
 * nothing in normal use because the events never hit the file. Now every
 * level writes to disk; stderr mirroring is the opt-in part.
 *
 * Errors during a log write are swallowed — the agent loop must never die
 * because the disk is full or the home dir is read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from './config.js';

const LOG_FILE = path.join(BLOCKRUN_DIR, 'franklin-debug.log');
const ARCHIVE_FILE = path.join(BLOCKRUN_DIR, 'franklin-debug.log.1');

// Self-rotation threshold. When the live log crosses this size on a
// write, rename it to franklin-debug.log.1 (overwriting any previous
// archive) and start fresh. Non-destructive: one full archive of the
// most recent ROTATE_AT_BYTES is always retained, so users can still
// read history across the rotation. Earlier behavior (only triggered
// by `franklin logs`, sliced the file in half in-place) lost history
// outright and only ran if the user happened to invoke `franklin logs`.
const ROTATE_AT_BYTES = 10 * 1024 * 1024; // 10 MB
// Probe every N writes to amortize the stat() — average debug entry is
// ~80 bytes, so 1000 writes (~80 KB worth) between checks keeps the
// overhead negligible while still catching a runaway log within seconds.
const ROTATE_PROBE_EVERY_N_WRITES = 1000;
let writesSinceRotateProbe = 0;

// Strip ANSI escapes + carriage returns so the log stays grep-able.
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07|\r/g;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let debugMode = false;
let dirEnsured = false;

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

export function isDebugMode(): boolean {
  return debugMode;
}

export function getLogFilePath(): string {
  return LOG_FILE;
}

function ensureDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    dirEnsured = true;
  } catch { /* readonly mount / disk full — keep trying so a remount recovers */ }
}

function maybeRotate(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const { size } = fs.statSync(LOG_FILE);
    if (size < ROTATE_AT_BYTES) return;
    // renameSync overwrites an existing target on POSIX, which is what
    // we want — single archive, always the most recent rotation. On
    // Windows the rename can EEXIST; in that case unlink the archive
    // first and retry. If even that fails, fall through silently rather
    // than leaving the log file in a half-rotated state.
    try {
      fs.renameSync(LOG_FILE, ARCHIVE_FILE);
    } catch {
      try { fs.unlinkSync(ARCHIVE_FILE); } catch { /* may not exist */ }
      try { fs.renameSync(LOG_FILE, ARCHIVE_FILE); } catch { /* give up */ }
    }
  } catch { /* best effort */ }
}

function writeFile(level: LogLevel, msg: string): void {
  ensureDir();
  try {
    writesSinceRotateProbe++;
    if (writesSinceRotateProbe >= ROTATE_PROBE_EVERY_N_WRITES) {
      writesSinceRotateProbe = 0;
      maybeRotate();
    }
    const clean = msg.replace(ANSI_RE, '');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${clean}\n`);
  } catch { /* best-effort — never break the agent on log failure */ }
}

function writeStderr(msg: string): void {
  try { process.stderr.write(msg + '\n'); } catch { /* swallow */ }
}

export const logger = {
  debug(msg: string): void {
    writeFile('debug', msg);
    if (debugMode) writeStderr(msg);
  },
  info(msg: string): void {
    writeFile('info', msg);
    if (debugMode) writeStderr(msg);
  },
  warn(msg: string): void {
    writeFile('warn', msg);
    if (debugMode) writeStderr(msg);
  },
  error(msg: string): void {
    writeFile('error', msg);
    if (debugMode) writeStderr(msg);
  },
};
