/**
 * Token Reduction for Franklin.
 * Original implementation — reduces context size through intelligent pruning.
 *
 * Strategy: instead of compression/encoding, we PRUNE redundant content.
 * The model doesn't need verbose tool outputs from 20 turns ago.
 *
 * Three reduction passes:
 * 1. Tool result aging — progressively shorten old tool results
 * 2. Whitespace normalization — remove excessive blank lines and indentation
 * 3. Stale context removal — drop system info that's been superseded
 */

import type { Dialogue, ContentPart, UserContentPart } from './types.js';
import { estimateTokens } from './tokens.js';

// ─── 1. Tool Result Aging ─────────────────────────────────────────────────

/**
 * Progressively shorten tool results based on age.
 * Recent results: keep full. Older results: keep summary. Very old: keep one line.
 *
 * This is the biggest token saver — a 10KB bash output from 20 turns ago
 * can be reduced to "✓ Bash: ran npm test (exit 0)" saving ~2500 tokens.
 */
export function ageToolResults(history: Dialogue[]): Dialogue[] {
  // Find all tool_result positions
  const toolPositions: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      (msg.content as UserContentPart[]).some(p => p.type === 'tool_result')
    ) {
      toolPositions.push(i);
    }
  }

  if (toolPositions.length <= 3) return history; // Nothing to age

  const result = [...history];
  const totalResults = toolPositions.length;

  for (let idx = 0; idx < toolPositions.length; idx++) {
    const pos = toolPositions[idx];
    const age = totalResults - idx; // Higher = older
    const msg = result[pos];
    if (!Array.isArray(msg.content)) continue;

    const parts = msg.content as UserContentPart[];
    let modified = false;
    const aged: UserContentPart[] = parts.map(part => {
      if (part.type !== 'tool_result') return part;

      // Vision tool_results carry [text, image] arrays. JSON.stringify-ing
      // them and rebuilding `content` as a truncated string drops the
      // image block entirely. Measure only the text portion; aging code
      // below rebuilds as a string only when no image is present, otherwise
      // we leave the part untouched (image bytes are already context-cheap
      // once cached, and turn them into placeholders is the wrong fix).
      let hasImage = false;
      let textOnly = '';
      if (Array.isArray(part.content)) {
        for (const block of part.content as unknown as Array<Record<string, unknown>>) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            textOnly += (textOnly ? '\n' : '') + block.text;
          } else if (block?.type === 'image') {
            hasImage = true;
          }
        }
      }
      const content = typeof part.content === 'string'
        ? part.content
        : Array.isArray(part.content)
          ? textOnly
          : JSON.stringify(part.content);
      const charLen = content.length;

      // Recent 3 results: keep full
      if (age <= 3) return part;
      // Preserve image-bearing tool_results regardless of age — replacing
      // them with a text stub would silently delete the model's vision context.
      if (hasImage) return part;

      // Age 4-8: keep first 500 chars
      if (age <= 8 && charLen > 500) {
        modified = true;
        const truncated = content.slice(0, 500);
        const lastNl = truncated.lastIndexOf('\n');
        const clean = lastNl > 250 ? truncated.slice(0, lastNl) : truncated;
        return {
          ...part,
          content: `${clean}\n... (${charLen - clean.length} chars omitted, ${age} turns ago)`,
        };
      }

      // Age 9-15: keep first 200 chars
      if (age <= 15 && charLen > 200) {
        modified = true;
        const firstLine = content.split('\n')[0].slice(0, 150);
        return {
          ...part,
          content: `${firstLine}\n... (${charLen} chars, ${age} turns ago)`,
        };
      }

      // Age 16+: one line summary
      if (age > 15 && charLen > 80) {
        modified = true;
        const summary = content.split('\n')[0].slice(0, 60);
        return {
          ...part,
          content: part.is_error
            ? `[Error: ${summary}...]`
            : `[Result: ${summary}...]`,
        };
      }

      return part;
    });

    if (modified) {
      result[pos] = { role: 'user', content: aged };
    }
  }

  return result;
}

