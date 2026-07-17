/**
 * Document-memory search — pure-TS chunked TF scoring (no native deps).
 *
 * Chunks of ~1600 chars with 320 overlap; term-frequency scoring reusing
 * the session-search tokenizer; TEMPORAL DECAY applies ONLY to session-log
 * chunks (half-life 7 days) — curated global/workspace/trading files are
 * long-term knowledge and never decay. Old session hits carry a staleness
 * note so the model verifies before trusting. An mtime-keyed cache keeps
 * re-index cost at zero for unchanged files.
 */

import fs from 'node:fs';
import { parseQuery, tokenize } from '../session/search.js';
import { listMemoryFiles, memoryEnabled, type MemoryFileRef } from './store.js';

export const CHUNK_CHARS = 1600;
export const CHUNK_OVERLAP = 320;
export const SESSION_HALF_LIFE_DAYS = 7;
const STALE_AFTER_DAYS = 3;

interface MemoryChunk {
  file: string;
  scope: MemoryFileRef['scope'];
  mtimeMs: number;
  text: string;
  tokens: Map<string, number>;
}

export interface MemoryHit {
  file: string;
  scope: MemoryFileRef['scope'];
  snippet: string;
  score: number;
  /** Present on old session hits — surfaced verbatim to the model. */
  stalenessNote?: string;
}

// mtime-keyed chunk cache per file.
const chunkCache = new Map<string, { mtimeMs: number; chunks: MemoryChunk[] }>();

export function resetMemoryIndexCache(): void {
  chunkCache.clear();
}

function chunkFile(ref: MemoryFileRef): MemoryChunk[] {
  const cached = chunkCache.get(ref.path);
  if (cached && cached.mtimeMs === ref.mtimeMs) return cached.chunks;

  let content = '';
  try {
    content = fs.readFileSync(ref.path, 'utf-8');
  } catch {
    return [];
  }

  const chunks: MemoryChunk[] = [];
  for (let start = 0; start < content.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const text = content.slice(start, start + CHUNK_CHARS);
    if (!text.trim()) continue;
    const tokens = new Map<string, number>();
    for (const tok of tokenize(text)) {
      tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
    }
    chunks.push({ file: ref.path, scope: ref.scope, mtimeMs: ref.mtimeMs, text, tokens });
    if (text.length < CHUNK_CHARS) break;
  }
  chunkCache.set(ref.path, { mtimeMs: ref.mtimeMs, chunks });
  return chunks;
}

function ageDays(mtimeMs: number): number {
  return Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
}

function scoreChunk(chunk: MemoryChunk, terms: string[], phrases: string[]): number {
  let score = 0;
  for (const term of terms) {
    const tf = chunk.tokens.get(term) ?? 0;
    if (tf > 0) score += 1 + Math.log(1 + tf);
  }
  const lower = chunk.text.toLowerCase();
  for (const phrase of phrases) {
    if (lower.includes(phrase.toLowerCase())) score += 3;
  }
  if (score === 0) return 0;

  if (chunk.scope === 'session') {
    // Exponential half-life decay — ephemeral observations fade.
    score *= Math.pow(0.5, ageDays(chunk.mtimeMs) / SESSION_HALF_LIFE_DAYS);
  }
  return score;
}

function snippetAround(text: string, terms: string[], maxLen = 280): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term);
    if (at !== -1) break;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - Math.floor(maxLen / 3));
  const cut = text.slice(start, start + maxLen).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + maxLen < text.length ? '…' : ''}`;
}

export function searchMemory(
  query: string,
  workDir: string,
  opts: { limit?: number; minScore?: number } = {}
): MemoryHit[] {
  if (!memoryEnabled()) return [];
  const { terms, phrases } = parseQuery(query);
  if (terms.length === 0 && phrases.length === 0) return [];

  const limit = opts.limit ?? 6;
  const minScore = opts.minScore ?? 0.5;
  const hits: MemoryHit[] = [];

  for (const ref of listMemoryFiles(workDir)) {
    for (const chunk of chunkFile(ref)) {
      const score = scoreChunk(chunk, terms, phrases);
      if (score < minScore) continue;
      const hit: MemoryHit = {
        file: ref.path,
        scope: ref.scope,
        snippet: snippetAround(chunk.text, terms),
        score,
      };
      if (ref.scope === 'session' && ageDays(ref.mtimeMs) > STALE_AFTER_DAYS) {
        const days = Math.round(ageDays(ref.mtimeMs));
        hit.stalenessNote = `note: this is a session memory from ~${days} days ago — verify current state before relying on it`;
      }
      hits.push(hit);
    }
  }

  hits.sort((a, b) => b.score - a.score);
  // One hit per file — chunk overlap otherwise floods the result set with
  // near-duplicates from the same document.
  const seen = new Set<string>();
  const deduped: MemoryHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.file)) continue;
    seen.add(hit.file);
    deduped.push(hit);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

/** Compact context block for prompt injection; ~1.5k-token budget. */
export function formatMemoryContext(hits: MemoryHit[], budgetChars = 6000): string {
  if (hits.length === 0) return '';
  const lines: string[] = ['<memory-recall>'];
  let used = 0;
  for (const hit of hits) {
    const entry = `[${hit.scope}] ${hit.snippet}${hit.stalenessNote ? `\n  (${hit.stalenessNote})` : ''}`;
    if (used + entry.length > budgetChars) break;
    lines.push(entry);
    used += entry.length;
  }
  lines.push('</memory-recall>');
  return lines.length > 2 ? lines.join('\n') : '';
}
