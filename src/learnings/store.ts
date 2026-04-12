/**
 * Persistence layer for per-user learnings.
 * Stored as JSONL at ~/.blockrun/learnings.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import type { Learning, LearningCategory } from './types.js';

const LEARNINGS_PATH = path.join(BLOCKRUN_DIR, 'learnings.jsonl');
const MAX_LEARNINGS = 50;
const DECAY_AFTER_DAYS = 30;
const DECAY_AMOUNT = 0.15;
const PRUNE_THRESHOLD = 0.2;
const MERGE_SIMILARITY = 0.6;

// ─── Load / Save ──────────────────────────────────────────────────────────

export function loadLearnings(): Learning[] {
  try {
    const raw = fs.readFileSync(LEARNINGS_PATH, 'utf-8');
    const results: Learning[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { results.push(JSON.parse(line)); } catch { /* skip corrupted lines */ }
    }
    return results;
  } catch {
    return [];
  }
}

export function saveLearnings(learnings: Learning[]): void {
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  const tmpPath = LEARNINGS_PATH + '.tmp';
  const content = learnings.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, LEARNINGS_PATH);
}

// ─── Merge / Dedup ────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function mergeLearning(
  existing: Learning[],
  newEntry: { learning: string; category: LearningCategory; confidence: number; source_session: string },
): Learning[] {
  const now = Date.now();
  const newTokens = tokenize(newEntry.learning);

  // Find similar existing learning in same category
  for (const entry of existing) {
    if (entry.category !== newEntry.category) continue;
    const similarity = jaccardSimilarity(tokenize(entry.learning), newTokens);
    if (similarity >= MERGE_SIMILARITY) {
      // Merge: boost confidence, update timestamp
      entry.times_confirmed++;
      entry.last_confirmed = now;
      entry.confidence = Math.min(entry.confidence + 0.1, 1.0);
      // Prefer more specific wording
      if (newEntry.learning.length > entry.learning.length) {
        entry.learning = newEntry.learning;
      }
      return existing;
    }
  }

  // No match — insert new
  existing.push({
    id: crypto.randomBytes(8).toString('hex'),
    learning: newEntry.learning,
    category: newEntry.category,
    confidence: newEntry.confidence,
    source_session: newEntry.source_session,
    created_at: now,
    last_confirmed: now,
    times_confirmed: 1,
  });

  // Cap at MAX_LEARNINGS — drop lowest-scoring
  if (existing.length > MAX_LEARNINGS) {
    existing.sort((a, b) => score(b) - score(a));
    existing.length = MAX_LEARNINGS;
  }

  return existing;
}

function score(l: Learning): number {
  return l.confidence * Math.log2(l.times_confirmed + 1);
}

// ─── Decay ────────────────────────────────────────────────────────────────

export function decayLearnings(learnings: Learning[]): Learning[] {
  const now = Date.now();
  const cutoff = DECAY_AFTER_DAYS * 24 * 60 * 60 * 1000;

  return learnings.filter(l => {
    if (l.times_confirmed >= 3) return true; // Immune to time decay
    if (now - l.last_confirmed > cutoff) {
      l.confidence -= DECAY_AMOUNT;
      return l.confidence >= PRUNE_THRESHOLD;
    }
    return true;
  });
}

// ─── Format for System Prompt ─────────────────────────────────────────────

const MAX_PROMPT_CHARS = 2000; // ~500 tokens

export function formatForPrompt(learnings: Learning[]): string {
  if (learnings.length === 0) return '';

  const sorted = [...learnings].sort((a, b) => score(b) - score(a));
  const lines: string[] = [];
  let chars = 0;
  const header = '# Personal Context\nPreferences learned from previous sessions:\n';
  chars += header.length;

  for (const l of sorted) {
    const conf = l.confidence >= 0.8 ? '●' : l.confidence >= 0.5 ? '◐' : '○';
    const line = `- ${conf} ${l.learning}`;
    if (chars + line.length + 1 > MAX_PROMPT_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }

  if (lines.length === 0) return '';
  return header + lines.join('\n');
}
