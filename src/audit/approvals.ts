/**
 * Unified approval/decision audit log — one book for every gate decision:
 * hook denies, permission prompts, and trade-plan verdicts. Append-only
 * JSONL at ~/.blockrun/approvals.jsonl so `franklin panel` and post-hoc
 * forensics read a single stream instead of three.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';

export interface ApprovalRecord {
  ts: number;
  sessionId: string;
  /** What kind of gate produced this record. */
  kind: 'hook' | 'permission' | 'trade-plan';
  /** What was being decided — tool name, plan id, hook source. */
  subject: string;
  decision: 'allow' | 'deny' | 'approve' | 'reject' | 'expire' | 'cancel';
  /** Who decided: 'hook:<file>', 'user:tui', 'user:panel', 'policy', 'flag'. */
  by: string;
  reason?: string;
}

export function approvalsLogPath(): string {
  return path.join(BLOCKRUN_DIR, 'approvals.jsonl');
}

export function appendApprovalRecord(record: ApprovalRecord): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.appendFileSync(approvalsLogPath(), JSON.stringify(record) + '\n');
  } catch {
    // Audit is best-effort — never block the agent on a log write.
  }
}
