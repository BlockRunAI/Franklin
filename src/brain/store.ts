/**
 * Franklin Brain — JSONL storage for entities, observations, relations.
 * All in-memory with JSONL persistence. No database.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
import type { Entity, EntityType, Observation, Relation } from './types.js';

const BRAIN_DIR = path.join(BLOCKRUN_DIR, 'brain');
const ENTITIES_FILE = path.join(BRAIN_DIR, 'entities.jsonl');
const OBSERVATIONS_FILE = path.join(BRAIN_DIR, 'observations.jsonl');
const RELATIONS_FILE = path.join(BRAIN_DIR, 'relations.jsonl');
const MAX_ENTITIES = 200;
// Observations and relations were previously unbounded — `extract.ts`
// runs at every session end (commands/start.ts:515) so they grew
// linearly forever. Caps below give comfortable headroom for a year+
// of normal use without making per-entity scans pathological:
//  - 2000 obs / 200 entities = ~10 observations per entity on average
//  - 500 relations covers heavy cross-references between the entity set
// On cap breach we drop the oldest entries — younger observations are
// usually more relevant and more confident than an aging one.
const MAX_OBSERVATIONS = 2000;
const MAX_RELATIONS = 500;

function uid(): string { return crypto.randomBytes(8).toString('hex'); }

function ensureDir(): void {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
}

// ─── Generic JSONL helpers ────────────────────────────────────────────────

function loadJsonl<T>(file: string): T[] {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const results: T[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { results.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
    return results;
  } catch { return []; }
}

function saveJsonl<T>(file: string, items: T[]): void {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, items.map(i => JSON.stringify(i)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

function appendJsonl<T>(file: string, item: T): void {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(item) + '\n');
}

// ─── Entities ─────────────────────────────────────────────────────────────

export function loadEntities(): Entity[] {
  return loadJsonl<Entity>(ENTITIES_FILE);
}

export function saveEntities(entities: Entity[]): void {
  saveJsonl(ENTITIES_FILE, entities);
}

/**
 * Find entity by name or alias (case-insensitive).
 */
export function findEntity(entities: Entity[], nameOrAlias: string): Entity | undefined {
  const lower = nameOrAlias.toLowerCase().trim();
  return entities.find(e =>
    e.name.toLowerCase() === lower ||
    e.aliases.some(a => a.toLowerCase() === lower)
  );
}

/**
 * Create or update an entity. Returns the entity ID.
 * If an entity with a matching name/alias exists, merges aliases and bumps reference_count.
 */
export function upsertEntity(
  entities: Entity[],
  name: string,
  type: EntityType,
  aliases: string[] = [],
): string {
  const existing = findEntity(entities, name) ||
    aliases.map(a => findEntity(entities, a)).find(Boolean);

  if (existing) {
    // Merge aliases
    const allAliases = new Set([...existing.aliases, ...aliases, name]);
    allAliases.delete(existing.name); // Don't alias canonical name
    existing.aliases = [...allAliases];
    existing.reference_count++;
    existing.updated_at = Date.now();
    return existing.id;
  }

  // New entity
  const entity: Entity = {
    id: uid(),
    type,
    name,
    aliases: aliases.filter(a => a.toLowerCase() !== name.toLowerCase()),
    created_at: Date.now(),
    updated_at: Date.now(),
    reference_count: 1,
  };
  entities.push(entity);

  // Cap at MAX_ENTITIES — prune least-referenced
  if (entities.length > MAX_ENTITIES) {
    entities.sort((a, b) => b.reference_count - a.reference_count);
    entities.length = MAX_ENTITIES;
  }

  return entity.id;
}

// ─── Observations ─────────────────────────────────────────────────────────

export function loadObservations(): Observation[] {
  return loadJsonl<Observation>(OBSERVATIONS_FILE);
}

export function getEntityObservations(entityId: string): Observation[] {
  return loadObservations().filter(o => o.entity_id === entityId);
}

/**
 * Add an observation. Deduplicates by content similarity (exact match).
 */
export function addObservation(
  entityId: string,
  content: string,
  source: string,
  confidence = 0.8,
  tags: string[] = ['fact'],
): void {
  const existing = loadObservations();
  const contentLower = content.toLowerCase().trim();

  // Skip exact duplicates for this entity
  if (existing.some(o => o.entity_id === entityId && o.content.toLowerCase().trim() === contentLower)) {
    return;
  }

  const next: Observation = {
    id: uid(),
    entity_id: entityId,
    content,
    source,
    confidence,
    tags,
    created_at: Date.now(),
  };

  // Cap reached — rewrite the file with the trimmed set instead of
  // appending. saveJsonl is atomic (tmp + rename) so a crash mid-write
  // can't corrupt observations.
  if (existing.length >= MAX_OBSERVATIONS) {
    existing.sort((a, b) => b.created_at - a.created_at);
    existing.length = MAX_OBSERVATIONS - 1;
    existing.unshift(next);
    saveJsonl(OBSERVATIONS_FILE, existing);
    return;
  }

  appendJsonl(OBSERVATIONS_FILE, next);
}

// ─── Relations ────────────────────────────────────────────────────────────

export function loadRelations(): Relation[] {
  return loadJsonl<Relation>(RELATIONS_FILE);
}

export function getEntityRelations(entityId: string): Relation[] {
  return loadRelations().filter(r => r.from_id === entityId || r.to_id === entityId);
}

/**
 * Add or update a relation. If same from+to+type exists, bumps count.
 */
