/**
 * Edit capability — targeted string replacement in files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { partiallyReadFiles } from './read.js';

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Normalize curly/smart quotes to straight quotes.
 * Claude Code does this to handle API-sanitized strings and editor paste artifacts.
 */
function normalizeQuotes(str: string): string {
  return str
    .replace(/[\u201C\u201D]/g, '"')   // " " → "
    .replace(/[\u2018\u2019]/g, "'");  // ' ' → '
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { file_path: filePath, old_string: oldStr, new_string: newStr, replace_all: replaceAll } =
    input as unknown as EditInput;

  if (!filePath) {
    return { output: 'Error: file_path is required', isError: true };
  }
  if (oldStr === undefined || oldStr === null) {
    return { output: 'Error: old_string is required', isError: true };
  }
  if (newStr === undefined || newStr === null) {
    return { output: 'Error: new_string is required', isError: true };
  }
  if (oldStr === newStr) {
    return { output: 'Error: old_string and new_string are identical', isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);

  // Warn if the file was only partially read — editing without full context risks mistakes
  const isPartial = partiallyReadFiles.has(resolved);

  try {
    if (!fs.existsSync(resolved)) {
      return { output: `Error: file not found: ${resolved}`, isError: true };
    }

    const content = fs.readFileSync(resolved, 'utf-8');

    // Try exact match first, then quote-normalized fallback
    let effectiveOldStr = oldStr;
    if (!content.includes(oldStr)) {
      const normalized = normalizeQuotes(oldStr);
      const contentNormalized = normalizeQuotes(content);
      if (normalized !== oldStr && contentNormalized.includes(normalized)) {
        // Find the original text in content that corresponds to the normalized match
        const idx = contentNormalized.indexOf(normalized);
        effectiveOldStr = content.slice(idx, idx + normalized.length);
      }
    }

    if (!content.includes(effectiveOldStr)) {
      // Find lines containing fragments of old_string for helpful context
      const lines = content.split('\n');
      const searchTerms = oldStr.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      const matchedLines: { num: number; text: string }[] = [];

      if (searchTerms.length > 0) {
        for (let i = 0; i < lines.length && matchedLines.length < 5; i++) {
          if (searchTerms.some(term => lines[i].includes(term))) {
            matchedLines.push({ num: i + 1, text: lines[i] });
          }
        }
      }

      let hint: string;
      if (matchedLines.length > 0) {
        const preview = matchedLines.map(m => `${m.num}\t${m.text}`).join('\n');
        hint = `\n\nSimilar lines found:\n${preview}\n\nCheck for whitespace or formatting differences.`;
      } else {
        const preview = lines.slice(0, 10).map((l, i) => `${i + 1}\t${l}`).join('\n');
        hint = `\n\nFirst 10 lines of file:\n${preview}`;
      }

      return {
        output: `Error: old_string not found in ${resolved}.${hint}`,
        isError: true,
      };
    }

    let updated: string;
    let matchCount: number;

    if (replaceAll) {
      matchCount = content.split(effectiveOldStr).length - 1;
      updated = content.split(effectiveOldStr).join(newStr);
    } else {
      const firstIdx = content.indexOf(effectiveOldStr);
      const secondIdx = content.indexOf(effectiveOldStr, firstIdx + 1);

      if (secondIdx !== -1) {
        const positions: number[] = [];
        let searchFrom = 0;
        while (true) {
          const idx = content.indexOf(effectiveOldStr, searchFrom);
          if (idx === -1) break;
          const lineNum = content.slice(0, idx).split('\n').length;
          positions.push(lineNum);
          searchFrom = idx + 1;
        }
        return {
          output: `Error: old_string matches ${positions.length} locations (lines: ${positions.join(', ')}). ` +
            `Provide more context to make it unique, or use replace_all: true.`,
          isError: true,
        };
      }

      matchCount = 1;
      updated = content.slice(0, firstIdx) + newStr + content.slice(firstIdx + effectiveOldStr.length);
    }

    fs.writeFileSync(resolved, updated, 'utf-8');
    // File has been modified — remove from partial-read tracking so next read is fresh
    partiallyReadFiles.delete(resolved);

    // Build a concise diff preview
    const oldLines = effectiveOldStr.split('\n');
    const newLines = newStr.split('\n');
    let diffPreview = '';
    if (oldLines.length <= 5 && newLines.length <= 5) {
      const removed = oldLines.map(l => `- ${l}`).join('\n');
      const added = newLines.map(l => `+ ${l}`).join('\n');
      diffPreview = `\n${removed}\n${added}`;
    } else {
      diffPreview = ` (${oldLines.length} lines → ${newLines.length} lines)`;
    }

    const partialWarning = isPartial
      ? '\nNote: file was only partially read before this edit.'
      : '';

    return {
      output: `Updated ${resolved} — ${matchCount} replacement${matchCount > 1 ? 's' : ''} made.${diffPreview}${partialWarning}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error editing file: ${msg}`, isError: true };
  }
}

export const editCapability: CapabilityHandler = {
  spec: {
    name: 'Edit',
    description: 'Replace a specific string in a file. By default requires the old_string to be unique; use replace_all for multiple replacements.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  execute,
  concurrent: false,
};
