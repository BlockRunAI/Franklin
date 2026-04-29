/**
 * Extract user preferences from a completed session trace.
 * Uses a cheap model to analyze the conversation and produce learnings.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ModelClient } from '../agent/llm.js';
import type { Dialogue, ContentPart } from '../agent/types.js';
import type { ExtractionResult, LearningCategory } from './types.js';
import { loadLearnings, mergeLearning, saveLearnings, loadSkills, saveSkill } from './store.js';
import type { Skill } from './types.js';

// Free models for learning extraction — JSON extraction is simple enough.
// Ordered by reliability: try the best free model first, fall back to others.
const EXTRACTION_MODELS = [
  'nvidia/qwen3-coder-480b',     // Agent-tested free model; strong at JSON tasks
  'nvidia/llama-4-maverick',     // Agent-tested fallback
  'nvidia/glm-4.7',              // Chat fallback; not default for tool-heavy paths
];

const VALID_CATEGORIES = new Set<LearningCategory>([
  'language', 'model_preference', 'tool_pattern', 'coding_style',
  'communication', 'domain', 'correction', 'negative', 'project_context',
  'workflow', 'other',
]);

const EXTRACTION_PROMPT = `You are analyzing a conversation between a user and an AI coding agent. Extract user preferences, behavioral patterns, and project knowledge that would help personalize future interactions.

Analyze for:
1. Language — what language does the user write in? (English, Chinese, mixed?)
2. Model preferences — did they switch models or express a preference?
3. Coding style — did they correct the agent's code style? (naming, formatting, conventions)
4. Communication — are they terse or verbose? Do they want explanations or just code?
5. Domain — what tech stack, frameworks, or project type?
6. Corrections — did they repeatedly correct the same agent behavior?
7. **Negative signals** — did the user say "don't do X", "stop doing Y", "never Z"? These are HIGH PRIORITY (confidence 0.9+). Use category "negative".
8. **Project context** — architecture decisions, key file locations, deployment patterns, team conventions. Use category "project_context".
9. Workflow — do they prefer short tasks or long planning sessions?

Rules:
- ONLY extract signals clearly supported by evidence in the conversation.
- Do NOT speculate. If evidence is weak, set confidence below 0.5.
- **Negative signals get HIGH confidence** (0.9+) — when a user says "don't" or "stop" or corrects the agent, that's a strong signal.
- **Project context gets MEDIUM confidence** (0.7) — architecture/tech decisions are usually deliberate.
- If the conversation is too short or generic, return an empty array.
- Each learning should be one clear, actionable sentence.
- For negative learnings, start with "NEVER" or "Do NOT" to make the instruction clear.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"learnings":[{"learning":"...","category":"language|model_preference|tool_pattern|coding_style|communication|domain|correction|negative|project_context|workflow|other","confidence":0.5}]}`;

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

// ─── Onboarding: bootstrap from existing CLAUDE.md preferences ───────────

const BOOTSTRAP_PROMPT = `You are analyzing a user's AI coding agent configuration file (CLAUDE.md). Extract user preferences that would help personalize a different AI agent's behavior.

Analyze for:
1. Language — what language do they communicate in?
2. Coding style — naming conventions, formatting, lint rules, type annotations?
3. Communication — how do they want the agent to behave? (terse? formal? call them something?)
4. Domain — what tech stack, frameworks, languages do they work with?
5. Workflow — any specific git, commit, or deployment preferences?
6. Corrections — any explicit "do NOT" rules or anti-patterns?
7. Other — any other clear preferences?

Rules:
- Extract EVERY explicit preference. These are user-written rules, so confidence is high (0.8-1.0).
- Each learning should be one clear, actionable sentence.
- Do NOT include project-specific paths or secrets.
- Do NOT include things that are tool-specific to a particular agent and wouldn't apply to franklin.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"learnings":[{"learning":"...","category":"language|model_preference|tool_pattern|coding_style|communication|domain|correction|workflow|other","confidence":0.9}]}`;

/**
 * Scan for existing CLAUDE.md preference files and bootstrap learnings from them.
 * Only runs once — skips if learnings already exist.
 */
