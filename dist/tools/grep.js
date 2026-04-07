/**
 * Grep capability — search file contents using ripgrep or native fallback.
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const MAX_GREP_OUTPUT_CHARS = 16_000; // ~4,000 tokens — prevents huge grep results
let _hasRipgrep = null;
function hasRipgrep() {
    if (_hasRipgrep !== null)
        return _hasRipgrep;
    try {
        execSync('rg --version', { stdio: 'pipe' });
        _hasRipgrep = true;
    }
    catch {
        _hasRipgrep = false;
    }
    return _hasRipgrep;
}
async function execute(input, ctx) {
    const opts = input;
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
        return runRipgrep(opts, searchPath, mode, limit, ctx.workingDir);
    }
    return runNativeGrep(opts, searchPath, mode, limit, ctx.workingDir);
}
function toRelative(absPath, cwd) {
    const rel = path.relative(cwd, absPath);
    return rel.startsWith('..') ? absPath : rel;
}
function runRipgrep(opts, searchPath, mode, limit, cwd) {
    const args = [];
    // Limit line length to prevent base64/minified content from cluttering output
    args.push('--max-columns', '500');
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
            else {
                if (opts.before_context && opts.before_context > 0)
                    args.push(`-B${opts.before_context}`);
                if (opts.after_context && opts.after_context > 0)
                    args.push(`-A${opts.after_context}`);
            }
            break;
    }
    if (opts.case_insensitive)
        args.push('-i');
    if (opts.multiline)
        args.push('-U', '--multiline-dotall');
    if (opts.glob)
        args.push(`--glob=${opts.glob}`);
    // Always exclude common noise + lock files (huge, rarely useful)
    args.push('--glob=!node_modules', '--glob=!.git', '--glob=!dist', '--glob=!*.lock', '--glob=!package-lock.json', '--glob=!pnpm-lock.yaml');
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
        // Convert absolute paths to relative paths to save tokens (same as Claude Code)
        const relativized = limited.map(line => {
            // Lines: /abs/path or /abs/path:rest (content mode)
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0 && line.startsWith('/')) {
                const filePart = line.slice(0, colonIdx);
                return toRelative(filePart, cwd) + line.slice(colonIdx);
            }
            return line.startsWith('/') ? toRelative(line, cwd) : line;
        });
        let output = relativized.join('\n');
        if (lines.length > limited.length) {
            output += `\n\n... (${lines.length - limited.length} more results, use head_limit to see more)`;
        }
        // Cap total output to prevent context bloat
        if (output.length > MAX_GREP_OUTPUT_CHARS) {
            output = output.slice(0, MAX_GREP_OUTPUT_CHARS) + `\n... (output capped at ${MAX_GREP_OUTPUT_CHARS / 1000}KB — use more specific pattern or head_limit)`;
        }
        return { output: output || 'No matches found' };
    }
    catch (err) {
        const exitErr = err;
        if (exitErr.status === 1) {
            return { output: 'No matches found' };
        }
        return {
            output: `Grep error: ${exitErr.stderr || err.message}`,
            isError: true,
        };
    }
}
function runNativeGrep(opts, searchPath, mode, limit, cwd) {
    const args = ['-r', '-n'];
    if (opts.case_insensitive)
        args.push('-i');
    switch (mode) {
        case 'files_with_matches':
            args.push('-l');
            break;
        case 'count':
            args.push('-c');
            break;
    }
    if (opts.glob) {
        // Native grep --include doesn't support ** or path separators
        // Extract file extension pattern for best compatibility
        const nativeGlob = opts.glob
            .replace(/^\*\*\//, '') // Strip leading **/
            .replace(/^.*\//, '') // Strip path prefix (src/ etc.)
            .replace(/\*\*/, '*'); // Convert ** to * for flat matching
        args.push(`--include=${nativeGlob}`);
    }
    args.push('--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude=*.lock', '--exclude=package-lock.json', '--exclude=pnpm-lock.yaml');
    args.push('-e', opts.pattern, searchPath);
    try {
        const result = execFileSync('grep', args, {
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const lines = result.split('\n').filter(Boolean);
        const limited = limit > 0 ? lines.slice(0, limit) : lines;
        const relativized = limited.map(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0 && line.startsWith('/')) {
                return toRelative(line.slice(0, colonIdx), cwd) + line.slice(colonIdx);
            }
            return line.startsWith('/') ? toRelative(line, cwd) : line;
        });
        let output = relativized.join('\n');
        if (lines.length > limited.length) {
            output += `\n\n... (${lines.length - limited.length} more results)`;
        }
        if (output.length > MAX_GREP_OUTPUT_CHARS) {
            output = output.slice(0, MAX_GREP_OUTPUT_CHARS) + `\n... (output capped at ${MAX_GREP_OUTPUT_CHARS / 1000}KB)`;
        }
        return { output: output || 'No matches found' };
    }
    catch (err) {
        const exitErr = err;
        if (exitErr.status === 1) {
            return { output: 'No matches found' };
        }
        return { output: `Grep error: ${err.message}`, isError: true };
    }
}
export const grepCapability = {
    spec: {
        name: 'Grep',
        description: 'Search file contents by regex. Default output: file paths. output_mode "content" returns matching lines. Skips node_modules/.git/dist.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern' },
                path: { type: 'string', description: 'File or dir to search (default: cwd)' },
                glob: { type: 'string', description: 'File filter e.g. "*.ts"' },
                output_mode: { type: 'string', description: '"content" | "files_with_matches" | "count". Default: files_with_matches' },
                context: { type: 'number', description: 'Context lines around match' },
                before_context: { type: 'number', description: 'Lines before match' },
                after_context: { type: 'number', description: 'Lines after match' },
                case_insensitive: { type: 'boolean' },
                head_limit: { type: 'number', description: 'Max results (default 250)' },
                multiline: { type: 'boolean', description: 'Match across lines' },
            },
            required: ['pattern'],
        },
    },
    execute,
    concurrent: true,
};
