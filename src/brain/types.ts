/**
 * Franklin Brain — entity-based knowledge graph.
 * Inspired by GBrain (Garry Tan). Lightweight JSONL, no database.
 */

export type EntityType = 'person' | 'project' | 'company' | 'product' | 'concept';

export interface Entity {
  id: string;
  type: EntityType;
  name: string;               // canonical name
  aliases: string[];          // alternative names, handles, abbreviations
  created_at: number;         // epoch ms
  updated_at: number;
  reference_count: number;    // how many times referenced across sessions
}

export interface Observation {
  id: string;
  entity_id: string;
  content: string;            // "Founded BlockRun in 2025"
  source: string;             // session ID, "bootstrap", URL
  confidence: number;         // 0.0–1.0
  tags: string[];             // "fact", "preference", "role", "event"
  created_at: number;
}

export interface Relation {
  id: string;
  from_id: string;            // entity ID
  to_id: string;              // entity ID
  type: string;               // "founded", "works_on", "partnered_with", "replied_to"
  confidence: number;
  count: number;              // times observed
  last_seen: number;          // epoch ms
}

export interface BrainExtraction {
  entities: Array<{
    name: string;
    type: EntityType;
    aliases?: string[];
    observations: string[];
  }>;
  relations: Array<{
    from: string;             // entity name
    to: string;               // entity name
    type: string;
  }>;
}
