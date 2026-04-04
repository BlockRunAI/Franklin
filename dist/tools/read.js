/**
 * Read capability — reads files with line numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
async function execute(input, ctx) {
    const { file_path: filePath, offset, limit } = input;
    if (!filePath) {
        return { output: 'Error: file_path is required', isError: true };
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);
    try {
        const stat = fs.statSync(resolved);
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
        // Detect binary files
        const ext = path.extname(resolved).toLowerCase();
        const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.exe', '.dll', '.so', '.dylib']);
        if (binaryExts.has(ext)) {
            const sizeStr = stat.size >= 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
            return { output: `Binary file: ${resolved} (${ext}, ${sizeStr}). Cannot display contents.` };
        }
        const raw = fs.readFileSync(resolved, 'utf-8');
        const allLines = raw.split('\n');
        const startLine = Math.max(0, (Math.max(1, offset ?? 1)) - 1);
        const maxLines = limit ?? 2000;
        const endLine = Math.min(allLines.length, startLine + maxLines);
        const slice = allLines.slice(startLine, endLine);
        // Format with line numbers (cat -n style)
        const numbered = slice.map((line, i) => `${startLine + i + 1}\t${line}`);
        let result = numbered.join('\n');
        if (endLine < allLines.length) {
            result += `\n\n... (${allLines.length - endLine} more lines. Use offset=${endLine + 1} to continue.)`;
        }
        return { output: result || '(empty file)' };
    }
    catch (err) {
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
export const readCapability = {
    spec: {
        name: 'Read',
        description: 'Read a file from the filesystem with line numbers (cat -n format). Max 2MB file size. Use offset/limit params for large files or to read specific sections.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to the file to read' },
                offset: { type: 'number', description: 'Line number to start reading from (1-based). Default: 1' },
                limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000' },
            },
            required: ['file_path'],
        },
    },
    execute,
    concurrent: true,
};