export function upsertRelation(fromId: string, toId: string, type: string, confidence = 0.8): void {
  const relations = loadRelations();
  const existing = relations.find(r => r.from_id === fromId && r.to_id === toId && r.type === type);

  if (existing) {
    existing.count++;
    existing.last_seen = Date.now();
    existing.confidence = Math.min(existing.confidence + 0.05, 1.0);
    saveJsonl(RELATIONS_FILE, relations);
  } else {
    const next: Relation = {
      id: uid(),
      from_id: fromId,
      to_id: toId,
      type,
      confidence,
      count: 1,
      last_seen: Date.now(),
    };
    // Same cap pattern as observations. When the relation set is at
    // its ceiling we drop the lowest-count, oldest-seen entries to
    // make room — count + recency together approximate "this
    // relation is still being seen", so eviction targets entries the
    // brain extractor hasn't reinforced in a while.
    if (relations.length >= MAX_RELATIONS) {
      relations.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return b.last_seen - a.last_seen;
      });
      relations.length = MAX_RELATIONS - 1;
      relations.unshift(next);
      saveJsonl(RELATIONS_FILE, relations);
    } else {
      appendJsonl(RELATIONS_FILE, next);
    }
  }
}

// ─── Search ───────────────────────────────────────────────────────────────

/**
 * Search entities by name/alias substring match.
 */
export function searchEntities(query: string, limit = 10): Entity[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];

  return loadEntities()
    .filter(e =>
      e.name.toLowerCase().includes(lower) ||
      e.aliases.some(a => a.toLowerCase().includes(lower))
    )
    .sort((a, b) => b.reference_count - a.reference_count)
    .slice(0, limit);
}

// ─── Context building (for system prompt injection) ───────────────────────

const MAX_BRAIN_CHARS = 1500;

/**
 * Build context string for entities mentioned in the conversation.
 * Returns empty string if no relevant entities found.
 */
export function buildEntityContext(
  mentionedNames: string[],
  entitiesCache?: Entity[],
): string {
  if (mentionedNames.length === 0) return '';

  const entities = entitiesCache ?? loadEntities();
  const matched: Entity[] = [];

  for (const name of mentionedNames) {
    const entity = findEntity(entities, name);
    if (entity) matched.push(entity);
  }

  if (matched.length === 0) return '';

  // Load observations + relations ONCE and index by entity_id / endpoint
  // rather than re-reading the JSONL for each matched entity. With N matches
  // the old path did 2N file reads per turn; this is now 2 reads total.
  const allObs = loadObservations();
  const allRels = loadRelations();
  const obsByEntity = new Map<string, Observation[]>();
  for (const o of allObs) {
    const list = obsByEntity.get(o.entity_id);
    if (list) list.push(o);
    else obsByEntity.set(o.entity_id, [o]);
  }
  const relsByEntity = new Map<string, Relation[]>();
  for (const r of allRels) {
    const fromList = relsByEntity.get(r.from_id);
    if (fromList) fromList.push(r); else relsByEntity.set(r.from_id, [r]);
    const toList = relsByEntity.get(r.to_id);
    if (toList) toList.push(r); else relsByEntity.set(r.to_id, [r]);
  }

  const lines: string[] = ['# Known Entities'];
  let chars = lines[0].length;

  for (const entity of matched) {
    const observations = (obsByEntity.get(entity.id) ?? [])
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
    const relations = relsByEntity.get(entity.id) ?? [];

    const header = `\n## ${entity.name} (${entity.type})`;
    if (chars + header.length > MAX_BRAIN_CHARS) break;
    lines.push(header);
    chars += header.length;

    for (const obs of observations) {
      const line = `- ${obs.content}`;
      if (chars + line.length + 1 > MAX_BRAIN_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }

    for (const rel of relations.slice(0, 3)) {
      const otherId = rel.from_id === entity.id ? rel.to_id : rel.from_id;
      const otherEntity = entities.find(e => e.id === otherId);
      if (!otherEntity) continue;
      const line = `- ${rel.type} → ${otherEntity.name}`;
      if (chars + line.length + 1 > MAX_BRAIN_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

// ─── Mention extraction (for auto-recall) ────────────────────────────────

/**
 * Scan `text` for occurrences of any known entity's canonical name or alias
 * and return the matched canonical names (deduped, case-preserving).
 * Word-boundary match so "Base" in "Baseline" doesn't match entity "Base".
 *
 * This is the read half of the brain — the agent loop calls this on each
 * user turn to decide which entities to auto-inject into the system prompt.
 *
 * Pass `entities` if the caller already has them loaded to avoid re-reading
 * the JSONL; otherwise we load it ourselves.
 */
export function extractMentions(text: string, entities?: Entity[]): string[] {
  if (!text) return [];
  const pool = entities ?? loadEntities();
  if (pool.length === 0) return [];
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const e of pool) {
    const candidates = [e.name, ...e.aliases];
    for (const c of candidates) {
      const needle = c.toLowerCase();
      if (needle.length < 2) continue;
      // Word boundary: require a non-alphanumeric char (or start/end of string)
      // on each side of the match. Prevents "ai" matching inside "chain".
      const idx = lower.indexOf(needle);
      if (idx === -1) continue;
      const before = idx === 0 ? '' : lower[idx - 1];
      const after = idx + needle.length >= lower.length ? '' : lower[idx + needle.length];
      const wordChar = /[a-z0-9_]/;
      if (wordChar.test(before) || wordChar.test(after)) continue;
      out.add(e.name);
      break; // one match per entity is enough
    }
  }
  return [...out];
}

// ─── Stats ────────────────────────────────────────────────────────────────

export function getBrainStats(): { entities: number; observations: number; relations: number } {
  return {
    entities: loadEntities().length,
    observations: loadObservations().length,
    relations: loadRelations().length,
  };
}
