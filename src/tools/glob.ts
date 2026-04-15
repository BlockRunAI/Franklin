/**
 * Glob capability — file pattern matching using native fs.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface GlobInput {
  pattern: string;
  path?: string;
}

const MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 12_000; // ~3,000 tokens — prevents huge glob results from blowing up context

/**
 * Simple glob matcher supporting *, **, and ? wildcards.
 * No external dependencies.
 */
function globMatch(pattern: string, text: string): boolean {
  const regexStr = pattern
    .replace(/\\/g, '/')
    .split('**/')
    .map(segment =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
    )
    .join('(?:.*/)?');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(text.replace(/\\/g, '/'));
}

function walkDirectory(
  dir: string,
  baseDir: string,
  pattern: string,
  results: string[],
  depth: number,
  visited?: Set<string>
): void {
  if (depth > 50 || results.length >= MAX_RESULTS) return;

  // Symlink loop protection
  const visitedSet = visited ?? new Set<string>();
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (visitedSet.has(realDir)) return;
  visitedSet.add(realDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Permission denied or similar
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    // Skip hidden dirs and common large dirs
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isSymlinkDir(path.join(dir, entry.name)));
    if (entry.name.startsWith('.') && isDir) continue;
    if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') continue;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isFile() || (entry.isSymbolicLink() && !isDir)) {
      if (globMatch(pattern, relativePath)) {
        results.push(fullPath);
      }
    } else if (isDir) {
      // Recurse for ** patterns; for patterns with /, only recurse if current dir is on the path
      if (pattern.includes('**')) {
        walkDirectory(fullPath, baseDir, pattern, results, depth + 1, visitedSet);
      } else if (pattern.includes('/')) {
        // Check if this directory could be part of the pattern path
        const relativePath = path.relative(baseDir, fullPath);
        const patternDir = pattern.split('/').slice(0, -1).join('/');
        if (patternDir.startsWith(relativePath) || relativePath.startsWith(patternDir)) {
          walkDirectory(fullPath, baseDir, pattern, results, depth + 1, visitedSet);
        }
      }
    }
  }
}

function isSymlinkDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { pattern, path: searchPath } = input as unknown as GlobInput;

  if (!pattern) {
    return { output: 'Error: pattern is required', isError: true };
  }

  const baseDir = searchPath
    ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(ctx.workingDir, searchPath))
    : ctx.workingDir;

  if (!fs.existsSync(baseDir)) {
    return { output: `Error: directory not found: ${baseDir}`, isError: true };
  }

  const results: string[] = [];
  walkDirectory(baseDir, baseDir, pattern, results, 0);

  // Sort by modification time (most recent first)
  const withMtime = results.map(f => {
    try {
      return { path: f, mtime: fs.statSync(f).mtimeMs };
    } catch {
      return { path: f, mtime: 0 };
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  // Convert to relative paths to save tokens
  const sorted = withMtime.map(f => {
    const rel = path.relative(ctx.workingDir, f.path);
    return rel.startsWith('..') ? f.path : rel;
  });

  if (sorted.length === 0) {
    // Suggest recursive pattern if user used non-recursive glob
    const hint = !pattern.includes('**') && !pattern.includes('/')
      ? ` Try "**/${pattern}" for recursive search.`
      : '';
    return { output: `No files matched pattern "${pattern}" in ${baseDir}.${hint}` };
  }

  // Group by directory for compact output (saves 30-40% tokens on large results)
  let output: string;
  if (sorted.length > 10) {
    const grouped = new Map<string, string[]>();
    for (const p of sorted) {
      const dir = path.dirname(p);
      if (!grouped.has(dir)) grouped.set(dir, []);
      grouped.get(dir)!.push(path.basename(p));
    }
    const parts: string[] = [];
    for (const [dir, files] of grouped) {
      if (files.length === 1) {
        parts.push(`${dir}/${files[0]}`);
      } else {
        parts.push(`${dir}/  (${files.length} files)`);
        for (const f of files) parts.push(`  ${f}`);
      }
    }
    output = parts.join('\n');
  } else {
    output = sorted.join('\n');
  }

  if (sorted.length >= MAX_RESULTS) {
    output += `\n\n... (limited to ${MAX_RESULTS} results. Use a more specific pattern.)`;
  }

  // Cap total output length to prevent context bloat
  if (output.length > MAX_OUTPUT_CHARS) {
    const lines = output.split('\n');
    let trimmed = '';
    let count = 0;
    for (const line of lines) {
      if ((trimmed + line).length > MAX_OUTPUT_CHARS) break;
      trimmed += (trimmed ? '\n' : '') + line;
      count++;
    }
    const remaining = lines.length - count;
    if (remaining > 0) {
      output = `${trimmed}\n... (${remaining} more not shown — use a more specific pattern)`;
    }
  }

  return { output };
}

export const globCapability: CapabilityHandler = {
  spec: {
    name: 'Glob',
    description: `Fast file pattern matching tool that works with any codebase size.

Usage:
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time (most recent first)
- Use this when you need to find files by name patterns
- Skips node_modules, .git, __pycache__ automatically
- Returns up to 200 results
- When doing an open-ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead

IMPORTANT: Always use Glob instead of find or ls via Bash.`,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.tsx")' },
        path: { type: 'string', description: 'The directory to search in. Defaults to working directory.' },
      },
      required: ['pattern'],
    },
  },
  execute,
  concurrent: true,
};
