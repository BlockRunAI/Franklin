/**
 * Context compaction for Franklin.
 * When conversation history approaches the context window limit,
 * summarize older messages and replace them with the summary.
 */

import { existsSync, readFileSync } from 'node:fs';
import { ModelClient } from './llm.js';
import type { Dialogue, ContentPart, UserContentPart } from './types.js';
import {
  estimateHistoryTokens,
  estimateDialogueTokens,
  getCompactionThreshold,
  COMPACTION_SUMMARY_RESERVE,
} from './tokens.js';

/** Max files to restore after compaction */
const POST_COMPACT_MAX_FILES = 5;

/** Max tokens to spend on post-compact file restoration */
const POST_COMPACT_TOKEN_BUDGET = 50_000;

/**
 * Minimum projected fraction of total history tokens that compaction must
 * save to be worth the round-trip. Summarization itself costs roughly
 * the input payload tokens (read once by the compaction model) plus the
 * ~16k reserved for the output. If the payload we'd summarize is small
 * relative to what we'd keep, we pay the full cost for marginal relief.
 * 0.20 = skip compaction unless projected savings clear 20% of total tokens.
 * This only applies to autoCompactIfNeeded; /compact (forceCompact) still
 * runs unconditionally because the user asked for it.
 */
const MIN_COMPACTION_SAVINGS_RATIO = 0.20;

/**
 * Rough upper bound on how many tokens the summary itself will occupy in
 * the new history. The model is asked for up to COMPACTION_SUMMARY_RESERVE,
 * but in practice structured summaries land well under that; be optimistic
 * on the expected case, pessimistic on the safety margin.
 */
const EXPECTED_SUMMARY_TOKENS = 4_000;

/**
 * Decide whether compacting is worth the round-trip. Pure function so tests
 * can pin behavior at specific history shapes without spinning up a client.
 *
 * Returns `{ worthIt, currentTokens, projectedTokens, savings }`. Caller
 * can log the numbers or just branch on `worthIt`.
 */
export function projectCompactionSavings(history: Dialogue[]): {
  worthIt: boolean;
  currentTokens: number;
  projectedTokens: number;
  savings: number;
  floor: number;
} {
  const currentTokens = estimateHistoryTokens(history);
  const keepCount = findKeepBoundary(history);
  const toKeep = history.slice(history.length - keepCount);
  const keptTokens = estimateHistoryTokens(toKeep);
  const projectedTokens = keptTokens + EXPECTED_SUMMARY_TOKENS;
  const savings = currentTokens - projectedTokens;
  const floor = Math.ceil(currentTokens * MIN_COMPACTION_SAVINGS_RATIO);
  return {
    worthIt: savings >= floor,
    currentTokens,
    projectedTokens,
    savings,
    floor,
  };
}

// Structured compaction prompt (pattern from nousresearch/hermes-agent
// `agent/context_compressor.py`). The structured sections preserve more
// signal than free-form summaries and make it easier for the model to
// continue work from where it left off.
export const COMPACT_HEADER = `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary.`;

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Produce a STRUCTURED summary of the conversation so far that preserves all decision-relevant context for continuing the task.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Critical rules:
- Preserve EXACT file paths, function names, line numbers, variable names
- Preserve EXACT error messages and stack traces (verbatim)
- Preserve user preferences and corrections (especially "don't do X" instructions)
- Preserve decisions WITH their rationale — "changed X to Y because Z was broken" (1-2 sentences per decision)
- Include full code snippets and function signatures when they are load-bearing
- DO NOT include verbose reasoning chains — summarize the WHY in 1-2 sentences, not paragraphs
- DO NOT include pleasantries, meta-commentary, or apologies
- Use bullet points inside each section
- Be specific: "edited src/foo.ts:42 to add error handling" not "made some changes"

First, analyze the conversation chronologically inside <analysis> tags. This is your drafting space — it will be stripped from the final output. Think through what matters before writing the summary.

Then produce the summary inside <summary> tags using these exact section headers:

## Goal
[One clear sentence: what the user is trying to accomplish]

## Key Technical Context
[Important technical details, architecture patterns, constraints, or domain knowledge established during the conversation that future work depends on]

## Progress
[Chronological bullet list of what has been done so far, with specific file paths and line numbers]

