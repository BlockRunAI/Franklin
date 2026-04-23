/**
 * Interactive session picker for `franklin resume`.
 * Lists recent sessions (newest first) and returns the selected ID.
 */

import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import chalk from 'chalk';
import { listSessions, type SessionMeta } from '../session/storage.js';

// Canonicalize a path so symlinks compare equal (e.g., /tmp vs /private/tmp on macOS).
// Falls back to resolve() if the path no longer exists on disk.
function canonical(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function shortDir(dir: string): string {
  const home = process.env.HOME || '';
  const clean = home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
  return clean.length > 40 ? '…' + clean.slice(-39) : clean;
}

function modelShort(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

type SessionPickerSelection =
  | { kind: 'cancel' }
  | { kind: 'selected'; id: string }
  | { kind: 'invalid'; message: string };

/**
 * Resolve a user-provided session identifier to a full session ID.
 * Supports exact match and unambiguous prefix match (minimum 8 chars).
 * Returns { ok, id } on success, or { ok, error, candidates } on failure.
 */
export function resolveSessionIdInput(input: string):
  | { ok: true; id: string }
  | { ok: false; error: 'not-found' | 'ambiguous'; candidates: SessionMeta[] } {
  return resolveSessionIdFromList(input, listSessions());
}

function resolveSessionIdFromList(
  input: string,
  sessions: SessionMeta[],
): { ok: true; id: string } | { ok: false; error: 'not-found' | 'ambiguous'; candidates: SessionMeta[] } {
  // Exact match first
  const exact = sessions.find((s) => s.id === input);
  if (exact) return { ok: true, id: exact.id };

  // Prefix match — require at least 8 chars to avoid accidental collisions
  if (input.length >= 8) {
    const matches = sessions.filter((s) => s.id.startsWith(input));
    if (matches.length === 1) return { ok: true, id: matches[0].id };
    if (matches.length > 1) return { ok: false, error: 'ambiguous', candidates: matches };
  }

  return { ok: false, error: 'not-found', candidates: [] };
}

export function resolvePickerSelection(
  input: string,
  shown: SessionMeta[],
  sessions: SessionMeta[]
): SessionPickerSelection {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'cancel' };

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= shown.length) {
    return { kind: 'selected', id: shown[num - 1].id };
  }

  const exact = sessions.find((s) => s.id === trimmed);
  if (exact) return { kind: 'selected', id: exact.id };

  const resolved = resolveSessionIdFromList(trimmed, sessions);
  if (resolved.ok) {
    return { kind: 'selected', id: resolved.id };
  }

  if (resolved.error === 'ambiguous') {
    const preview = resolved.candidates
      .slice(0, 3)
      .map((candidate) => candidate.id)
      .join(', ');
    return {
      kind: 'invalid',
      message: `Ambiguous session prefix: ${trimmed}${preview ? ` (${preview}${resolved.candidates.length > 3 ? ', …' : ''})` : ''}`,
    };
  }

  return { kind: 'invalid', message: `No session found matching: ${trimmed}` };
}

/**
 * Find the most recent session for a given working directory.
 * Returns null if none exists.
 */
export function findLatestSessionForDir(workDir: string): SessionMeta | null {
  const target = canonical(workDir);
  for (const s of listSessions()) {
    if (canonical(s.workDir) === target) return s;
  }
  return null;
}

/**
 * Show an interactive session picker. Returns the selected session ID,
 * or null if the user cancels / no sessions exist.
 */
export async function pickSession(opts: { workDir?: string } = {}): Promise<string | null> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.error(chalk.yellow('\n  No saved sessions found.\n'));
    return null;
  }

  const limit = 20;
  const shown = sessions.slice(0, limit);

  console.error('');
  console.error(chalk.bold('  Resume session:\n'));
  shown.forEach((s, i) => {
    const num = chalk.cyan(String(i + 1).padStart(2));
    const when = formatRelative(s.updatedAt).padEnd(8);
    const turns = `${s.turnCount}t`.padEnd(5);
    const model = modelShort(s.model).padEnd(20);
    const dir = chalk.dim(shortDir(s.workDir));
    const hereMark = opts.workDir && canonical(s.workDir) === canonical(opts.workDir)
      ? chalk.green(' ●')
      : '';
    console.error(`  ${num}. ${chalk.dim(when)} ${turns} ${model} ${dir}${hereMark}`);
  });
  console.error('');
  console.error(chalk.dim('  Enter a number to resume, or press Enter to cancel.'));
  if (opts.workDir) console.error(chalk.dim('  ● = matches current directory'));
  console.error('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  return new Promise<string | null>((resolve) => {
    const prompt = () => {
      rl.question(chalk.bold('  session> '), (answer) => {
        const selection = resolvePickerSelection(answer, shown, sessions);
        if (selection.kind === 'cancel') {
          rl.close();
          resolve(null);
          return;
        }
        if (selection.kind === 'selected') {
          rl.close();
          resolve(selection.id);
          return;
        }
        console.error(chalk.yellow(`  ${selection.message}`));
        prompt();
      });
    };

    prompt();
  });
}