// ─── 2. Whitespace Normalization ──────────────────────────────────────────

/**
 * Normalize whitespace in text messages.
 * - Collapse 3+ blank lines to 2
 * - Remove trailing spaces
 * - Reduce indentation beyond 8 spaces to 8
 */
export function normalizeWhitespace(history: Dialogue[]): Dialogue[] {
  let modified = false;
  const result = history.map(msg => {
    if (typeof msg.content !== 'string') return msg;
    const original = msg.content;
    const cleaned = original
      .replace(/[ \t]+$/gm, '')           // Trailing spaces
      .replace(/\n{4,}/g, '\n\n\n')       // Max 3 consecutive newlines
      .replace(/^( {9,})/gm, '        '); // Cap indentation at 8 spaces

    if (cleaned !== original) {
      modified = true;
      return { ...msg, content: cleaned };
    }
    return msg;
  });
  return modified ? result : history;
}

// ─── 3. Verbose Assistant Message Trimming ────────────────────────────────

/**
 * Trim very long assistant text messages from old turns.
 * Recent messages: keep full. Old long messages: keep first 1000 chars.
 */
export function trimOldAssistantMessages(history: Dialogue[]): Dialogue[] {
  const MAX_OLD_ASSISTANT_CHARS = 1500;
  const KEEP_RECENT = 4; // Keep last 4 assistant messages full

  let assistantCount = 0;
  for (const msg of history) {
    if (msg.role === 'assistant') assistantCount++;
  }
  if (assistantCount <= KEEP_RECENT) return history;

  let seenAssistant = 0;
  let modified = false;
  const result = history.map(msg => {
    if (msg.role !== 'assistant') return msg;
    seenAssistant++;

    // Keep recent messages full
    if (assistantCount - seenAssistant < KEEP_RECENT) return msg;

    if (typeof msg.content === 'string' && msg.content.length > MAX_OLD_ASSISTANT_CHARS) {
      modified = true;
      const truncated = msg.content.slice(0, MAX_OLD_ASSISTANT_CHARS);
      const lastNl = truncated.lastIndexOf('\n');
      const clean = lastNl > MAX_OLD_ASSISTANT_CHARS / 2 ? truncated.slice(0, lastNl) : truncated;
      return { ...msg, content: clean + '\n... (response truncated)' };
    }

    // Also handle content array with text parts
    if (Array.isArray(msg.content)) {
      const parts = msg.content as ContentPart[];
      let totalChars = 0;
      for (const p of parts) {
        if (p.type === 'text') totalChars += p.text.length;
      }
      if (totalChars > MAX_OLD_ASSISTANT_CHARS) {
        modified = true;
        const trimmedParts = parts.map(p => {
          if (p.type !== 'text' || p.text.length <= 500) return p;
          return { ...p, text: p.text.slice(0, 500) + '\n... (trimmed)' };
        });
        return { ...msg, content: trimmedParts };
      }
    }

    return msg;
  });

  return modified ? result : history;
}

// ─── 4. Deduplication ─────────────────────────────────────────────────────

/**
 * Remove consecutive duplicate messages (same role + same content).
 */
export function deduplicateMessages(history: Dialogue[]): Dialogue[] {
  if (history.length < 3) return history;
  const result: Dialogue[] = [history[0]];
  let modified = false;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    if (curr.role === prev.role && typeof curr.content === 'string' && curr.content === prev.content) {
      modified = true;
      continue;
    }
    result.push(curr);
  }
  return modified ? result : history;
}

// ─── 5. Line-level deduplication in tool results ──────────────────────────

const ANSI_RE_REDUCE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Collapse repeated consecutive lines within tool results.
 * "Fetching...\nFetching...\nFetching...\n" → "Fetching... ×3"
 * Also strips any residual ANSI escape codes from older tool results.
 * RTK-inspired: dedup_lines + strip_ansi pipeline stages.
 */