## Errors and Fixes
[Any errors encountered, their root causes, and how they were resolved — this prevents re-investigating the same issues]

## Decisions
[Each decision: what was chosen, why, and what constraint/goal drove it. Format: "Chose X over Y because Z." — losing the WHY causes rework later]

## Files Modified
[Each file touched, with a one-line description of what changed and why]

## Tool Results Still Relevant
[Any tool output (file reads, grep matches, bash output) that later steps still depend on — include the actual content, not just a reference to it]

## User Messages and Feedback
[Chronological summary of what the user said, asked for, and corrected — these are load-bearing and must not be lost]

## Next Steps
[What comes next, in priority order, with enough detail to continue without re-reading the original conversation]

If there's an existing [CONTEXT COMPACTION] summary in the messages being compacted, MERGE its content into your output rather than nesting. Do not produce a summary of a summary.`;

/**
 * Check if compaction is needed and perform it if so.
 * Returns the (possibly compacted) history.
 */
export async function autoCompactIfNeeded(
  history: Dialogue[],
  model: string,
  client: ModelClient,
  debug?: boolean
): Promise<{ history: Dialogue[]; compacted: boolean }> {
  const currentTokens = estimateHistoryTokens(history);
  const threshold = getCompactionThreshold(model);

  if (currentTokens < threshold) {
    return { history, compacted: false };
  }

  // ROI gate: project how much the summarization would actually save. The
  // portion that survives compaction (`toKeep`) doesn't shrink, and the
  // summary replaces `toSummarize` with ~EXPECTED_SUMMARY_TOKENS. If the
  // resulting history is within MIN_COMPACTION_SAVINGS_RATIO of the current
  // size, skip — the round-trip would cost more than the headroom is worth.
  // The caller then falls back to per-turn emergency handling (413 recovery,
  // output-tokens clamp) which is much cheaper on the margin.
  const roi = projectCompactionSavings(history);
  if (!roi.worthIt) {
    if (debug) {
      console.error(
        `[franklin] Compaction skipped (ROI): current=${roi.currentTokens}, projected=${roi.projectedTokens}, ` +
        `savings=${roi.savings} < ${roi.floor} floor`,
      );
    }
    return { history, compacted: false };
  }

  if (debug) {
    console.error(
      `[franklin] Auto-compacting: ~${currentTokens} tokens, threshold=${threshold}, projected savings=${roi.savings}`,
    );
  }

  const beforeTokens = estimateHistoryTokens(history);
  try {
    const compacted = await compactHistory(history, model, client, debug);
    const afterTokens = estimateHistoryTokens(compacted);
    if (afterTokens >= beforeTokens) {
      if (debug) {
        console.error(`[franklin] Auto-compaction grew history (${beforeTokens} → ${afterTokens}) — skipping`);
      }
      return { history, compacted: false };
    }
    return { history: compacted, compacted: true };
  } catch (err) {
    if (debug) {
      console.error(`[franklin] Compaction failed: ${(err as Error).message}`);
    }
    // Fallback: truncate oldest messages instead of crashing
    const truncated = emergencyTruncate(history, threshold);
    return { history: truncated, compacted: true };
  }
}

/**
 * Force compaction regardless of threshold (for /compact command).
 */
export async function forceCompact(
  history: Dialogue[],
  model: string,
  client: ModelClient,
  debug?: boolean
): Promise<{ history: Dialogue[]; compacted: boolean }> {
  if (history.length <= 4) {
    return { history, compacted: false };
  }
  const beforeTokens = estimateHistoryTokens(history);
  try {
    const compacted = await compactHistory(history, model, client, debug);
    const afterTokens = estimateHistoryTokens(compacted);
    // Only accept compaction if it actually reduces tokens
    if (afterTokens >= beforeTokens) {
      if (debug) {
        console.error(`[franklin] Compaction produced larger history (${beforeTokens} → ${afterTokens}) — reverting`);
      }
      return { history, compacted: false };
    }
    return { history: compacted, compacted: true };
  } catch (err) {
    if (debug) {
      console.error(`[franklin] Force compaction failed: ${(err as Error).message}`);
    }
    const threshold = getCompactionThreshold(model);
    const truncated = emergencyTruncate(history, threshold);
    return { history: truncated, compacted: true };
  }
}

