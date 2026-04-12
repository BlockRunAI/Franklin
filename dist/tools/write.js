/**
 * Write capability — creates or overwrites files.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { partiallyReadFiles } from './read.js';
function withTrailingSep(value) {
    return value.endsWith(path.sep) ? value : value + path.sep;
}
function isWithinDir(target, dir) {
    const normalizedTarget = path.resolve(target);
    const normalizedDir = withTrailingSep(path.resolve(dir));
    return normalizedTarget === normalizedDir.slice(0, -1) || normalizedTarget.startsWith(normalizedDir);
}
function getAllowedTempDirs() {
    const candidates = new Set([path.resolve(os.tmpdir())]);
    for (const dir of [...candidates]) {
        try {
            candidates.add(path.resolve(fs.realpathSync(dir)));
        }
        catch {
            // Best effort only.
        }
        if (dir.startsWith('/private/')) {
            candidates.add(dir.slice('/private'.length));
        }
        else {
            candidates.add(path.join('/private', dir));
        }
    }
    return [...candidates];
}
async function execute(input, ctx) {
    const { file_path: filePath, content } = input;
    if (!filePath) {
        return { output: 'Error: file_path is required', isError: true };
    }
    if (content === undefined || content === null) {
        return { output: 'Error: content is required', isError: true };
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);
    // Safety: block system paths and sensitive home directories
    // Resolve symlinks to prevent traversal attacks
    const home = os.homedir();
    const allowedTempDirs = getAllowedTempDirs();
    const dangerousPaths = [
        '/etc/', '/usr/', '/bin/', '/sbin/', '/var/', '/System/',
        path.join(home, '.ssh') + '/',
        path.join(home, '.aws') + '/',
        path.join(home, '.kube') + '/',
        path.join(home, '.gnupg') + '/',
        path.join(home, '.config/gcloud') + '/',
    ];
    // Check both the resolved path and the real path (after symlink resolution)
    const checkPath = (p) => !allowedTempDirs.some(dir => isWithinDir(p, dir)) &&
        dangerousPaths.some(dp => p.startsWith(dp));
    if (checkPath(resolved)) {
        return { output: `Error: refusing to write to sensitive path: ${resolved}`, isError: true };
    }
    // Also check parent dir's real path if it already exists (symlink protection)
    const parentDir = path.dirname(resolved);
    try {
        if (fs.existsSync(parentDir)) {
            const realParent = fs.realpathSync(parentDir);
            if (checkPath(realParent + '/')) {
                return { output: `Error: refusing to write — path resolves to sensitive location: ${realParent}`, isError: true };
            }
        }
    }
    catch { /* parent doesn't exist yet, will be created */ }
    // Also check if target file itself is a symlink to a sensitive location
    try {
        if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
            const realTarget = fs.realpathSync(resolved);
            if (checkPath(realTarget)) {
                return { output: `Error: refusing to write — symlink resolves to sensitive location: ${realTarget}`, isError: true };
            }
        }
    }
    catch { /* file doesn't exist yet, ok */ }
    try {
        // Ensure parent directory exists
        const parentDir = path.dirname(resolved);
        fs.mkdirSync(parentDir, { recursive: true });
        const existed = fs.existsSync(resolved);
        fs.writeFileSync(resolved, content, 'utf-8');
        partiallyReadFiles.delete(resolved);
        const lineCount = content.split('\n').length;
        const byteCount = Buffer.byteLength(content, 'utf-8');
        const sizeStr = byteCount >= 1024 ? `${(byteCount / 1024).toFixed(1)}KB` : `${byteCount}B`;
        return {
            output: `${existed ? 'Updated' : 'Created'} ${resolved} (${lineCount} lines, ${sizeStr})`,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Error writing file: ${msg}`, isError: true };
    }
}
export const writeCapability = {
    spec: {
        name: 'Write',
        description: 'Create or overwrite a file.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path' },
                content: { type: 'string', description: 'File content' },
            },
            required: ['file_path', 'content'],
        },
    },
    execute,
    concurrent: false,
};
