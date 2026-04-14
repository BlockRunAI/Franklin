/**
 * Extract user preferences from a completed session trace.
 * Uses a cheap model to analyze the conversation and produce learnings.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadLearnings, mergeLearning, saveLearnings } from './store.js';
// Free models for learning extraction — JSON extraction is simple enough.
// Ordered by reliability: try the best free model first, fall back to others.
const EXTRACTION_MODELS = [
    'nvidia/nemotron-ultra-253b', // Best free model for structured output
    'nvidia/qwen3-coder-480b', // Strong at JSON tasks
    'nvidia/devstral-2-123b', // Fallback
];
const VALID_CATEGORIES = new Set([
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
function condenseHistory(history) {
    const parts = [];
    let chars = 0;
    const CAP = 4000;
    for (const msg of history) {
        if (chars >= CAP)
            break;
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        let text = '';
        if (typeof msg.content === 'string') {
            text = msg.content;
        }
        else if (Array.isArray(msg.content)) {
            text = msg.content
                .filter(p => p.type === 'text')
                .map(p => p.text)
                .join('\n');
        }
        if (!text.trim())
            continue;
        // Truncate long messages
        if (text.length > 500)
            text = text.slice(0, 500) + '…';
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
function parseExtraction(raw) {
    // Strip markdown fences
    let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Find the JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1)
        return { learnings: [] };
    cleaned = cleaned.slice(start, end + 1);
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.learnings))
        return { learnings: [] };
    // Validate and sanitize each entry
    return {
        learnings: parsed.learnings
            .filter((l) => typeof l.learning === 'string' &&
            typeof l.category === 'string' &&
            VALID_CATEGORIES.has(l.category) &&
            typeof l.confidence === 'number' &&
            l.confidence >= 0.1 && l.confidence <= 1.0 &&
            l.learning.length > 5)
            .map((l) => ({
            learning: l.learning.slice(0, 200),
            category: l.category,
            confidence: Math.round(l.confidence * 100) / 100,
        })),
    };
}
// ─── Onboarding: bootstrap from Claude Code config ───────────────────────
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
- Do NOT include things that are tool-specific to Claude Code and wouldn't apply to another agent.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{"learnings":[{"learning":"...","category":"language|model_preference|tool_pattern|coding_style|communication|domain|correction|workflow|other","confidence":0.9}]}`;
/**
 * Scan for Claude Code configuration and bootstrap learnings from it.
 * Only runs once — skips if learnings already exist.
 */
export async function bootstrapFromClaudeConfig(client) {
    // Only bootstrap if no learnings exist yet (first run)
    const existing = loadLearnings();
    if (existing.length > 0)
        return 0;
    // Scan for Claude Code config files
    const configPaths = [
        path.join(os.homedir(), '.claude', 'CLAUDE.md'),
        path.join(process.cwd(), 'CLAUDE.md'),
        path.join(process.cwd(), '.claude', 'CLAUDE.md'),
    ];
    const contents = [];
    for (const p of configPaths) {
        try {
            const text = fs.readFileSync(p, 'utf-8').trim();
            if (text && text.length > 20) {
                contents.push(`--- ${p} ---\n${text}`);
            }
        }
        catch { /* file doesn't exist */ }
    }
    if (contents.length === 0)
        return 0;
    // Cap total content
    let combined = contents.join('\n\n');
    if (combined.length > 6000)
        combined = combined.slice(0, 6000) + '\n…(truncated)';
    // Extract learnings
    let result = null;
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
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('');
            result = parseExtraction(text);
            break;
        }
        catch {
            continue;
        }
    }
    if (!result || result.learnings.length === 0)
        return 0;
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
export async function extractLearnings(history, sessionId, client) {
    // Skip very short sessions
    if (history.length < 4)
        return;
    const condensed = condenseHistory(history);
    if (condensed.length < 100)
        return; // Too little content
    await runExtraction(condensed, sessionId, client);
}
async function runExtraction(condensed, sessionId, client) {
    // Try each model until one succeeds
    let result = null;
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
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('');
            result = parseExtraction(text);
            break;
        }
        catch {
            continue; // Try next model
        }
    }
    if (!result || result.learnings.length === 0)
        return;
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
const midSessionState = {
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
 *
 * Inspired by Claude Code's SessionMemory which runs a background subagent
 * to extract conversation notes periodically.
 */
export function maybeMidSessionExtract(history, estimatedTokens, totalToolCalls, sessionId, client) {
    // Cap reached — stop extracting
    if (midSessionState.extractionCount >= MID_SESSION_MAX_EXTRACTIONS)
        return;
    // Check token threshold
    const tokenGrowth = estimatedTokens - midSessionState.lastExtractionTokens;
    const threshold = midSessionState.extractionCount === 0
        ? MID_SESSION_INIT_THRESHOLD
        : MID_SESSION_UPDATE_THRESHOLD;
    if (tokenGrowth < threshold)
        return;
    // Check tool calls threshold
    const toolCallGrowth = totalToolCalls - midSessionState.lastExtractionToolCalls;
    if (toolCallGrowth < MID_SESSION_TOOL_CALLS_THRESHOLD)
        return;
    // Trigger extraction — fire and forget (never blocks the conversation)
    midSessionState.lastExtractionTokens = estimatedTokens;
    midSessionState.lastExtractionToolCalls = totalToolCalls;
    midSessionState.extractionCount++;
    const condensed = condenseHistory(history);
    if (condensed.length < 100)
        return;
    // Run in background — errors are silently swallowed
    runExtraction(condensed, `${sessionId}:mid-${midSessionState.extractionCount}`, client)
        .catch(() => { });
}