/**
 * Compact conversation history by summarizing older messages.
 */
async function compactHistory(
  history: Dialogue[],
  model: string,
  client: ModelClient,
  debug?: boolean
): Promise<Dialogue[]> {
  if (history.length <= 4) {
    // Too few messages to compact meaningfully
    return history;
  }

  // Split: keep the most recent messages, summarize the rest
  const keepCount = findKeepBoundary(history);
  const toSummarize = history.slice(0, history.length - keepCount);
  const toKeep = history.slice(history.length - keepCount);

  if (toSummarize.length === 0) {
    return history;
  }

  if (debug) {
    console.error(
      `[franklin] Summarizing ${toSummarize.length} messages, keeping ${toKeep.length}`
    );
  }

  // Build summary request
  const summaryMessages: Dialogue[] = [
    {
      role: 'user',
      content: formatForSummarization(toSummarize),
    },
  ];

  const { content: summaryParts } = await client.complete(
    {
      model: pickCompactionModel(model),
      messages: summaryMessages,
      system: COMPACT_SYSTEM_PROMPT,
      max_tokens: COMPACTION_SUMMARY_RESERVE,
      stream: true,
    }
  );

  // Extract summary text and strip analysis scratchpad
  let rawSummary = '';
  for (const part of summaryParts) {
    if (part.type === 'text') {
      rawSummary += part.text;
    }
  }

  if (!rawSummary) {
    throw new Error('Empty summary returned from model');
  }

  const summaryText = formatCompactSummary(rawSummary);

  // Build compacted history: summary as first message, then kept messages.
  // The COMPACT_HEADER prefix lets future compactions detect and merge rather
  // than nest summaries.
  const compacted: Dialogue[] = [
    {
      role: 'user',
      content: `${COMPACT_HEADER}\n\n${summaryText}`,
    },
    {
      role: 'assistant',
      content: 'Got it. I have the structured context from earlier work and will continue from where things left off.',
    },
  ];

  // Post-compact file restoration
  // Re-read recently modified files to restore working context that was lost
  // during compaction. This prevents the agent from needing to re-read files
  // it was actively working on.
  const restoredFiles = restoreRecentFiles(summaryText, toSummarize, debug);
  if (restoredFiles) {
    compacted.push(
      { role: 'user', content: restoredFiles.prompt },
      { role: 'assistant', content: 'I have the restored file contents and will use them as context for continuing work.' },
    );
  }

  compacted.push(...toKeep);

  if (debug) {
    const newTokens = estimateHistoryTokens(compacted);
    console.error(
      `[franklin] Compacted: ${estimateHistoryTokens(history)} → ${newTokens} tokens`
    );
  }

  return compacted;
}

/**
 * Restore recently modified files after compaction.
 * Extracts file paths from the compaction summary and the original messages,
 * reads the ones that still exist, and builds a context restoration prompt.
 */