export function deduplicateToolResultLines(history: Dialogue[]): Dialogue[] {
  let modified = false;
  const result = history.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

    const parts = msg.content as UserContentPart[];
    let partModified = false;
    const newParts = parts.map(part => {
      if (part.type !== 'tool_result') return part;

      // Vision tool_results carry [text, image] arrays. JSON.stringify-ing
      // them and writing back as a string would destroy the image (same
      // bug class as ageToolResults / budgetToolResults — sibling site,
      // verified 2026-05-10 during PR #53 review). For arrays, dedupe
      // only the text segments; image segments pass through untouched.
      let raw: string;
      const imageBlocks: unknown[] = [];
      if (typeof part.content === 'string') {
        raw = part.content;
      } else if (Array.isArray(part.content)) {
        const blocks = part.content as unknown as Array<Record<string, unknown>>;
        const texts: string[] = [];
        for (const b of blocks) {
          if (b?.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          } else if (b?.type === 'image') {
            imageBlocks.push(b);
          }
        }
        raw = texts.join('\n');
      } else {
        raw = JSON.stringify(part.content);
      }

      // Strip ANSI codes
      const stripped = raw.replace(ANSI_RE_REDUCE, '');

      // Collapse repeated consecutive lines
      const lines = stripped.split('\n');
      const deduped: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        let count = 1;
        while (i + count < lines.length && lines[i + count] === line) count++;
        if (count > 2 && line.trim() !== '') {
          deduped.push(`${line} ×${count}`);
        } else {
          for (let k = 0; k < count; k++) deduped.push(line);
        }
        i += count;
      }

      const result = deduped.join('\n');
      if (result === raw) return part;
      partModified = true;
      // If the original content was an array with image blocks, rebuild
      // as an array — keep all image segments, replace the joined text
      // payload with a single deduped text segment. This way dedupe runs
      // for free on image-bearing results without losing vision context.
      if (Array.isArray(part.content) && imageBlocks.length > 0) {
        return {
          ...part,
          content: [
            { type: 'text', text: result },
            ...(imageBlocks as Array<{ type: 'image'; source: unknown }>),
          ],
        } as UserContentPart;
      }
      return { ...part, content: result };
    });

    if (!partModified) return msg;
    modified = true;
    return { ...msg, content: newParts };
  });

  return modified ? result : history;
}

// ─── 6. Repetitive Tool Collapse ─────────────────────────────────────────

/**
 * When the same tool (WebSearch, Grep, etc.) is called 6+ times,
 * collapse all but the last 3 results to one-line summaries.
 * Prevents context snowball from search spam (e.g. 96 WebSearches).
 */
export function collapseRepetitiveTools(history: Dialogue[]): Dialogue[] {
  // Count tool_use by name
  const toolCounts: Map<string, number> = new Map();
  for (const msg of history) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'tool_use') {
        const name = part.name ?? '';
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
    }
  }

  // Only for tools called 6+ times
  const repetitive = new Set<string>();
  for (const [name, count] of toolCounts) {
    if (count >= 6) repetitive.add(name);
  }
  if (repetitive.size === 0) return history;

  // Map tool_use_id → name, track call order per tool
  const idToName: Map<string, string> = new Map();
  const callOrder: Map<string, string[]> = new Map(); // name → [tool_use_id, ...]
  for (const msg of history) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'tool_use' && repetitive.has(part.name ?? '')) {
        const name = part.name ?? '';
        idToName.set(part.id, name);
        if (!callOrder.has(name)) callOrder.set(name, []);
        callOrder.get(name)!.push(part.id);
      }
    }
  }

  // Mark old IDs (all but last 3 per tool)
  const oldIds = new Set<string>();
  for (const [, ids] of callOrder) {
    for (let i = 0; i < ids.length - 3; i++) {
      oldIds.add(ids[i]);
    }
  }
  if (oldIds.size === 0) return history;

  // Collapse old results
  let modified = false;
  const result = history.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const parts = (msg.content as UserContentPart[]).map(part => {
      if (part.type !== 'tool_result' || !oldIds.has(part.tool_use_id)) return part;
      // Image-bearing results (third sibling site of the JSON.stringify
      // bug class — same pattern as ageToolResults / budgetToolResults /
      // deduplicateToolResultLines). Don't collapse; replacing them with
      // a `[first-line...]` string would destroy the vision context.
      // Image bytes are already cache-cheap upstream once prompt-cached;
      // the cost-control intent of this collapser is satisfied without
      // touching them.
      if (Array.isArray(part.content) && part.content.some(
        (b) => (b as { type?: string }).type === 'image'
      )) {
        return part;
      }
      const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      if (content.length <= 80) return part;
      changed = true;
      const first = content.split('\n')[0].slice(0, 60);
      return { ...part, content: `[${first}...]` };
    });
    if (!changed) return msg;
    modified = true;
    return { ...msg, content: parts };
  });

  return modified ? result : history;
}

