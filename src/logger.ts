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

function writeFile(level: LogLevel, msg: string): void {
  ensureDir();
  try {
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