function restoreRecentFiles(
  summaryText: string,
  compactedMessages: Dialogue[],
  debug?: boolean
): { prompt: string } | null {
  // Extract file paths from multiple sources:
  // 1. "Files Modified" section in the summary
  // 2. Edit/Write/Read tool calls in the compacted messages

  const filePaths = new Set<string>();

  // Source 1: Parse "## Files Modified" section from summary
  const filesSection = summaryText.match(/## Files Modified\n([\s\S]*?)(?=\n## |$)/);
  if (filesSection) {
    const pathRegex = /[`"]?([/\w.-]+\.\w{1,10})[`"]?/g;
    let match;
    while ((match = pathRegex.exec(filesSection[1])) !== null) {
      const p = match[1];
      // Filter: must look like a real file path (has directory separator or extension)
      if (p.includes('/') || p.includes('.')) {
        filePaths.add(p);
      }
    }
  }

  // Source 2: Extract from Edit/Write tool_use inputs in compacted messages
  for (const msg of compactedMessages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'tool_use' && (part.name === 'Edit' || part.name === 'Write')) {
        const fp = (part.input as Record<string, unknown>)?.file_path;
        if (typeof fp === 'string' && fp.startsWith('/')) {
          filePaths.add(fp);
        }
      }
    }
  }

  if (filePaths.size === 0) return null;

  // Prioritize: most recently modified files first, limit to POST_COMPACT_MAX_FILES
  const candidates = [...filePaths].filter(p => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) return null;

  // Read files within token budget
  const restoredParts: string[] = [];
  let tokenBudget = POST_COMPACT_TOKEN_BUDGET;
  const filesToRestore = candidates.slice(0, POST_COMPACT_MAX_FILES);

  for (const fp of filesToRestore) {
    try {
      const content = readFileSync(fp, 'utf-8');
      const estimatedTokens = Math.ceil(content.length / 4 * 1.33);

      if (estimatedTokens > tokenBudget) {
        // File too large for remaining budget — take first chunk
        const maxChars = Math.floor(tokenBudget * 3); // ~3 chars per token
        if (maxChars > 500) {
          const truncated = content.slice(0, maxChars);
          restoredParts.push(`### ${fp}\n\`\`\`\n${truncated}\n... (truncated)\n\`\`\``);
          tokenBudget = 0;
        }
        break;
      }

      restoredParts.push(`### ${fp}\n\`\`\`\n${content}\n\`\`\``);
      tokenBudget -= estimatedTokens;
    } catch {
      // File unreadable — skip
    }
  }

  if (restoredParts.length === 0) return null;

  if (debug) {
    console.error(`[franklin] Post-compact: restored ${restoredParts.length} files`);
  }

  return {
    prompt: `[POST-COMPACT FILE RESTORATION] The following files were being actively worked on before context compaction. Their current contents are provided to restore working context:\n\n${restoredParts.join('\n\n')}`,
  };
}

/**
 * Find how many recent messages to keep (don't summarize).
 * Keeps the most recent tool exchange + the last few user/assistant turns.
 */
function findKeepBoundary(history: Dialogue[]): number {
  // Keep the last 8-20 messages (absolute range, not percentage)
  // Prevents "never compacts" bug when history grows large
  const minKeep = Math.min(8, history.length);
  const maxKeep = Math.min(20, history.length - 1);
  let keep = Math.max(minKeep, Math.min(maxKeep, Math.ceil(history.length * 0.3)));

  // Make sure we don't split in the middle of a tool exchange
  // (assistant with tool_use must be followed by user with tool_result)
  while (keep < history.length) {
    const boundary = history.length - keep;
    const msgAtBoundary = history[boundary];

    // If boundary is a user message with tool_results, include the prior assistant message
    if (
      msgAtBoundary.role === 'user' &&
      Array.isArray(msgAtBoundary.content) &&
      msgAtBoundary.content.length > 0 &&
      typeof msgAtBoundary.content[0] !== 'string' &&
      'type' in msgAtBoundary.content[0] &&
      msgAtBoundary.content[0].type === 'tool_result'
    ) {
      keep++;
      continue;
    }

    break;
  }

  return Math.min(keep, history.length - 1); // Always summarize at least 1 message
}

/**
 * Format messages for the summarization model.
 */
