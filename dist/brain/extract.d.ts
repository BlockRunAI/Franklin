/**
 * Franklin Brain — entity extraction from session traces.
 * Uses cheap model to detect people, projects, companies from conversation.
 */
import { ModelClient } from '../agent/llm.js';
import type { Dialogue } from '../agent/types.js';
/**
 * Extract entities from a session and store in the brain.
 * Fire-and-forget — caller should not await.
 */
export declare function extractBrainEntities(history: Dialogue[], sessionId: string, client: ModelClient): Promise<number>;
