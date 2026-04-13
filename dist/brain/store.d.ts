/**
 * Franklin Brain — JSONL storage for entities, observations, relations.
 * All in-memory with JSONL persistence. No database.
 */
import type { Entity, EntityType, Observation, Relation } from './types.js';
export declare function loadEntities(): Entity[];
export declare function saveEntities(entities: Entity[]): void;
/**
 * Find entity by name or alias (case-insensitive).
 */
export declare function findEntity(entities: Entity[], nameOrAlias: string): Entity | undefined;
/**
 * Create or update an entity. Returns the entity ID.
 * If an entity with a matching name/alias exists, merges aliases and bumps reference_count.
 */
export declare function upsertEntity(entities: Entity[], name: string, type: EntityType, aliases?: string[]): string;
export declare function loadObservations(): Observation[];
export declare function getEntityObservations(entityId: string): Observation[];
/**
 * Add an observation. Deduplicates by content similarity (exact match).
 */
export declare function addObservation(entityId: string, content: string, source: string, confidence?: number, tags?: string[]): void;
export declare function loadRelations(): Relation[];
export declare function getEntityRelations(entityId: string): Relation[];
/**
 * Add or update a relation. If same from+to+type exists, bumps count.
 */
export declare function upsertRelation(fromId: string, toId: string, type: string, confidence?: number): void;
/**
 * Search entities by name/alias substring match.
 */
export declare function searchEntities(query: string, limit?: number): Entity[];
/**
 * Build context string for entities mentioned in the conversation.
 * Returns empty string if no relevant entities found.
 */
export declare function buildEntityContext(mentionedNames: string[]): string;
export declare function getBrainStats(): {
    entities: number;
    observations: number;
    relations: number;
};