export async function bootstrapFromClaudeConfig(client: ModelClient): Promise<number> {
  // Only bootstrap if no learnings exist yet (first run)
  const existing = loadLearnings();
  if (existing.length > 0) return 0;

  // Scan for CLAUDE.md preference files
  const configPaths = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(process.cwd(), 'CLAUDE.md'),
    path.join(process.cwd(), '.claude', 'CLAUDE.md'),
  ];

  const contents: string[] = [];
  for (const p of configPaths) {
    try {
      const text = fs.readFileSync(p, 'utf-8').trim();
      if (text && text.length > 20) {
        contents.push(`--- ${p} ---\n${text}`);
      }
    } catch { /* file doesn't exist */ }
  }

  if (contents.length === 0) return 0;

  // Cap total content
  let combined = contents.join('\n\n');
  if (combined.length > 6000) combined = combined.slice(0, 6000) + '\n…(truncated)';

  // Extract learnings
  let result: ExtractionResult | null = null;
  for (const model of EXTRACTION_MODELS) {
    try {
      const response = await client.complete({
        model,
        messages: [{ role: 'user', content: combined }],
        system: BOOTSTRAP_PROMPT,
        max_tokens: 1500,
        temperature: 0.2,
      });
      const text = response.content
        .filter((p: ContentPart) => p.type === 'text')
        .map((p: ContentPart) => (p as { type: 'text'; text: string }).text)
        .join('');
      result = parseExtraction(text);
      break;
    } catch { continue; }
  }

  if (!result || result.learnings.length === 0) return 0;

  // Save all bootstrapped learnings
  let learnings = loadLearnings();
  for (const entry of result.learnings) {
    learnings = mergeLearning(learnings, {
      ...entry,
      source_session: 'bootstrap:claude-config',
    });
  }
  saveLearnings(learnings);
  return result.learnings.length;
}

// ─── Session extraction ──────────────────────────────────────────────────

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

  await runExtraction(condensed, sessionId, client);
}

async function runExtraction(condensed: string, sessionId: string, client: ModelClient): Promise<void> {
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

// ─── Skill extraction (procedural memory) ─────────────────────────────────
// After complex tasks, detect reusable procedures and save as skills.

const SKILL_EXTRACTION_PROMPT = `You are analyzing a conversation where an AI agent completed a complex multi-step task. Decide if this task pattern should be saved as a reusable skill (procedure).

Save a skill when:
1. The task involved 5+ distinct steps that could be repeated
2. The steps are generalizable (not one-off fixes for specific bugs)
3. Future similar tasks would benefit from having the procedure documented

If the task IS worth saving, output in this exact format (no markdown fences):
{"skill":{"name":"kebab-case-name","description":"One-line description","triggers":["keyword1","keyword2"],"steps":"## Steps\\n1. First step\\n2. Second step\\n..."}}

If NOT worth saving, output exactly:
{"skill":null}

Be selective — only save genuinely reusable multi-step procedures.`;

const MIN_TOOL_CALLS_FOR_SKILL = 5;

/**
 * Try to extract a reusable skill from the recent work.
 * Called from maybeMidSessionExtract when enough tool calls happened.
 */
export async function maybeExtractSkill(
  history: Dialogue[],
  turnToolCalls: number,
  sessionId: string,
  client: ModelClient,
): Promise<void> {
  if (turnToolCalls < MIN_TOOL_CALLS_FOR_SKILL) return;

  // Condense recent history with tool details (skills need tool context)
  const parts: string[] = [];
  let chars = 0;
  const CAP = 6000;
  for (const msg of history.slice(-20)) {
    if (chars >= CAP) break;
    if (typeof msg.content === 'string') {
      const line = `${msg.role}: ${msg.content.slice(0, 300)}`;
      parts.push(line);
      chars += line.length;
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (chars >= CAP) break;
        if ((p as any).type === 'text') {
          const line = `${msg.role}: ${(p as any).text.slice(0, 200)}`;
          parts.push(line);
          chars += line.length;
        } else if ((p as any).type === 'tool_use') {
          const line = `tool: ${(p as any).name}(${JSON.stringify((p as any).input).slice(0, 150)})`;
          parts.push(line);
          chars += line.length;
        } else if ((p as any).type === 'tool_result') {
          const text = typeof (p as any).content === 'string' ? (p as any).content : '';
          const line = `result: ${text.slice(0, 100)}`;
          parts.push(line);
          chars += line.length;
        }
      }
    }
  }

  const condensed = parts.join('\n\n');
  if (condensed.length < 200) return;

  try {
    let text = '';
    for (const model of EXTRACTION_MODELS) {
      try {
        const response = await client.complete({
          model,
          messages: [{ role: 'user', content: condensed }],
          system: SKILL_EXTRACTION_PROMPT,
          max_tokens: 1500,
          temperature: 0.2,
        });
        text = response.content
          .filter((p: ContentPart) => p.type === 'text')
          .map((p: ContentPart) => (p as { type: 'text'; text: string }).text)
          .join('');
        break;
      } catch { continue; }
    }

    if (!text) return;

    // Parse JSON
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed.skill) return;

    const { name, description, triggers, steps } = parsed.skill;
    if (!name || !description || !steps) return;

    // Check for duplicate skills
    const existing = loadSkills();
    if (existing.some(s => s.name === name)) return;

    saveSkill({
      name,
      description,
      triggers: Array.isArray(triggers) ? triggers : [],
      steps,
      created: new Date().toISOString().split('T')[0],
      uses: 0,
      source_session: sessionId,
    });
  } catch {
    // Skill extraction is best-effort
  }
}

