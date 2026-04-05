/**
 * Context compaction for runcode.
 * When conversation history approaches the context window limit,
 * summarize older messages and replace them with the summary.
 */

import { ModelClient } from './llm.js';
import type { Dialogue, UserContentPart } from './types.js';
import {
  estimateHistoryTokens,
  estimateDialogueTokens,
  getCompactionThreshold,
  COMPACTION_SUMMARY_RESERVE,
} from './tokens.js';

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the conversation so far. This summary will replace the original messages to save context space.

Rules:
- Preserve ALL important technical details: file paths, function names, variable names, error messages, decisions made
- Preserve the current state of any ongoing task (what's done, what's remaining)
- Preserve any user preferences or instructions that were given
- Keep tool results that are still relevant (e.g., file contents that were read and are being worked on)
- Be specific — "edited src/foo.ts" not "made some changes"
- Use bullet points for clarity
- Do NOT include thinking/reasoning that led to decisions — only the decisions themselves
- Do NOT include pleasantries or meta-commentary

Output format:
## Conversation Summary
[your summary here]

## Current Task State
[what the user is working on, what's been done, what's remaining]

## Key Files & Paths
[any important file paths, configurations, or references mentioned]`;

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

  if (debug) {
    console.error(
      `[runcode] Auto-compacting: ~${currentTokens} tokens, threshold=${threshold}`
    );
  }

  const beforeTokens = estimateHistoryTokens(history);
  try {
    const compacted = await compactHistory(history, model, client, debug);
    const afterTokens = estimateHistoryTokens(compacted);
    if (afterTokens >= beforeTokens) {
      if (debug) {
        console.error(`[runcode] Auto-compaction grew history (${beforeTokens} → ${afterTokens}) — skipping`);
      }
      return { history, compacted: false };
    }
    return { history: compacted, compacted: true };
  } catch (err) {
    if (debug) {
      console.error(`[runcode] Compaction failed: ${(err as Error).message}`);
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
        console.error(`[runcode] Compaction produced larger history (${beforeTokens} → ${afterTokens}) — reverting`);
      }
      return { history, compacted: false };
    }
    return { history: compacted, compacted: true };
  } catch (err) {
    if (debug) {
      console.error(`[runcode] Force compaction failed: ${(err as Error).message}`);
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
      `[runcode] Summarizing ${toSummarize.length} messages, keeping ${toKeep.length}`
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

  // Extract summary text
  let summaryText = '';
  for (const part of summaryParts) {
    if (part.type === 'text') {
      summaryText += part.text;
    }
  }

  if (!summaryText) {
    throw new Error('Empty summary returned from model');
  }

  // Build compacted history: summary as first message, then kept messages
  const compacted: Dialogue[] = [
    {
      role: 'user',
      content: `[Context from earlier conversation — auto-compacted]\n\n${summaryText}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from our earlier conversation. Continuing from where we left off.',
    },
    ...toKeep,
  ];

  if (debug) {
    const newTokens = estimateHistoryTokens(compacted);
    console.error(
      `[runcode] Compacted: ${estimateHistoryTokens(history)} → ${newTokens} tokens`
    );
  }

  return compacted;
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
 * Pick a cheaper/faster model for compaction to save cost.
 */
function pickCompactionModel(primaryModel: string): string {
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
  // Free/unknown models — use flash
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
 * Clear old tool results in-place to save tokens (microcompaction).
 * Replaces tool result content with a short summary for all but the last N results.
 */
export function microCompact(history: Dialogue[], keepLastN = 5): Dialogue[] {
  // Find all tool_result positions
  const toolResultPositions: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      typeof msg.content[0] !== 'string' &&
      'type' in msg.content[0] &&
      msg.content[0].type === 'tool_result'
    ) {
      toolResultPositions.push(i);
    }
  }

  // Nothing to compact
  if (toolResultPositions.length <= keepLastN) {
    return history;
  }

  // Clear older tool results
  const clearPositions = toolResultPositions.slice(0, -keepLastN);
  const result = [...history];

  for (const pos of clearPositions) {
    const msg = result[pos];
    if (!Array.isArray(msg.content)) continue;

    const cleared = (msg.content as UserContentPart[]).map((part): UserContentPart => {
      if (part.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: '[Tool result cleared to save context]',
          is_error: part.is_error,
        };
      }
      return part;
    });

    result[pos] = { role: 'user', content: cleared };
  }

  return result;
}
