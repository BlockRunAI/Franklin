/**
 * Grep capability — search file contents using ripgrep or native fallback.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  context?: number;
  case_insensitive?: boolean;
  head_limit?: number;
}

let _hasRipgrep: boolean | null = null;
function hasRipgrep(): boolean {
  if (_hasRipgrep !== null) return _hasRipgrep;
  try {
    execSync('rg --version', { stdio: 'pipe' });
    _hasRipgrep = true;
  } catch {
    _hasRipgrep = false;
  }
  return _hasRipgrep;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const opts = input as unknown as GrepInput;

  if (!opts.pattern) {
    return { output: 'Error: pattern is required', isError: true };
  }

  const searchPath = opts.path
    ? (path.isAbsolute(opts.path) ? opts.path : path.resolve(ctx.workingDir, opts.path))
    : ctx.workingDir;

  if (!fs.existsSync(searchPath)) {
    return { output: `Error: path not found: ${searchPath}`, isError: true };
  }

  const mode = opts.output_mode || 'files_with_matches';
  const limit = opts.head_limit ?? 250;

  if (hasRipgrep()) {
    return runRipgrep(opts, searchPath, mode, limit);
  }
  return runNativeGrep(opts, searchPath, mode, limit);
}

function runRipgrep(
  opts: GrepInput,
  searchPath: string,
  mode: string,
  limit: number
): CapabilityResult {
  const args: string[] = [];

  switch (mode) {
    case 'files_with_matches':
      args.push('-l');
      break;
    case 'count':
      args.push('-c');
      break;
    case 'content':
      args.push('-n');
      if (opts.context && opts.context > 0) {
        args.push(`-C${opts.context}`);
      }
      break;
  }

  if (opts.case_insensitive) args.push('-i');
  if (opts.glob) args.push(`--glob=${opts.glob}`);

  // Always exclude common noise
  args.push('--glob=!node_modules', '--glob=!.git', '--glob=!dist');

  args.push('--', opts.pattern);
  args.push(searchPath);

  try {
    const result = execFileSync('rg', args, {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = result.split('\n').filter(Boolean);
    const limited = limit > 0 ? lines.slice(0, limit) : lines;
    let output = limited.join('\n');

    if (lines.length > limited.length) {
      output += `\n\n... (${lines.length - limited.length} more results, use head_limit to see more)`;
    }

    return { output: output || 'No matches found' };
  } catch (err) {
    const exitErr = err as { status?: number; stdout?: string; stderr?: string };
    if (exitErr.status === 1) {
      return { output: 'No matches found' };
    }
    return {
      output: `Grep error: ${exitErr.stderr || (err as Error).message}`,
      isError: true,
    };
  }
}

function runNativeGrep(
  opts: GrepInput,
  searchPath: string,
  mode: string,
  limit: number
): CapabilityResult {
  const args: string[] = ['-r', '-n'];

  if (opts.case_insensitive) args.push('-i');

  switch (mode) {
    case 'files_with_matches':
      args.push('-l');
      break;
    case 'count':
      args.push('-c');
      break;
  }

  if (opts.glob) {
    // Native grep doesn't support recursive globs like **/*.ts — strip leading **/
    const nativeGlob = opts.glob.replace(/^\*\*\//, '');
    args.push(`--include=${nativeGlob}`);
  }

  args.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist');
  args.push('-e', opts.pattern, searchPath);

  try {
    const result = execFileSync('grep', args, {
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = result.split('\n').filter(Boolean);
    const limited = limit > 0 ? lines.slice(0, limit) : lines;
    let output = limited.join('\n');

    if (lines.length > limited.length) {
      output += `\n\n... (${lines.length - limited.length} more results)`;
    }

    return { output: output || 'No matches found' };
  } catch (err) {
    const exitErr = err as { status?: number };
    if (exitErr.status === 1) {
      return { output: 'No matches found' };
    }
    return { output: `Grep error: ${(err as Error).message}`, isError: true };
  }
}

export const grepCapability: CapabilityHandler = {
  spec: {
    name: 'Grep',
    description: 'Search file contents by regex pattern. Default: returns file paths (files_with_matches). Use output_mode "content" for matching lines with context. Skips node_modules, .git, dist.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to working directory.' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts")' },
        output_mode: {
          type: 'string',
          description: 'Output mode: "content" (matching lines), "files_with_matches" (file paths), "count" (match counts). Default: files_with_matches',
        },
        context: { type: 'number', description: 'Lines of context around each match (content mode only)' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search' },
        head_limit: { type: 'number', description: 'Max results to return. Default: 250' },
      },
      required: ['pattern'],
    },
  },
  execute,
  concurrent: true,
};
