/**
 * Portfolio persistence. Stored as JSON alongside the rest of Franklin's
 * per-user state under `~/.blockrun/portfolio.json` by default. Read/write
 * errors never throw — a missing or corrupt file just returns `null` so the
 * agent can fall back to a fresh portfolio rather than refusing to start.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Portfolio } from './portfolio.js';

export function savePortfolio(pf: Portfolio, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(pf.snapshot(), null, 2), 'utf-8');
}

export function loadPortfolio(filePath: string): Portfolio | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (
      typeof raw?.cashUsd !== 'number' ||
      typeof raw?.realizedPnlUsd !== 'number' ||
      !Array.isArray(raw?.positions)
    ) {
      return null;
    }
    const pf = new Portfolio({ startingCashUsd: 0 });
    pf.restore(raw);
    return pf;
  } catch {
    // Corrupt JSON — start fresh rather than crash.
    return null;
  }
}
