/**
 * MemoryRecall — let the agent query Franklin's Brain explicitly.
 *
 * Auto-recall (in loop.ts) covers the "user just mentioned X" case, but the
 * agent often needs to check memory on its own: "what do I already know
 * about the user's portfolio?", "have I seen this company before?". This
 * tool exposes the Brain's search + observation read path as a first-class
 * capability so the agent can decide when to pull from long-term memory.
 *
 * Read-only. Writing to the Brain happens after-the-fact via
 * extractBrainEntities on session end; we don't expose a write tool here
 * because giving the model direct write access to the knowledge graph
 * invites fabricated "facts" that never saw a real conversation.
 */

import {
  searchEntities,
  getEntityObservations,
  getEntityRelations,
  loadEntities,
  getBrainStats,
} from '../brain/store.js';
import type { CapabilityHandler, CapabilityResult } from '../agent/types.js';

interface MemoryRecallInput {
  query: string;
  /** Max entities to return (default 5, max 15). */
  limit?: number;
}

const MAX_OBS_PER_ENTITY = 5;
const MAX_REL_PER_ENTITY = 3;

export const memoryRecallCapability: CapabilityHandler = {
  spec: {
    name: 'MemoryRecall',
    description:
      "Query Franklin's long-term memory (the Brain) for what it already " +
      "knows about a person, project, company, product, or concept. Use " +
      "this BEFORE asking the user a question the memory might already " +
      "answer, or when deciding how to act toward a named entity. Returns " +
      "matching entities with their observations and relations. " +
      "Read-only — observations are harvested automatically at session end.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Name, alias, or substring to search for. Case-insensitive.',
        },
        limit: {
          type: 'number',
          description: 'Max entities to return (default 5, max 15).',
        },
      },
      required: ['query'],
    },
  },
  execute: async (input: Record<string, unknown>): Promise<CapabilityResult> => {
    const { query, limit } = input as unknown as MemoryRecallInput;
    if (!query || !query.trim()) {
      return { output: 'Error: query is required', isError: true };
    }

    const cap = Math.min(Math.max(1, limit ?? 5), 15);
    const hits = searchEntities(query, cap);
    const stats = getBrainStats();

    if (hits.length === 0) {
      return {
        output:
          `No memory match for "${query}".\n\n` +
          `Brain holds ${stats.entities} entities, ${stats.observations} observations.`,
      };
    }

    const entities = loadEntities();
    const lines: string[] = [`# Memory — ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"`];

    for (const hit of hits) {
      lines.push(`\n## ${hit.name} (${hit.type})`);
      if (hit.aliases.length > 0) {
        lines.push(`aka: ${hit.aliases.join(', ')}`);
      }
      lines.push(
        `_referenced ${hit.reference_count}×, last seen ${new Date(hit.updated_at).toISOString().slice(0, 10)}_`,
      );

      const obs = getEntityObservations(hit.id)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_OBS_PER_ENTITY);
      if (obs.length > 0) {
        lines.push('\n**Facts**');
        for (const o of obs) lines.push(`- ${o.content}`);
      }

      const rels = getEntityRelations(hit.id).slice(0, MAX_REL_PER_ENTITY);
      if (rels.length > 0) {
        lines.push('\n**Relations**');
        for (const r of rels) {
          const otherId = r.from_id === hit.id ? r.to_id : r.from_id;
          const other = entities.find(e => e.id === otherId);
          if (other) lines.push(`- ${r.type} → ${other.name}`);
        }
      }
    }

    return { output: lines.join('\n') };
  },
  concurrent: true,
};
