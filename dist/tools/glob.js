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
function walkDirectory(dir, baseDir, pattern, results, depth, visited) {
    if (depth > 50 || results.length >= MAX_RESULTS)
        return;
    // Symlink loop protection
    const visitedSet = visited ?? new Set();
    let realDir;
    try {
        realDir = fs.realpathSync(dir);
    }
    catch {
        return;
    }
    if (visitedSet.has(realDir))
        return;
    visitedSet.add(realDir);
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
        const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isSymlinkDir(path.join(dir, entry.name)));
        if (entry.name.startsWith('.') && isDir)
            continue;
        if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git')
            continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        if (entry.isFile() || (entry.isSymbolicLink() && !isDir)) {
            if (globMatch(pattern, relativePath)) {
                results.push(fullPath);
            }
        }
        else if (isDir) {
            // Recurse for ** patterns; for patterns with /, only recurse if current dir is on the path
            if (pattern.includes('**')) {
                walkDirectory(fullPath, baseDir, pattern, results, depth + 1, visitedSet);
            }
            else if (pattern.includes('/')) {
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
function isSymlinkDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
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
        // Suggest recursive pattern if user used non-recursive glob
        const hint = !pattern.includes('**') && !pattern.includes('/')
            ? ` Try "**/${pattern}" for recursive search.`
            : '';
        return { output: `No files matched pattern "${pattern}" in ${baseDir}.${hint}` };
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
        description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.tsx"). Returns up to 500 paths sorted by modification time. Skips node_modules, .git, hidden dirs.',
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
