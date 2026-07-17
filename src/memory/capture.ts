/**
 * Memory capture pipeline:
 *  - zero-LLM session summaries at session end (metadata only, free)
 *  - /flush — LLM capture of the session's durable learnings
 *  - trading capture — journal + thesis entries on trade execution
 */

import type { Dialogue } from '../agent/types.js';
import type { ModelClient } from '../agent/llm.js';
import { recordUsage } from '../stats/tracker.js';
import { estimateCost } from '../pricing.js';
import {
  appendUnderHeading,
  memoryEnabled,
  sessionLogPath,
  thesisPath,
  tradingJournalPath,
  writeSessionLog,
} from './store.js';

function userPrompts(history: Dialogue[]): string[] {
  const prompts: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const text = msg.content.trim();
    // Skip harness-injected continuations and command noise.
    if (!text || text.startsWith('/') || text.startsWith('Continue working the active goal')) continue;
    prompts.push(text);
  }
  return prompts;
}

/**
 * Metadata-only session summary — no LLM call, no latency, no cost.
 * Trivial sessions (fewer than 3 substantive prompts) are skipped.
 */
export function writeSessionMetadataSummary(opts: {
  workDir: string;
  sessionId: string;
  history: Dialogue[];
  costUsd?: number;
}): boolean {
  if (!memoryEnabled()) return false;
  const prompts = userPrompts(opts.history);
  const totalUserBytes = prompts.reduce((n, p) => n + p.length, 0);
  if (prompts.length < 3 || totalUserBytes < 50) return false;

  const topics = prompts.slice(0, 5).map(p => `- ${p.replace(/\s+/g, ' ').slice(0, 120)}`);
  writeSessionLog(
    opts.workDir,
    opts.sessionId,
    [
      `# Session ${opts.sessionId.slice(0, 8)} — ${new Date().toISOString()}`,
      '',
      `Messages: ${opts.history.length} · user prompts: ${prompts.length}` +
        (opts.costUsd != null ? ` · cost: $${opts.costUsd.toFixed(4)}` : ''),
      '',
      '## Topics',
      ...topics,
    ].join('\n')
  );
  return true;
}

const FLUSH_PROMPT = `Review the conversation above and extract ONLY the durable learnings worth
remembering across sessions: decisions made and why, facts discovered about the
user's holdings/preferences/projects, working theses, and outcomes of actions
taken. Skip process narration and anything trivially re-derivable. Output tight
markdown bullets grouped under ## headings (Preferences / Decisions / Findings /
Theses as applicable), max 2000 characters. If nothing is worth keeping, output
exactly: NOTHING_DURABLE`;

/** /flush — LLM capture of the session's durable content into a session log. */
export async function flushSessionMemory(opts: {
  client: ModelClient;
  model: string;
  workDir: string;
  sessionId: string;
  history: Dialogue[];
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!memoryEnabled()) return null;
  const { content, usage } = await opts.client.complete(
    {
      model: opts.model,
      messages: [...opts.history, { role: 'user', content: FLUSH_PROMPT }],
      max_tokens: 1024,
      stream: true,
    },
    opts.signal ?? new AbortController().signal
  );
  try {
    recordUsage(opts.model, usage.inputTokens, usage.outputTokens, estimateCost(opts.model, usage.inputTokens, usage.outputTokens), 0);
  } catch { /* best-effort */ }

  const text = content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('\n')
    .trim();
  if (!text || text.includes('NOTHING_DURABLE')) return null;

  writeSessionLog(
    opts.workDir,
    opts.sessionId,
    `# Session ${opts.sessionId.slice(0, 8)} — flushed ${new Date().toISOString()}\n\n${text.slice(0, 4000)}`
  );
  return sessionLogPath(opts.workDir, opts.sessionId);
}

// ─── Trading capture ───────────────────────────────────────────────────────

export interface TradeMemoryEvent {
  kind: 'open' | 'close' | 'bet';
  chain: string;
  address: string;
  asset: string;
  amountUsd?: number;
  thesis?: string;
  pnlUsd?: number;
  /** Reference into trades.jsonl / tx hash for the audit trail. */
  ref?: string;
}

/** Append a curated journal entry (and thesis file on opens with a thesis). */
export function captureTradeEvent(event: TradeMemoryEvent): void {
  if (!memoryEnabled()) return;
  if (!event.address) return;
  const journal = tradingJournalPath(event.chain, event.address);
  const amount = event.amountUsd != null ? ` $${event.amountUsd.toFixed(2)}` : '';
  const pnl = event.pnlUsd != null ? ` · P&L ${event.pnlUsd >= 0 ? '+' : ''}$${event.pnlUsd.toFixed(2)}` : '';
  const ref = event.ref ? ` · ref ${event.ref}` : '';

  const heading = event.kind === 'close' ? 'Closed positions' : event.kind === 'bet' ? 'Bets' : 'Open positions';
  appendUnderHeading(journal, heading, `${event.kind.toUpperCase()} ${event.asset}${amount}${pnl}${ref}`);

  if (event.thesis && event.kind !== 'close') {
    appendUnderHeading(
      thesisPath(event.chain, event.address, event.asset),
      'Thesis',
      `${event.thesis.trim().slice(0, 600)}${ref}`
    );
  }
  if (event.kind === 'close' && event.pnlUsd != null) {
    appendUnderHeading(
      thesisPath(event.chain, event.address, event.asset),
      'Outcomes',
      `closed${amount}${pnl}${ref}`
    );
  }
}