function formatForSummarization(messages: Dialogue[]): string {
  const parts: string[] = ['Here is the conversation to summarize:\n'];

  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === 'string') {
      parts.push(`[${role}]: ${msg.content}`);
    } else {
      const textParts: string[] = [];
      for (const part of msg.content) {
        if ('type' in part) {
          switch (part.type) {
            case 'text':
              textParts.push(part.text);
              break;
            case 'tool_use':
              textParts.push(`[Called tool: ${part.name}(${JSON.stringify(part.input).slice(0, 200)})]`);
              break;
            case 'tool_result': {
              const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
              const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
              textParts.push(`[Tool result${part.is_error ? ' (ERROR)' : ''}: ${truncated}]`);
              break;
            }
            case 'thinking':
              // Skip thinking blocks in summary
              break;
          }
        }
      }
      if (textParts.length > 0) {
        parts.push(`[${role}]: ${textParts.join('\n')}`);
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * Strip the analysis scratchpad from compaction output and extract the summary.
 * The model drafts in <analysis> tags (for quality), then writes the final
 * summary in <summary> tags. We keep only the summary.
 */
function formatCompactSummary(raw: string): string {
  // Strip <analysis>...</analysis> (the drafting scratchpad)
  let cleaned = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();

  // Extract content from <summary>...</summary> if present
  const summaryMatch = cleaned.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    cleaned = summaryMatch[1].trim();
  }

  // If neither tag was used, the model gave us raw output — use as-is
  return cleaned || raw.trim();
}

/**
 * Pick a cheaper/faster model for compaction to save cost.
 * If the primary model is free (NVIDIA), compaction also stays free
 * so users don't get silent charges when their context fills up.
 */
function pickCompactionModel(primaryModel: string): string {
  // Free parent → free compaction (no silent charge)
  if (primaryModel.startsWith('nvidia/') || primaryModel === 'blockrun/free') {
    return 'nvidia/glm-4.7';
  }
  // Use cheapest capable model for summarization to save cost
  // Tier down: opus/pro → sonnet, sonnet → haiku, everything else → flash (cheapest capable)
  if (primaryModel.includes('opus') || primaryModel.includes('pro')) {
    return 'anthropic/claude-sonnet-4.6';
  }
  if (primaryModel.includes('sonnet') || primaryModel.includes('gpt-5.4') || primaryModel.includes('gemini-2.5-pro')) {
    return 'anthropic/claude-haiku-4.5-20251001';
  }
  if (primaryModel.includes('haiku') || primaryModel.includes('mini') || primaryModel.includes('nano')) {
    return 'google/gemini-2.5-flash'; // Cheapest capable model
  }
  // Unknown models — use flash
  return 'google/gemini-2.5-flash';
}

/**
 * Emergency fallback: drop oldest messages until under threshold.
 * Used when the summarization model call itself fails.
 */
function emergencyTruncate(history: Dialogue[], targetTokens: number): Dialogue[] {
  const result = [...history];
  while (result.length > 2 && estimateHistoryTokens(result) > targetTokens) {
    result.shift();
  }

  // Ensure first message is from user (API requirement)
  if (result.length > 0 && result[0].role === 'assistant') {
    result.unshift({
      role: 'user',
      content: '[Earlier conversation truncated due to context limit]',
    });
  }

  return result;
}

/**
 * Clear old tool results AND truncate old tool_use inputs to save tokens.
 * This is the primary defense against context snowball:
 * - tool_result content (Read output, Bash output, Grep matches) grows fast
 * - tool_use input (Edit replacements, Bash commands) also accumulates
 * Both are cleared for all but the last N tool exchanges.
 */
export function microCompact(history: Dialogue[], keepLastN = 3): Dialogue[] {
  // Find all tool_use IDs in assistant messages, in order
  const allToolUseIds: string[] = [];
  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'tool_use') {
          allToolUseIds.push(part.id);
        }
      }
    }
  }

  if (allToolUseIds.length <= keepLastN) {
    return history;
  }

  // IDs to clear (all except the most recent N)
  const clearIds = new Set(allToolUseIds.slice(0, -keepLastN));
  if (clearIds.size === 0) return history;

  const result: Dialogue[] = [];
  let changed = false;

  for (const msg of history) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Clear old tool_result content
      let modified = false;
      const cleared = (msg.content as UserContentPart[]).map((part): UserContentPart => {
        if (part.type === 'tool_result' && clearIds.has(part.tool_use_id)) {
          // Already cleared — skip
          if (part.content === '[Tool result cleared to save context]') return part;
          modified = true;
          return {
            type: 'tool_result',
            tool_use_id: part.tool_use_id,
            content: '[Tool result cleared to save context]',
            is_error: part.is_error,
          };
        }
        return part;
      });
      if (modified) {
        changed = true;
        result.push({ role: 'user', content: cleared });
      } else {
        result.push(msg);
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Truncate old tool_use inputs (keep name + id, shrink input)
      let modified = false;
      const truncated = (msg.content as ContentPart[]).map((part): ContentPart => {
        if (part.type === 'tool_use' && clearIds.has(part.id)) {
          const inputStr = JSON.stringify(part.input);
          if (inputStr.length > 200) {
            modified = true;
            // Keep just enough to know what was called
            const summary: Record<string, unknown> = {};
            const input = part.input as Record<string, unknown>;
            for (const [k, v] of Object.entries(input)) {
              const val = typeof v === 'string' ? v.slice(0, 100) : v;
              summary[k] = val;
            }
            return { ...part, input: summary };
          }
        }
        return part;
      });
      if (modified) {
        changed = true;
        result.push({ role: 'assistant', content: truncated });
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return changed ? result : history;
}
