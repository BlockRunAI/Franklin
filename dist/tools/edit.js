/**
 * Edit capability — targeted string replacement in files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { partiallyReadFiles, fileReadTracker, invalidateFileCache } from './read.js';
/**
 * Normalize curly/smart quotes to straight quotes.
 * Claude Code does this to handle API-sanitized strings and editor paste artifacts.
 */
function normalizeQuotes(str) {
    return str
        .replace(/[\u201C\u201D]/g, '"') // " " → "
        .replace(/[\u2018\u2019]/g, "'"); // ' ' → '
}
async function execute(input, ctx) {
    const { file_path: filePath, old_string: oldStr, new_string: newStr, replace_all: replaceAll } = input;
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
    // Enforce read-before-edit: the model must Read the file before editing it
    const readRecord = fileReadTracker.get(resolved);
    if (!readRecord) {
        return {
            output: `Error: you must Read this file before editing it. Use Read to understand the current content first.\nFile: ${resolved}`,
            isError: true,
        };
    }
    // Check if the file was modified since it was last read (stale write detection)
    try {
        const currentStat = fs.statSync(resolved);
        if (currentStat.mtimeMs !== readRecord.mtimeMs) {
            return {
                output: `Warning: ${resolved} has been modified since you last read it. Read the file again to see the current content before editing.`,
                isError: true,
            };
        }
    }
    catch { /* file may have been deleted — will be caught below */ }
    // Check if the file was only partially read — used for smarter warning below
    const partialInfo = partiallyReadFiles.get(resolved);
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
                // Find the original text in content that corresponds to the normalized match.
                // IMPORTANT: We can't use normalized.length to slice the original content because
                // smart quotes are multi-byte in UTF-8 (3 bytes) while straight quotes are 1 byte.
                // Instead, we map the character index from the normalized string back to the original.
                const normIdx = contentNormalized.indexOf(normalized);
                // Walk through content character-by-character, mapping normalized positions to original positions
                let origStart = -1;
                let origEnd = -1;
                let normPos = 0;
                for (let i = 0; i < content.length; i++) {
                    if (normPos === normIdx && origStart === -1) {
                        origStart = i;
                    }
                    if (normPos === normIdx + normalized.length) {
                        origEnd = i;
                        break;
                    }
                    // Both content and contentNormalized have same character count (quote replacement is 1:1 char)
                    normPos++;
                }
                if (origStart !== -1) {
                    if (origEnd === -1)
                        origEnd = content.length;
                    effectiveOldStr = content.slice(origStart, origEnd);
                }
            }
        }
        if (!content.includes(effectiveOldStr)) {
            // Find lines containing fragments of old_string for helpful context
            const lines = content.split('\n');
            const searchTerms = oldStr.split('\n').map(l => l.trim()).filter(l => l.length > 3);
            const matchedLines = [];
            if (searchTerms.length > 0) {
                for (let i = 0; i < lines.length && matchedLines.length < 5; i++) {
                    if (searchTerms.some(term => lines[i].includes(term))) {
                        matchedLines.push({ num: i + 1, text: lines[i] });
                    }
                }
            }
            let hint;
            if (matchedLines.length > 0) {
                const preview = matchedLines.map(m => `${m.num}\t${m.text}`).join('\n');
                hint = `\n\nSimilar lines found:\n${preview}\n\nCheck for whitespace or formatting differences.`;
            }
            else {
                const preview = lines.slice(0, 10).map((l, i) => `${i + 1}\t${l}`).join('\n');
                hint = `\n\nFirst 10 lines of file:\n${preview}`;
            }
            return {
                output: `Error: old_string not found in ${resolved}.${hint}`,
                isError: true,
            };
        }
        let updated;
        let matchCount;
        if (replaceAll) {
            matchCount = content.split(effectiveOldStr).length - 1;
            updated = content.split(effectiveOldStr).join(newStr);
        }
        else {
            const firstIdx = content.indexOf(effectiveOldStr);
            const secondIdx = content.indexOf(effectiveOldStr, firstIdx + 1);
            if (secondIdx !== -1) {
                const positions = [];
                let searchFrom = 0;
                while (true) {
                    const idx = content.indexOf(effectiveOldStr, searchFrom);
                    if (idx === -1)
                        break;
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
        // File has been modified — invalidate caches so next read is fresh
        partiallyReadFiles.delete(resolved);
        invalidateFileCache(resolved);
        // Update read tracker mtime so subsequent edits don't trigger stale-write detection
        const newStat = fs.statSync(resolved);
        fileReadTracker.set(resolved, { mtimeMs: newStat.mtimeMs, readAt: Date.now() });
        // Build a concise diff preview
        const oldLines = effectiveOldStr.split('\n');
        const newLines = newStr.split('\n');
        let diffPreview = '';
        if (oldLines.length <= 5 && newLines.length <= 5) {
            const removed = oldLines.map(l => `- ${l}`).join('\n');
            const added = newLines.map(l => `+ ${l}`).join('\n');
            diffPreview = `\n${removed}\n${added}`;
        }
        else {
            diffPreview = ` (${oldLines.length} lines → ${newLines.length} lines)`;
        }
        // Only warn about partial read if the edit target is near or beyond the read boundary.
        // A normal Read(limit=2000) on a 10K line file shouldn't warn if editing line 50.
        let partialWarning = '';
        if (partialInfo) {
            const editLine = content.slice(0, content.indexOf(effectiveOldStr)).split('\n').length;
            const nearBoundary = editLine >= partialInfo.endLine - 10 || editLine < partialInfo.startLine;
            if (nearBoundary) {
                partialWarning = `\nWarning: file was only partially read (lines ${partialInfo.startLine}-${partialInfo.endLine} of ${partialInfo.totalLines}). This edit is near the boundary — consider reading more of the file.`;
            }
        }
        return {
            output: `Updated ${resolved} — ${matchCount} replacement${matchCount > 1 ? 's' : ''} made.${diffPreview}${partialWarning}`,
            diff: { file: resolved, oldLines, newLines, count: matchCount },
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Error editing file: ${msg}`, isError: true };
    }
}
export const editCapability = {
    spec: {
        name: 'Edit',
        description: `Perform exact string replacements in files.

Usage:
- You MUST use Read at least once before editing. This tool will error if you attempt an edit without reading the file first.
- When editing text from Read output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- old_string and new_string must be different.
- If the file has been modified since your last Read (by linter, formatter, or another tool), the edit will fail with a stale-write warning. Read the file again to get the current content.

IMPORTANT: Always use Edit instead of sed or awk via Bash.`,
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'The absolute path to the file to modify' },
                old_string: { type: 'string', description: 'The text to replace (must be different from new_string)' },
                new_string: { type: 'string', description: 'The text to replace it with' },
                replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    execute,
    concurrent: false,
};