// ─── Mid-session extraction ──────────────────────────────────────────────

/**
 * Tracks state for mid-session extraction so it only runs when there's
 * enough new conversation to analyze.
 */
interface MidSessionState {
  lastExtractionTokens: number;
  lastExtractionToolCalls: number;
  extractionCount: number;
}

const midSessionState: MidSessionState = {
  lastExtractionTokens: 0,
  lastExtractionToolCalls: 0,
  extractionCount: 0,
};

/** Token threshold before first mid-session extraction */
const MID_SESSION_INIT_THRESHOLD = 30_000;
/** Token growth since last extraction to trigger another */
const MID_SESSION_UPDATE_THRESHOLD = 25_000;
/** Minimum tool calls since last extraction */
const MID_SESSION_TOOL_CALLS_THRESHOLD = 5;
/** Max mid-session extractions per session (don't spam) */
const MID_SESSION_MAX_EXTRACTIONS = 3;

/**
 * Check if mid-session extraction should run, and if so, run it in background.
 * Called from the agent loop after tool execution completes.
 *
 * Triggers when:
 * 1. Token count exceeds init threshold (first extraction) OR update threshold (subsequent)
 * 2. AND enough tool calls have happened since last extraction
 * 3. AND we haven't hit the per-session cap
 */
export function maybeMidSessionExtract(
  history: Dialogue[],
  estimatedTokens: number,
  totalToolCalls: number,
  sessionId: string,
  client: ModelClient,
): void {
  // Cap reached — stop extracting
  if (midSessionState.extractionCount >= MID_SESSION_MAX_EXTRACTIONS) return;

  // Check token threshold
  const tokenGrowth = estimatedTokens - midSessionState.lastExtractionTokens;
  const threshold = midSessionState.extractionCount === 0
    ? MID_SESSION_INIT_THRESHOLD
    : MID_SESSION_UPDATE_THRESHOLD;
  if (tokenGrowth < threshold) return;

  // Check tool calls threshold
  const toolCallGrowth = totalToolCalls - midSessionState.lastExtractionToolCalls;
  if (toolCallGrowth < MID_SESSION_TOOL_CALLS_THRESHOLD) return;

  // Trigger extraction — fire and forget (never blocks the conversation)
  midSessionState.lastExtractionTokens = estimatedTokens;
  midSessionState.lastExtractionToolCalls = totalToolCalls;
  midSessionState.extractionCount++;

  const condensed = condenseHistory(history);
  if (condensed.length < 100) return;

  // Run learnings + skill extraction in background — errors are silently swallowed
  runExtraction(condensed, `${sessionId}:mid-${midSessionState.extractionCount}`, client)
    .catch(() => { /* best-effort */ });
  maybeExtractSkill(history, totalToolCalls, sessionId, client)
    .catch(() => { /* best-effort */ });
}
