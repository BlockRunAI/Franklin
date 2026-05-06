/**
 * Audit log — append-only forensic record of every LLM call.
 *
 * Lives at ~/.blockrun/franklin-audit.jsonl. One line per call, JSONL.
 * Unlike franklin-stats.json (aggregates), this file lets you answer
 * "what was I actually doing when $1.50 disappeared on Apr 12?".
 *
 * Fields kept intentionally small (truncated prompt, no tool args) so the
 * file stays readable and doesn't leak large tool outputs to disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR } from '../config.js';
import { isTestFixtureModel } from './test-fixture.js';

const AUDIT_FILE = path.join(BLOCKRUN_DIR, 'franklin-audit.jsonl');
const PROMPT_PREVIEW_CHARS = 240;

// Cap the audit log at the most recent N entries. Without this the file
// grew unbounded — verified ~3.6k lines on a single dev machine after a
// few weeks of light use, so a months-old install would be in the GB
// range and slow `franklin insights` to a crawl.
const MAX_AUDIT_ENTRIES = 10_000;
// Each entry is roughly 300–800 bytes. We only re-read the file when it
// looks plausibly over the cap, so we don't pay an O(n) scan on every
// append. 200 bytes/entry is a conservative lower bound.
const TRIM_PROBE_BYTES = MAX_AUDIT_ENTRIES * 200;
// Probe size every N appends — amortizes the stat() call.
const TRIM_CHECK_INTERVAL = 200;
let appendsSinceCheck = 0;

export interface AuditEntry {
  ts: number;
  sessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs?: number;
  fallback?: boolean;
  source: 'agent' | 'proxy' | 'subagent' | 'moa' | 'plugin';
  workDir?: string;
  prompt?: string;          // truncated last user message
  toolCalls?: string[];     // tool names invoked this turn
  routingTier?: string;     // free | cheap | premium
}

export function appendAudit(entry: AuditEntry): void {
  // Tests run interactiveSession() in-process with model="local/test*"
  // and would otherwise pollute the user's real audit log. Drop the
  // entry before any disk write rather than relying on every test to
  // remember to redirect HOME.
  if (isTestFixtureModel(entry.model)) return;
  // Belt-and-braces: when 3.15.17 renamed several test fixtures from
  // local/test-model to zai/glm-5.1 (a real-looking model, so
  // persistence tests can verify the write path), the model-name gate
  // stopped catching them. Verified on a real machine: 310 of 370
  // recent zai/glm-5.1 audit entries had output_tokens < 10 — clearly
  // mock responses. The env-var lets tests opt out at file level
  // without renaming fixtures back.
  if (process.env.FRANKLIN_NO_AUDIT === '1') return;

  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    const safe: AuditEntry = {
      ...entry,
      prompt: entry.prompt ? truncate(entry.prompt, PROMPT_PREVIEW_CHARS) : undefined,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(safe) + '\n');

    appendsSinceCheck++;
    if (appendsSinceCheck >= TRIM_CHECK_INTERVAL) {
      appendsSinceCheck = 0;
      enforceRetention();
    }
  } catch {
    /* best-effort — never break the agent loop on audit-write failure */
  }
}

/**
 * Trim the audit log to the last MAX_AUDIT_ENTRIES lines if it has grown
 * past the cap. Exported so admin/debug tooling (and tests) can force a
 * compaction without waiting for the next interval probe.
 */
export function enforceRetention(): void {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size < TRIM_PROBE_BYTES) return;

    const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= MAX_AUDIT_ENTRIES) return;

    const kept = lines.slice(lines.length - MAX_AUDIT_ENTRIES);
    fs.writeFileSync(AUDIT_FILE, kept.join('\n') + '\n');
  } catch {
    /* best-effort */
  }
}

export function getAuditFilePath(): string {
  return AUDIT_FILE;
}

export function readAudit(): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n');
    const out: AuditEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Pull the last user message from a Dialogue history, flatten, and strip newlines. */
export function extractLastUserPrompt(history: Array<{ role: string; content: unknown }>): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'user') continue;
    const text = flattenContent(msg.content);
    if (!text) continue;
    const cleaned = text.replace(/\s+/g, ' ').trim();
    // Anthropic's message format puts harness-injected context, guardrail
    // warnings, and grounding-retry feedback under role:"user" too. Walking
    // back blindly returns those synthetic strings instead of the real user
    // intent — verified 2026-05-06 in the audit log: 403 entries showed
    // "[FRANKLIN HARNESS PREFETCH] CRCL price..." and 18 showed
    // "[GROUNDING CHECK FAILED] ..." instead of the user's actual question.
    // Skip any message whose first non-whitespace block is a SCREAMING-CASE
    // bracketed label and keep walking back to the real user turn.
    if (/^\[[A-Z][A-Z _-]+\]/.test(cleaned)) continue;
    return cleaned;
  }
  return undefined;
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string };
      // Skip tool_result blocks — they're tool output, not user intent
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join(' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
