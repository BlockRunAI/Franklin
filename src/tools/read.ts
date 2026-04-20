/**
 * Read capability — reads files with line numbers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

/**
 * Tracks files that were only partially read (offset or limit applied).
 * Stores the read range so Edit tool can give smarter warnings —
 * only warns if the edit target is near/beyond the boundary of what was read.
 * Exported so edit.ts can check and clear entries.
 */
export const partiallyReadFiles = new Map<string, { startLine: number; endLine: number; totalLines: number }>();

/**
 * Tracks files that have been read in this session — enables read-before-edit enforcement.
 * Stores the file's mtime at read time so we can detect stale writes.
 * Exported so edit.ts and write.ts can check.
 */
export const fileReadTracker = new Map<string, { mtimeMs: number; readAt: number }>();

/**
 * File state cache — avoids re-reading unchanged files across turns.
 * Stores mtime + line count for each file. If the model requests a Read
 * and the file hasn't changed (same mtime), return a short stub instead
 * of the full content. This saves thousands of tokens on repeated reads.
 *
 * Cache is invalidated when:
 * - File mtime changes (edited externally or by Edit/Write tool)
 * - Different offset/limit is requested (user wants a different section)
 */
const fileContentCache = new Map<string, { mtimeMs: number; lineCount: number; readRange: string }>();

function cacheKey(resolved: string, offset?: number, limit?: number): string {
  return `${offset ?? 0}:${limit ?? 2000}`;
}

/** Invalidate the content cache for a file (call after Edit/Write modifies it). */
export function invalidateFileCache(resolvedPath: string): void {
  fileContentCache.delete(resolvedPath);
}

/**
 * Reset all module-level tracking state for a fresh session.
 *
 * These Maps live at module scope (not inside a class) because read/edit/write
 * tools share them to enforce "read-before-edit" and to cache unchanged files.
 * When a library caller invokes `interactiveSession()` a second time in the
 * same process, stale entries from the prior session would:
 *   - make Edit/Write falsely believe files were read in this session
 *   - serve cached content for files that may have changed externally
 *   - keep partial-read bounds from the wrong session
 * Called from the agent loop at session start to guarantee a clean slate.
 */
export function clearSessionState(): void {
  fileReadTracker.clear();
  partiallyReadFiles.clear();
  fileContentCache.clear();
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { file_path: filePath, offset, limit } = input as unknown as ReadInput;

  if (!filePath) {
    return { output: 'Error: file_path is required', isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);

  try {
    const stat = fs.statSync(resolved);

    // File state cache: if file hasn't changed and same range requested, return stub
    const range = cacheKey(resolved, offset, limit);
    const cached = fileContentCache.get(resolved);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.readRange === range) {
      return {
        output: `File unchanged since last read (${cached.lineCount} lines). Content is already in your context — do not re-read it.`,
      };
    }

    if (stat.isDirectory()) {
      // Helpfully list directory contents instead of just erroring
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name + '/');
      const files = entries.filter(e => e.isFile()).map(e => e.name);
      const listing = [...dirs.sort(), ...files.sort()].slice(0, 100);
      return { output: `Directory: ${resolved}\n${listing.join('\n')}${entries.length > 100 ? `\n... (${entries.length - 100} more)` : ''}` };
    }

    // Size guard: skip huge files
    const maxBytes = 2 * 1024 * 1024; // 2MB
    if (stat.size > maxBytes) {
      return { output: `Error: file is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset/limit to read a portion.`, isError: true };
    }

    // Detect binary files — first by extension, then by content
    // (some binaries have no extension: `.env.enc`, `.data`, compiled tools
    // without suffixes, etc. Content sniff catches those.)
    const ext = path.extname(resolved).toLowerCase();
    const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib']);
    if (binaryExts.has(ext)) {
      const sizeStr = stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
      return { output: `Binary file: ${resolved} (${ext}, ${sizeStr}). Cannot display contents.` };
    }
    // NUL-byte content sniff — read up to 8KB as a Buffer, scan for 0x00.
    // Text files effectively never contain NUL; binary files almost always
    // do within the first few KB.
    try {
      const SNIFF_BYTES = Math.min(stat.size, 8192);
      if (SNIFF_BYTES > 0) {
        const fd = fs.openSync(resolved, 'r');
        const buf = Buffer.alloc(SNIFF_BYTES);
        fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
        fs.closeSync(fd);
        if (buf.includes(0)) {
          const sizeStr = stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
          return { output: `Binary file: ${resolved} (no text extension but NUL bytes detected, ${sizeStr}). Cannot display contents.` };
        }
      }
    } catch { /* best-effort sniff — fall through to text read */ }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const allLines = raw.split('\n');

    const startLine = Math.max(0, (Math.max(1, offset ?? 1)) - 1);
    const maxLines = limit ?? 2000;
    const endLine = Math.min(allLines.length, startLine + maxLines);
    const slice = allLines.slice(startLine, endLine);

    // Track partial reads — store the range so Edit can give smarter warnings
    const isPartial = startLine > 0 || endLine < allLines.length;
    if (isPartial) {
      partiallyReadFiles.set(resolved, {
        startLine: startLine + 1, // 1-based
        endLine,
        totalLines: allLines.length,
      });
    } else {
      // Full read — clear any stale partial flag
      partiallyReadFiles.delete(resolved);
    }

    // Record this read for read-before-edit/write enforcement
    fileReadTracker.set(resolved, { mtimeMs: stat.mtimeMs, readAt: Date.now() });

    // Update file state cache (for cross-turn dedup)
    fileContentCache.set(resolved, { mtimeMs: stat.mtimeMs, lineCount: allLines.length, readRange: range });

    // Format with line numbers (cat -n style)
    const numbered = slice.map((line, i) => `${startLine + i + 1}\t${line}`);

    let result = numbered.join('\n');
    if (endLine < allLines.length) {
      result += `\n\n... (${allLines.length - endLine} more lines. Use offset=${endLine + 1} to continue.)`;
    }

    return { output: result || '(empty file)' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return { output: `Error: file not found: ${resolved}`, isError: true };
    }
    if (msg.includes('EACCES')) {
      return { output: `Error: permission denied: ${resolved}`, isError: true };
    }
    return { output: `Error reading file: ${msg}`, isError: true };
  }
}

export const readCapability: CapabilityHandler = {
  spec: {
    name: 'Read',
    description: `Read a file from the local filesystem. You can access any file directly by using this tool.

Assume this tool is able to read all files on the machine. If the user provides a path to a file, assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path.
- By default, reads up to 2000 lines starting from the beginning of the file.
- When you already know which part of the file you need, only read that part using offset/limit. This can be important for larger files.
- Results are returned in cat -n format, with line numbers starting at 1.
- This tool can only read files, not directories. To list a directory, use Glob or ls via Bash.
- If you read a file that exists but has empty contents you will receive a warning.
- Reads over 2MB are rejected — use offset/limit to read portions.
- Cannot read binary files (images, PDFs, archives).
- You will regularly be asked to read screenshots or images. If the user provides a path, ALWAYS use this tool to view it.

IMPORTANT: Always use Read instead of cat, head, or tail via Bash. This tool provides line numbers and integrates with Edit's read-before-edit enforcement.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number', description: 'The line number to start reading from (1-based). Only provide if the file is too large to read at once.' },
        limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once. Default: 2000.' },
      },
      required: ['file_path'],
    },
  },
  execute,
  concurrent: true,
};
