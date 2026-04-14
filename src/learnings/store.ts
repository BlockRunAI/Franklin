/**
 * Persistence layer for per-user learnings.
 * Stored as JSONL at ~/.blockrun/learnings.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import type { Learning, LearningCategory, Skill } from './types.js';

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

  // Separate negative learnings (highest priority) from others
  const negative = learnings.filter(l => l.category === 'negative');
  const projectCtx = learnings.filter(l => l.category === 'project_context');
  const preferences = learnings.filter(l => l.category !== 'negative' && l.category !== 'project_context');

  const sections: string[] = [];
  let chars = 0;

  // Negative learnings first (most important — prevents repeating mistakes)
  if (negative.length > 0) {
    const negSorted = [...negative].sort((a, b) => score(b) - score(a));
    const negLines = negSorted
      .filter(l => { if (chars + l.learning.length + 5 > MAX_PROMPT_CHARS) return false; chars += l.learning.length + 5; return true; })
      .map(l => `- ⛔ ${l.learning}`);
    if (negLines.length > 0) {
      sections.push('## Rules (from past corrections)\n' + negLines.join('\n'));
    }
  }

  // Project context
  if (projectCtx.length > 0) {
    const ctxSorted = [...projectCtx].sort((a, b) => score(b) - score(a));
    const ctxLines = ctxSorted
      .filter(l => { if (chars + l.learning.length + 5 > MAX_PROMPT_CHARS) return false; chars += l.learning.length + 5; return true; })
      .map(l => `- ${l.learning}`);
    if (ctxLines.length > 0) {
      sections.push('## Project Context\n' + ctxLines.join('\n'));
    }
  }

  // General preferences
  if (preferences.length > 0) {
    const prefSorted = [...preferences].sort((a, b) => score(b) - score(a));
    const prefLines = prefSorted
      .filter(l => { if (chars + l.learning.length + 5 > MAX_PROMPT_CHARS) return false; chars += l.learning.length + 5; return true; })
      .map(l => {
        const conf = l.confidence >= 0.8 ? '●' : l.confidence >= 0.5 ? '◐' : '○';
        return `- ${conf} ${l.learning}`;
      });
    if (prefLines.length > 0) {
      sections.push('## Preferences\n' + prefLines.join('\n'));
    }
  }

  if (sections.length === 0) return '';
  return '# Personal Context\nLearned from previous sessions:\n\n' + sections.join('\n\n');
}

// ─── Skills (procedural memory) ──────────────────────────────────────────
// Stored as individual markdown files in ~/.blockrun/skills/
// Larger than learnings, conditionally injected based on trigger matching.

const SKILLS_DIR = path.join(BLOCKRUN_DIR, 'skills');
const MAX_SKILLS_IN_PROMPT = 5;
const MAX_SKILL_CHARS = 1500;

function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

/** Load all skills from disk. */
export function loadSkills(): Skill[] {
  ensureSkillsDir();
  const skills: Skill[] = [];
  try {
    for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))) {
      try {
        const raw = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf-8');
        const skill = parseSkillFile(raw);
        if (skill) skills.push(skill);
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return skills;
}

function parseSkillFile(raw: string): Skill | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  const triggersRaw = fm.match(/^triggers:\s*\[([^\]]*)\]/m)?.[1] || '';
  const triggers = triggersRaw.split(',').map(t => t.trim()).filter(Boolean);
  const created = fm.match(/^created:\s*(.+)$/m)?.[1]?.trim() || '';
  const uses = parseInt(fm.match(/^uses:\s*(\d+)$/m)?.[1] || '0');
  const source = fm.match(/^source_session:\s*(.+)$/m)?.[1]?.trim() || '';
  if (!name) return null;
  return { name, description, triggers, steps: m[2].trim(), created, uses, source_session: source };
}

/** Save a new skill to disk. */
export function saveSkill(skill: Skill): void {
  ensureSkillsDir();
  const filename = skill.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.md';
  const fm = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `triggers: [${skill.triggers.join(', ')}]`,
    `created: ${skill.created}`,
    `uses: ${skill.uses}`,
    `source_session: ${skill.source_session}`,
    '---',
  ].join('\n');
  fs.writeFileSync(path.join(SKILLS_DIR, filename), `${fm}\n${skill.steps}\n`);
}

/** Bump use count for a skill. */
export function bumpSkillUse(skill: Skill): void {
  const filename = skill.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.md';
  const fp = path.join(SKILLS_DIR, filename);
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    fs.writeFileSync(fp, raw.replace(/^uses:\s*\d+$/m, `uses: ${skill.uses + 1}`));
  } catch { /* non-critical */ }
}

/** Find skills relevant to a user message, by trigger matching. */
export function matchSkills(input: string, skills: Skill[]): Skill[] {
  const lower = input.toLowerCase();
  const scored: Array<{ skill: Skill; score: number }> = [];
  for (const s of skills) {
    let score = 0;
    for (const t of s.triggers) {
      if (lower.includes(t.toLowerCase())) score += 2;
    }
    if (lower.includes(s.name.toLowerCase())) score += 3;
    score += Math.min(s.uses * 0.5, 3);
    if (score > 0) scored.push({ skill: s, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SKILLS_IN_PROMPT).map(m => m.skill);
}

/** Format matched skills for system prompt injection. */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const parts = ['# Learned Skills\nProcedures from previous experience — use when relevant:\n'];
  for (const s of skills) {
    const body = s.steps.length > MAX_SKILL_CHARS ? s.steps.slice(0, MAX_SKILL_CHARS) + '\n…' : s.steps;
    parts.push(`## ${s.name}\n*${s.description}*\n\n${body}`);
  }
  return parts.join('\n\n');
}
