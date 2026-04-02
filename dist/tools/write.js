/**
 * Write capability — creates or overwrites files.
 */
import fs from 'node:fs';
import path from 'node:path';
async function execute(input, ctx) {
    const { file_path: filePath, content } = input;
    if (!filePath) {
        return { output: 'Error: file_path is required', isError: true };
    }
    if (content === undefined || content === null) {
        return { output: 'Error: content is required', isError: true };
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);
    // Safety: don't write outside working directory without absolute path
    const dangerousPaths = ['/etc/', '/usr/', '/bin/', '/sbin/', '/var/', '/System/'];
    if (dangerousPaths.some(p => resolved.startsWith(p))) {
        return { output: `Error: refusing to write to system path: ${resolved}`, isError: true };
    }
    try {
        // Ensure parent directory exists
        const parentDir = path.dirname(resolved);
        fs.mkdirSync(parentDir, { recursive: true });
        const existed = fs.existsSync(resolved);
        fs.writeFileSync(resolved, content, 'utf-8');
        const lineCount = content.split('\n').length;
        const byteCount = Buffer.byteLength(content, 'utf-8');
        return {
            output: `${existed ? 'Updated' : 'Created'} ${resolved} (${lineCount} lines, ${byteCount} bytes)`,
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
        description: 'Create or overwrite a file. Creates parent directories automatically.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to the file to write' },
                content: { type: 'string', description: 'The content to write to the file' },
            },
            required: ['file_path', 'content'],
        },
    },
    execute,
    concurrent: false,
};
