/**
 * CallLog — JSONL persistent record of every outbound voice call the agent
 * initiates through VoiceCall (and updates as VoiceStatus polls for status).
 *
 * Why a journal: BlockRun's gateway doesn't expose a "list my calls" endpoint —
 * /v1/voice/call/{id} works but you need to remember the id. Without local
 * persistence, the panel can't show a "recent calls" view and cross-session
 * memory ("did I already leave a voicemail at this number this week?") is
 * impossible.
 *
 * Why append-only with multiple rows per call_id: calls are async, status
 * mutates over time (queued → in_progress → completed). Append-only avoids
 * the JSONL-rewrite-race that an in-place update would introduce — readers
 * pick the latest row by call_id when summarizing. Same approach trade-log
 * uses for fills vs corrections.
 *
 * Schema (additive over time; readers tolerate missing optional fields):
 *   timestamp:    ms epoch of THIS log row (not the call start)
 *   call_id:      Bland.ai call identifier (stable across rows)
 *   to / from:    E.164 numbers
 *   task:         the natural-language instructions the AI followed
 *   voice / max_duration_min / language:  caller-side preferences (queue row only)
 *   status:       queued | in_progress | completed | failed | cancelled |
 *                 busy | no-answer | voicemail
 *   duration_sec: actual call length once known
 *   transcript:   full conversation text once completed
 *   recording_url: Bland-hosted MP3/WAV link
 *   paid_usd:     0.54 charged on the initial POST; later rows carry 0
 *   tx_hash:      x402 settlement hash for the initial POST
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type CallStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'busy'
  | 'no-answer'
  | 'voicemail';

export interface CallLogEntry {
  timestamp: number;
  call_id: string;
  to: string;
  from: string;
  task: string;
  voice?: string;
  max_duration_min?: number;
  language?: string;
  status: CallStatus;
  duration_sec?: number;
  transcript?: string;
  recording_url?: string;
  paid_usd: number;
  tx_hash?: string;
}

/** Set of statuses that mean "no further polling needed". */
const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  'completed',
  'failed',
  'cancelled',
  'busy',
  'no-answer',
  'voicemail',
]);

export function isTerminalStatus(s: unknown): s is CallStatus {
  return typeof s === 'string' && TERMINAL_STATUSES.has(s as CallStatus);
}

export function defaultCallLogPath(): string {
  return join(homedir(), '.blockrun', 'calls.jsonl');
}

export class CallLog {
  constructor(private filePath: string = defaultCallLogPath()) {}

  append(entry: CallLogEntry): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      /* best-effort persistence; never block a call on disk failure */
    }
  }

  /** Read every entry on disk in chronological (append) order. */
  all(): CallLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    const out: CallLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (
          typeof obj?.timestamp === 'number' &&
          typeof obj?.call_id === 'string' &&
          typeof obj?.to === 'string' &&
          typeof obj?.from === 'string' &&
          typeof obj?.task === 'string' &&
          typeof obj?.status === 'string' &&
          typeof obj?.paid_usd === 'number'
        ) {
          out.push(obj as CallLogEntry);
        }
      } catch {
        /* corrupt line — skip */
      }
    }
    return out;
  }

  /**
   * Latest row for each call_id, newest first by initial-row timestamp.
   * This is the canonical "list of calls" view for the panel.
   */
  summary(limit = 50): CallLogEntry[] {
    const all = this.all();
    const latest = new Map<string, CallLogEntry>();
    const paidByCall = new Map<string, number>();
    for (const e of all) {
      paidByCall.set(e.call_id, Math.max(paidByCall.get(e.call_id) ?? 0, e.paid_usd));
      const cur = latest.get(e.call_id);
      // Keep the row with the FRESHEST timestamp per call_id (status updates).
      if (!cur || e.timestamp >= cur.timestamp) latest.set(e.call_id, e);
    }
    // Sort newest-first by the latest-row timestamp.
    const list = Array.from(latest.values())
      .map(e => ({ ...e, paid_usd: paidByCall.get(e.call_id) ?? e.paid_usd }))
      .sort((a, b) => b.timestamp - a.timestamp);
    return list.slice(0, limit);
  }

  byCallId(callId: string): CallLogEntry | null {
    let best: CallLogEntry | null = null;
    let paidUsd = 0;
    for (const e of this.all()) {
      if (e.call_id !== callId) continue;
      paidUsd = Math.max(paidUsd, e.paid_usd);
      if (!best || e.timestamp >= best.timestamp) best = e;
    }
    return best ? { ...best, paid_usd: paidUsd } : null;
  }
}
