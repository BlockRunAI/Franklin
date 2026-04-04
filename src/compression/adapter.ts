/**
 * Adapter between brcc's Dialogue type and the compression lib's NormalizedMessage type.
 */

import type { Dialogue, ContentPart, UserContentPart } from '../agent/types.js';
import type { NormalizedMessage } from './types.js';
import { compressContext, shouldCompress } from './index.js';

/**
 * Convert brcc Dialogue[] to NormalizedMessage[] for compression.
 */
function dialogueToNormalized(history: Dialogue[]): NormalizedMessage[] {
  return history.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role as 'user' | 'assistant', content: msg.content };
    }

    // Convert content parts to string representation
    const parts: string[] = [];
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

    for (const part of msg.content) {
      if ('type' in part) {
        if (part.type === 'text') {
          parts.push((part as ContentPart & { text: string }).text);
        } else if (part.type === 'tool_use') {
          const inv = part as ContentPart & { id: string; name: string; input: Record<string, unknown> };
          toolCalls.push({
            id: inv.id,
            type: 'function',
            function: { name: inv.name, arguments: JSON.stringify(inv.input) },
          });
        } else if (part.type === 'tool_result') {
          const res = part as UserContentPart & { tool_use_id: string; content: string };
          const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
          parts.push(`[Tool result: ${content}]`);
        } else if (part.type === 'thinking') {
          // Skip thinking in compression (already handled by stripOldThinking)
        }
      }
    }

    const normalized: NormalizedMessage = {
      role: msg.role as 'user' | 'assistant',
      content: parts.join('\n') || null,
    };
    if (toolCalls.length > 0) {
      normalized.tool_calls = toolCalls;
    }
    return normalized;
  });
}

/**
 * Compress conversation history to reduce token usage.
 * Returns compressed Dialogue[] with stats.
 */
export async function compressHistory(
  history: Dialogue[],
  debug?: boolean
): Promise<{ history: Dialogue[]; saved: number; ratio: number } | null> {
  // Convert to NormalizedMessage format
  const normalized = dialogueToNormalized(history);

  // Check if compression is worthwhile
  if (!shouldCompress(normalized)) {
    return null;
  }

  try {
    const result = await compressContext(normalized);
    const savedPct = Math.round((1 - result.compressionRatio) * 100);

    if (debug) {
      console.error(
        `[runcode] Compressed context: ${result.originalChars} → ${result.compressedChars} chars (${savedPct}% saved)`
      );
      if (result.stats) {
        const layers = Object.entries(result.stats)
          .filter(([, v]) => typeof v === 'number' && v > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        if (layers) console.error(`[runcode] Compression layers: ${layers}`);
      }
    }

    // Convert compressed messages back to Dialogue format
    // We only compress the string content, keeping the original structure
    const compressed: Dialogue[] = [];
    for (let i = 0; i < history.length && i < result.messages.length; i++) {
      const original = history[i];
      const comp = result.messages[i];

      if (typeof original.content === 'string' && typeof comp.content === 'string') {
        compressed.push({ role: original.role, content: comp.content });
      } else {
        // Keep complex content as-is (tool_use/tool_result structure can't be modified)
        compressed.push(original);
      }
    }
    // Append any remaining original messages
    for (let i = result.messages.length; i < history.length; i++) {
      compressed.push(history[i]);
    }

    return {
      history: compressed,
      saved: result.originalChars - result.compressedChars,
      ratio: result.compressionRatio,
    };
  } catch (err) {
    if (debug) {
      console.error(`[runcode] Compression failed: ${(err as Error).message}`);
    }
    return null;
  }
}
