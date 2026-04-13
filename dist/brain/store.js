/**
 * Franklin Brain — JSONL storage for entities, observations, relations.
 * All in-memory with JSONL persistence. No database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOCKRUN_DIR } from '../config.js';
const BRAIN_DIR = path.join(BLOCKRUN_DIR, 'brain');
const ENTITIES_FILE = path.join(BRAIN_DIR, 'entities.jsonl');
const OBSERVATIONS_FILE = path.join(BRAIN_DIR, 'observations.jsonl');
const RELATIONS_FILE = path.join(BRAIN_DIR, 'relations.jsonl');
const MAX_ENTITIES = 200;
function uid() { return crypto.randomBytes(8).toString('hex'); }
function ensureDir() {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
}
// ─── Generic JSONL helpers ────────────────────────────────────────────────
function loadJsonl(file) {
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const results = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                results.push(JSON.parse(line));
            }
            catch { /* skip corrupt */ }
        }
        return results;
    }
    catch {
        return [];
    }
}
function saveJsonl(file, items) {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, items.map(i => JSON.stringify(i)).join('\n') + '\n');
    fs.renameSync(tmp, file);
}
function appendJsonl(file, item) {
    ensureDir();
    fs.appendFileSync(file, JSON.stringify(item) + '\n');
}
// ─── Entities ─────────────────────────────────────────────────────────────
export function loadEntities() {
    return loadJsonl(ENTITIES_FILE);
}
export function saveEntities(entities) {
    saveJsonl(ENTITIES_FILE, entities);
}
/**
 * Find entity by name or alias (case-insensitive).
 */
export function findEntity(entities, nameOrAlias) {
    const lower = nameOrAlias.toLowerCase().trim();
    return entities.find(e => e.name.toLowerCase() === lower ||
        e.aliases.some(a => a.toLowerCase() === lower));
}
/**
 * Create or update an entity. Returns the entity ID.
 * If an entity with a matching name/alias exists, merges aliases and bumps reference_count.
 */
export function upsertEntity(entities, name, type, aliases = []) {
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
    const entity = {
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
export function loadObservations() {
    return loadJsonl(OBSERVATIONS_FILE);
}
export function getEntityObservations(entityId) {
    return loadObservations().filter(o => o.entity_id === entityId);
}
/**
 * Add an observation. Deduplicates by content similarity (exact match).
 */
export function addObservation(entityId, content, source, confidence = 0.8, tags = ['fact']) {
    const existing = loadObservations();
    const contentLower = content.toLowerCase().trim();
    // Skip exact duplicates for this entity
    if (existing.some(o => o.entity_id === entityId && o.content.toLowerCase().trim() === contentLower)) {
        return;
    }
    appendJsonl(OBSERVATIONS_FILE, {
        id: uid(),
        entity_id: entityId,
        content,
        source,
        confidence,
        tags,
        created_at: Date.now(),
    });
}
// ─── Relations ────────────────────────────────────────────────────────────
export function loadRelations() {
    return loadJsonl(RELATIONS_FILE);
}
export function getEntityRelations(entityId) {
    return loadRelations().filter(r => r.from_id === entityId || r.to_id === entityId);
}
/**
 * Add or update a relation. If same from+to+type exists, bumps count.
 */
export function upsertRelation(fromId, toId, type, confidence = 0.8) {
    const relations = loadRelations();
    const existing = relations.find(r => r.from_id === fromId && r.to_id === toId && r.type === type);
    if (existing) {
        existing.count++;
        existing.last_seen = Date.now();
        existing.confidence = Math.min(existing.confidence + 0.05, 1.0);
        saveJsonl(RELATIONS_FILE, relations);
    }
    else {
        appendJsonl(RELATIONS_FILE, {
            id: uid(),
            from_id: fromId,
            to_id: toId,
            type,
            confidence,
            count: 1,
            last_seen: Date.now(),
        });
    }
}
// ─── Search ───────────────────────────────────────────────────────────────
/**
 * Search entities by name/alias substring match.
 */
export function searchEntities(query, limit = 10) {
    const lower = query.toLowerCase().trim();
    if (!lower)
        return [];
    return loadEntities()
        .filter(e => e.name.toLowerCase().includes(lower) ||
        e.aliases.some(a => a.toLowerCase().includes(lower)))
        .sort((a, b) => b.reference_count - a.reference_count)
        .slice(0, limit);
}
// ─── Context building (for system prompt injection) ───────────────────────
const MAX_BRAIN_CHARS = 1500;
/**
 * Build context string for entities mentioned in the conversation.
 * Returns empty string if no relevant entities found.
 */
export function buildEntityContext(mentionedNames) {
    if (mentionedNames.length === 0)
        return '';
    const entities = loadEntities();
    const matched = [];
    for (const name of mentionedNames) {
        const entity = findEntity(entities, name);
        if (entity)
            matched.push(entity);
    }
    if (matched.length === 0)
        return '';
    const lines = ['# Known Entities'];
    let chars = lines[0].length;
    for (const entity of matched) {
        const observations = getEntityObservations(entity.id)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5);
        const relations = getEntityRelations(entity.id);
        const header = `\n## ${entity.name} (${entity.type})`;
        if (chars + header.length > MAX_BRAIN_CHARS)
            break;
        lines.push(header);
        chars += header.length;
        for (const obs of observations) {
            const line = `- ${obs.content}`;
            if (chars + line.length + 1 > MAX_BRAIN_CHARS)
                break;
            lines.push(line);
            chars += line.length + 1;
        }
        for (const rel of relations.slice(0, 3)) {
            const otherEntity = entities.find(e => e.id === (rel.from_id === entity.id ? rel.to_id : rel.from_id));
            if (!otherEntity)
                continue;
            const line = `- ${rel.type} → ${otherEntity.name}`;
            if (chars + line.length + 1 > MAX_BRAIN_CHARS)
                break;
            lines.push(line);
            chars += line.length + 1;
        }
    }
    return lines.length > 1 ? lines.join('\n') : '';
}
// ─── Stats ────────────────────────────────────────────────────────────────
export function getBrainStats() {
    return {
        entities: loadEntities().length,
        observations: loadObservations().length,
        relations: loadRelations().length,
    };
}
