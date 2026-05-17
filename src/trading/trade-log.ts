/**
 * TradeLog — JSONL persistent record of every fill the agent executes.
 *
 * Purpose: cross-session P&L memory. The Portfolio snapshot tells you
 * current state; the TradeLog tells you how you got there. This is the
 * load-bearing surface for answers to questions like:
 *   - "What was my best / worst trade this week?"
 *   - "Am I up or down over the last 30 days?"
 *   - "How many times did I flip BTC in the last session?"
 *
 * Coding-only agents can't answer any of these — they have no persistent
 * economic memory across sessions. Franklin can.
 *
 * Format: one JSON object per line, append-only. Reads parse lazily and
 * skip malformed lines rather than crash, so a partial write from a
 * prior crash never bricks the log.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Side } from './portfolio.js';

/**
 * Trade rationale — the "why" behind a fill, captured at trade time so
 * the journal can score for discipline (not P&L). Inspired by the AI-Trader
 * signal-quality model: verifiability + evidence + specificity drive better
 * decisions than rewarding outcomes (which incentivizes curve-fitting).
 *
 * All fields are optional; the scorer rewards completeness without forcing it.
 */
export interface TradeRationale {
  direction?: 'long' | 'short' | 'neutral';
  priceTarget?: number;       // expected exit price
  stopLoss?: number;          // forced exit floor
  timeHorizon?: string;       // free-form: "1h", "1d", "1w", "1m", …
  conviction?: 1 | 2 | 3 | 4 | 5;
  evidence?: string[];        // sources, links, indicator names
  tags?: string[];            // e.g. "momentum", "macro", "mean-reversion"
  thesis?: string;            // free-text reasoning
}

/**
 * Persisted quality breakdown — five components on 0–1 scales plus a 0–5
 * total. Written next to each entry at append time so portfolio reads
 * never need to re-score.
 */
export interface QualityScore {
  total: number;          // 0–5
  verifiability: number;  // 0–1
  evidence: number;       // 0–1
  specificity: number;    // 0–1
  novelty: number;        // 0–1
  review: number;         // 0–1
}

export interface TradeLogEntry {
  timestamp: number; // ms since epoch
  symbol: string;
  side: Side;
  qty: number;
  priceUsd: number;
  feeUsd: number;
  /** Realized P&L from this specific fill — 0 for opens, ± for closes. */
  realizedPnlUsd: number;
  /** Journal-v2 fields (optional, back-compat: older entries lack these). */
  rationale?: TradeRationale;
  /** User's post-trade note. Boosts the `review` component of the score. */
  review?: string;
  /** Computed at append time so portfolio reads don't re-score on every render. */
  qualityScore?: QualityScore;
}

export class TradeLog {
  constructor(private filePath: string) {}

  append(entry: TradeLogEntry): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Best-effort persistence; never block a trade on disk failure.
    }
  }

  /** Read all entries from disk in chronological order. */
  all(): TradeLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    const out: TradeLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (
          typeof obj?.timestamp === 'number' &&
          typeof obj?.symbol === 'string' &&
          (obj.side === 'buy' || obj.side === 'sell') &&
          typeof obj.qty === 'number' &&
          typeof obj.priceUsd === 'number' &&
          typeof obj.feeUsd === 'number' &&
          typeof obj.realizedPnlUsd === 'number'
        ) {
          out.push(obj as TradeLogEntry);
        }
      } catch {
        // Corrupt line — skip, don't crash.
      }
    }
    return out;
  }

  /** Most recent N entries, newest-first. */
  recent(n: number): TradeLogEntry[] {
    const all = this.all();
    return all.slice(-n).reverse();
  }

  /** Signed sum of realizedPnlUsd across every entry with timestamp >= since. */
  realizedSince(since: number): number {
    let total = 0;
    for (const e of this.all()) {
      if (e.timestamp >= since) total += e.realizedPnlUsd;
    }
    return total;
  }
}
