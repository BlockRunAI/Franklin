/**
 * Glob capability — file pattern matching using native fs.
 */
import fs from 'node:fs';
import path from 'node:path';
const MAX_RESULTS = 500;
/**
 * Simple glob matcher supporting *, **, and ? wildcards.
 * No external dependencies.
 */
function globMatch(pattern, text) {
    const regexStr = pattern
        .replace(/\\/g, '/')
        .split('**/')
        .map(segment => segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'))
        .join('(?:.*/)?');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(text.replace(/\\/g, '/'));
}
function walkDirectory(dir, baseDir, pattern, results, depth) {
    if (depth > 20 || results.length >= MAX_RESULTS)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return; // Permission denied or similar
    }
    for (const entry of entries) {
        if (results.length >= MAX_RESULTS)
            break;
        // Skip hidden dirs and common large dirs
        if (entry.name.startsWith('.') && entry.isDirectory())
            continue;
        if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git')
            continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        if (entry.isFile()) {
            if (globMatch(pattern, relativePath)) {
                results.push(fullPath);
            }
        }
        else if (entry.isDirectory()) {
            // Always recurse if pattern contains **
            if (pattern.includes('**') || pattern.includes('/')) {
                walkDirectory(fullPath, baseDir, pattern, results, depth + 1);
            }
        }
    }
}
async function execute(input, ctx) {
    const { pattern, path: searchPath } = input;
    if (!pattern) {
        return { output: 'Error: pattern is required', isError: true };
    }
    const baseDir = searchPath
        ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(ctx.workingDir, searchPath))
        : ctx.workingDir;
    if (!fs.existsSync(baseDir)) {
        return { output: `Error: directory not found: ${baseDir}`, isError: true };
    }
    const results = [];
    walkDirectory(baseDir, baseDir, pattern, results, 0);
    // Sort by modification time (most recent first)
    const withMtime = results.map(f => {
        try {
            return { path: f, mtime: fs.statSync(f).mtimeMs };
        }
        catch {
            return { path: f, mtime: 0 };
        }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const sorted = withMtime.map(f => f.path);
    if (sorted.length === 0) {
        return { output: `No files matched pattern "${pattern}" in ${baseDir}` };
    }
    let output = sorted.join('\n');
    if (sorted.length >= MAX_RESULTS) {
        output += `\n\n... (limited to ${MAX_RESULTS} results)`;
    }
    return { output };
}
export const globCapability = {
    spec: {
        name: 'Glob',
        description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.tsx"). Returns matching paths sorted by modification time.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern to match files (e.g. "**/*.ts")' },
                path: { type: 'string', description: 'Directory to search in. Defaults to working directory.' },
            },
            required: ['pattern'],
        },
    },
    execute,
    concurrent: true,
};
