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
 * Claude Code and Cursor can't answer any of these — they have no
 * persistent economic memory across sessions. Franklin can.
 *
 * Format: one JSON object per line, append-only. Reads parse lazily and
 * skip malformed lines rather than crash, so a partial write from a
 * prior crash never bricks the log.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Side } from './portfolio.js';

export interface TradeLogEntry {
  timestamp: number; // ms since epoch
  symbol: string;
  side: Side;
  qty: number;
  priceUsd: number;
  feeUsd: number;
  /** Realized P&L from this specific fill — 0 for opens, ± for closes. */
  realizedPnlUsd: number;
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
