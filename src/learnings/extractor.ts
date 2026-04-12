/**
 * Extract user preferences from a completed session trace.
 * Uses a cheap model to analyze the conversation and produce learnings.
 */

import { ModelClient } from '../agent/llm.js';
import type { Dialogue, ContentPart } from '../agent/types.js';
import type { ExtractionResult, LearningCategory } from './types.js';
import { loadLearnings, mergeLearning, saveLearnings } from './store.js';

// Cheapest models that reliably output structured JSON
const EXTRACTION_MODELS = [
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-flash',
  'nvidia/nemotron-super-49b',
];

const VALID_CATEGORIES = new Set<LearningCategory>([
  'language', 'model_preference', 'tool_pattern', 'coding_style',
  'communication', 'domain', 'correction', 'workflow', 'other',
]);

const EXTRACTION_PROMPT = `You are analyzing a conversation between a user and an AI coding agent. Extract user preferences and behavioral patterns that would help personalize future interactions.

Analyze for:
1. Language — what language does the user write in? (English, Chinese, mixed?)
2. Model preferences — did they switch models or express a preference?
3. Coding style — did they correct the agent's code style? (naming, formatting, conventions)
4. Communication — are they terse or verbose? Do they want explanations or just code?
5. Domain — what tech stack, frameworks, or project type?
6. Corrections — did they repeatedly correct the same agent behavior?
7. Workflow — do they prefer short tasks or long planning sessions?

Rules:
- ONLY extract signals clearly supported by evidence in the conversation.
- Do NOT speculate. If evidence is weak, set confidence below 0.5.
- If the conversation is too short or generic, return an empty array.
- Each learning should be one clear, actionable sentence.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"learnings":[{"learning":"...","category":"language|model_preference|tool_pattern|coding_style|communication|domain|correction|workflow|other","confidence":0.5}]}`;

/**
 * Condense session history into a compact text for extraction.
 * Only includes user messages and assistant text — skips tool calls/results.
 */
function condenseHistory(history: Dialogue[]): string {
  const parts: string[] = [];
  let chars = 0;
  const CAP = 4000;

  for (const msg of history) {
    if (chars >= CAP) break;
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    let text = '';

    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(p => p.type === 'text')
        .map(p => (p as { text: string }).text)
        .join('\n');
    }

    if (!text.trim()) continue;
    // Truncate long messages
    if (text.length > 500) text = text.slice(0, 500) + '…';
    const line = `${role}: ${text}`;
    parts.push(line);
    chars += line.length;
  }

  return parts.join('\n\n');
}

/**
 * Parse JSON from LLM response, handling common quirks
 * (markdown fences, trailing commas, commentary).
 */
function parseExtraction(raw: string): ExtractionResult {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Find the JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { learnings: [] };
  cleaned = cleaned.slice(start, end + 1);

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.learnings)) return { learnings: [] };

  // Validate and sanitize each entry
  return {
    learnings: parsed.learnings
      .filter((l: Record<string, unknown>) =>
        typeof l.learning === 'string' &&
        typeof l.category === 'string' &&
        VALID_CATEGORIES.has(l.category as LearningCategory) &&
        typeof l.confidence === 'number' &&
        l.confidence >= 0.1 && l.confidence <= 1.0 &&
        (l.learning as string).length > 5
      )
      .map((l: Record<string, unknown>) => ({
        learning: (l.learning as string).slice(0, 200),
        category: l.category as LearningCategory,
        confidence: Math.round((l.confidence as number) * 100) / 100,
      })),
  };
}

/**
 * Extract learnings from a completed session.
 * Runs asynchronously — caller should fire-and-forget.
 */
export async function extractLearnings(
  history: Dialogue[],
  sessionId: string,
  client: ModelClient,
): Promise<void> {
  // Skip very short sessions
  if (history.length < 4) return;

  const condensed = condenseHistory(history);
  if (condensed.length < 100) return; // Too little content

  // Try each model until one succeeds
  let result: ExtractionResult | null = null;
  for (const model of EXTRACTION_MODELS) {
    try {
      const response = await client.complete({
        model,
        messages: [{ role: 'user', content: condensed }],
        system: EXTRACTION_PROMPT,
        max_tokens: 1000,
        temperature: 0.3,
      });
      const text = response.content
        .filter((p: ContentPart) => p.type === 'text')
        .map((p: ContentPart) => (p as { type: 'text'; text: string }).text)
        .join('');
      result = parseExtraction(text);
      break;
    } catch {
      continue; // Try next model
    }
  }

  if (!result || result.learnings.length === 0) return;

  // Merge with existing learnings
  let existing = loadLearnings();
  for (const entry of result.learnings) {
    existing = mergeLearning(existing, {
      ...entry,
      source_session: sessionId,
    });
  }
  saveLearnings(existing);
}