// ─── Pipeline ────────────────────────────────────────────────────────────

/**
 * Run all token reduction passes on conversation history.
 * Returns same reference if nothing changed (cheap identity check).
 */
export function reduceTokens(history: Dialogue[], debug?: boolean): Dialogue[] {
  if (history.length < 8) return history; // Skip for short conversations

  let current = history;
  let totalSaved = 0;

  // Pass 0: Collapse repetitive tool results (e.g. 96 WebSearches with similar queries)
  const collapsed = collapseRepetitiveTools(current);
  if (collapsed !== current) {
    const before = estimateChars(current);
    current = collapsed;
    totalSaved += before - estimateChars(current);
  }

  // Pass 1: Age old tool results
  const aged = ageToolResults(current);
  if (aged !== current) {
    const before = estimateChars(current);
    current = aged;
    const saved = before - estimateChars(current);
    totalSaved += saved;
  }

  // Pass 2: Normalize whitespace
  const normalized = normalizeWhitespace(current);
  if (normalized !== current) {
    const before = estimateChars(current);
    current = normalized;
    totalSaved += before - estimateChars(current);
  }

  // Pass 3: Trim old verbose assistant messages
  const trimmed = trimOldAssistantMessages(current);
  if (trimmed !== current) {
    const before = estimateChars(current);
    current = trimmed;
    totalSaved += before - estimateChars(current);
  }

  // Pass 4: Remove consecutive duplicate messages
  const deduped = deduplicateMessages(current);
  if (deduped !== current) {
    const before = estimateChars(current);
    current = deduped;
    totalSaved += before - estimateChars(current);
  }

  // Pass 5: Strip ANSI + collapse repeated lines in tool results
  const lineDeduped = deduplicateToolResultLines(current);
  if (lineDeduped !== current) {
    const before = estimateChars(current);
    current = lineDeduped;
    totalSaved += before - estimateChars(current);
  }

  if (debug && totalSaved > 500) {
    const tokensSaved = Math.round(totalSaved / 4);
    console.error(`[franklin] Token reduction: ~${tokensSaved} tokens saved`);
  }

  return current;
}

function estimateChars(history: Dialogue[]): number {
  let total = 0;
  for (const msg of history) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if ('type' in p) {
          if (p.type === 'text') total += p.text.length;
          else if (p.type === 'tool_result') {
            // Sibling of PR #54's tokens.ts fix: JSON.stringify-ing a
            // [{text}, {image}] array counts the base64 `data` field as
            // text and inflates the char count by ~70K per image. That
            // skews every reduce-pass decision (when to dedupe, when to
            // collapse) toward "save chars by collapsing the image-
            // bearing result" — exactly wrong. Walk blocks instead.
            if (typeof p.content === 'string') {
              total += p.content.length;
            } else if (Array.isArray(p.content)) {
              for (const block of p.content) {
                if ((block as { type?: string }).type === 'text') {
                  total += ((block as { text?: string }).text || '').length;
                } else if ((block as { type?: string }).type === 'image') {
                  // Mirror tokens.ts: image ≈ 1500 tokens ≈ ~6K chars
                  // at the 4-chars/token rule estimateTokens uses.
                  total += 6000;
                }
              }
            }
          } else if (p.type === 'tool_use') {
            total += JSON.stringify(p.input).length;
          }
        }
      }
    }
  }
  return total;
}
