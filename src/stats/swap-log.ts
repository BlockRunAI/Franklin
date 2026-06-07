/**
 * Swap ledger — one line per executed on-chain swap, at ~/.blockrun/swaps.jsonl.
 * The swap tools (0x on Base, Jupiter on Solana) append here on success so the
 * desktop wallet view can show a "swaps" history with explorer links. Mirrors
 * the JSONL pattern of cost-log / audit. All writes are best-effort.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

const SWAP_FILE = path.join(BLOCKRUN_DIR, 'swaps.jsonl');

export interface SwapRow {
  ts: number;            // unix ms
  chain: 'base' | 'solana';
  dex: string;           // '0x' | 'jupiter' | …
  sellSym: string;
  sellAmount: number;
  buySym: string;
  buyAmount: number;
  txHash: string;
  explorer?: string;     // full explorer URL
}

export function appendSwap(row: SwapRow): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.appendFileSync(SWAP_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch { /* best-effort */ }
}

export function readSwaps(limit = 100): SwapRow[] {
  try {
    const lines = fs.readFileSync(SWAP_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    const rows: SwapRow[] = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line) as SwapRow); } catch { /* skip bad line */ }
    }
    return rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch {
    return [];
  }
}
