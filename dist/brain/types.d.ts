/**
 * Franklin Brain — entity-based knowledge graph.
 * Inspired by GBrain (Garry Tan). Lightweight JSONL, no database.
 */
export type EntityType = 'person' | 'project' | 'company' | 'product' | 'concept';
export interface Entity {
    id: string;
    type: EntityType;
    name: string;
    aliases: string[];
    created_at: number;
    updated_at: number;
    reference_count: number;
}
export interface Observation {
    id: string;
    entity_id: string;
    content: string;
    source: string;
    confidence: number;
    tags: string[];
    created_at: number;
}
export interface Relation {
    id: string;
    from_id: string;
    to_id: string;
    type: string;
    confidence: number;
    count: number;
    last_seen: number;
}
export interface BrainExtraction {
    entities: Array<{
        name: string;
        type: EntityType;
        aliases?: string[];
        observations: string[];
    }>;
    relations: Array<{
        from: string;
        to: string;
        type: string;
    }>;
}
