/**
 * Franklin Brain — entity extraction from session traces.
 * Uses cheap model to detect people, projects, companies from conversation.
 */

import { ModelClient } from '../agent/llm.js';
import type { Dialogue } from '../agent/types.js';
import type { Entity, BrainExtraction, EntityType } from './types.js';
import {
  loadEntities, saveEntities, upsertEntity,
  addObservation, upsertRelation, isJunkEntityName,
} from './store.js';

const EXTRACTION_MODELS = [
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-flash',
  'nvidia/nemotron-super-49b',
];

const VALID_TYPES = new Set<EntityType>(['person', 'project', 'company', 'product', 'concept']);


const BRAIN_PROMPT = `You are analyzing a conversation between a user and an AI agent. Extract entities (people, projects, companies, products, concepts) mentioned in the conversation.

For each entity, provide:
- name: canonical name (e.g. "Garry Tan" not "garry" or "Garry")
- type: person | project | company | product | concept
- aliases: other names used for the same entity (handles, abbreviations)
- observations: 1-3 facts learned about this entity from the conversation

Also extract relationships between entities:
- from: entity name
- to: entity name
- type: founded | works_on | partnered_with | uses | mentioned | replied_to | depends_on

Rules:
- Only extract entities with CLEAR evidence in the conversation.
- Do NOT extract the AI agent itself or generic concepts ("TypeScript", "JavaScript").
- Do NOT extract programmatic strings that happen to appear in the transcript: tool permission patterns like "Bash(git commit:*)", object URIs (gs://, s3://, file://), glob patterns (paths with **), task IDs (t_xxx_xxx), session IDs, or hashes/UUIDs.
- DO extract specific people, specific projects, specific companies, specific products.
- Observations must be concrete facts about the entity that would be useful in a future conversation. Do NOT include tautologies that restate the entity name ("This is a task ID for an ETL process") or generic statements that apply to any instance of the type.
- If no entities are found, return empty arrays.

Respond with ONLY a JSON object (no markdown fences):
{"entities":[{"name":"...","type":"person","aliases":["@handle"],"observations":["Founded X in 2025"]}],"relations":[{"from":"Person","to":"Project","type":"founded"}]}`;

function condenseForBrain(history: Dialogue[]): string {
  const parts: string[] = [];
  let chars = 0;
  for (const msg of history) {
    if (chars >= 3000) break;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('\n');
    }
    if (!text.trim()) continue;
    if (text.length > 400) text = text.slice(0, 400) + '…';
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const line = `${role}: ${text}`;
    parts.push(line);
    chars += line.length;
  }
  return parts.join('\n\n');
}

function parseExtraction(raw: string): BrainExtraction {
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { entities: [], relations: [] };
  cleaned = cleaned.slice(start, end + 1);

  try {
    const parsed = JSON.parse(cleaned);

    const entities = (parsed.entities || [])
      .filter((e: Record<string, unknown>) =>
        typeof e.name === 'string' && e.name.length > 1 &&
        typeof e.type === 'string' && VALID_TYPES.has(e.type as EntityType) &&
        !isJunkEntityName(e.name as string)
      )
      .map((e: Record<string, unknown>) => ({
        name: (e.name as string).slice(0, 100),
        type: e.type as EntityType,
        aliases: Array.isArray(e.aliases) ? (e.aliases as string[]).slice(0, 5) : [],
        observations: Array.isArray(e.observations)
          ? (e.observations as string[]).filter(o => typeof o === 'string' && o.length > 5).slice(0, 5)
          : [],
      }));

    const relations = (parsed.relations || [])
      .filter((r: Record<string, unknown>) =>
        typeof r.from === 'string' && typeof r.to === 'string' && typeof r.type === 'string'
      )
      .map((r: Record<string, unknown>) => ({
        from: r.from as string,
        to: r.to as string,
        type: (r.type as string).slice(0, 30),
      }));

    return { entities, relations };
  } catch {
    return { entities: [], relations: [] };
  }
}

/**
 * Extract entities from a session and store in the brain.
 * Fire-and-forget — caller should not await.
 */
export async function extractBrainEntities(
  history: Dialogue[],
  sessionId: string,
  client: ModelClient,
): Promise<number> {
  if (history.length < 4) return 0;

  const condensed = condenseForBrain(history);
  if (condensed.length < 80) return 0;

  let result: BrainExtraction | null = null;
  for (const model of EXTRACTION_MODELS) {
    try {
      const response = await client.complete({
        model,
        messages: [{ role: 'user', content: condensed }],
        system: BRAIN_PROMPT,
        max_tokens: 1500,
        temperature: 0.2,
      });
      const text = (response.content as Array<{ type: string; text?: string }>)
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('');
      result = parseExtraction(text);
      break;
    } catch { continue; }
  }

  if (!result || (result.entities.length === 0 && result.relations.length === 0)) return 0;

  // Store entities + observations
  const entities = loadEntities();
  const nameToId = new Map<string, string>();

  for (const extracted of result.entities) {
    const entityId = upsertEntity(entities, extracted.name, extracted.type, extracted.aliases);
    nameToId.set(extracted.name.toLowerCase(), entityId);

    for (const obs of extracted.observations) {
      addObservation(entityId, obs, sessionId);
    }
  }

  saveEntities(entities);

  // Store relations
  for (const rel of result.relations) {
    const fromId = nameToId.get(rel.from.toLowerCase()) ||
      findEntityIdByName(entities, rel.from);
    const toId = nameToId.get(rel.to.toLowerCase()) ||
      findEntityIdByName(entities, rel.to);

    if (fromId && toId) {
      upsertRelation(fromId, toId, rel.type);
    }
  }

  return result.entities.length;
}

function findEntityIdByName(entities: Entity[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return entities.find(e =>
    e.name.toLowerCase() === lower ||
    e.aliases.some(a => a.toLowerCase() === lower)
  )?.id;
}
