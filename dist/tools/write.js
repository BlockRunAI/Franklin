/**
 * Write capability — creates or overwrites files.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
    const home = os.homedir();
    const dangerousPaths = [
        '/etc/', '/usr/', '/bin/', '/sbin/', '/var/', '/System/',
        path.join(home, '.ssh') + '/',
        path.join(home, '.aws') + '/',
        path.join(home, '.kube') + '/',
        path.join(home, '.gnupg') + '/',
        path.join(home, '.config/gcloud') + '/',
    ];
    if (dangerousPaths.some(p => resolved.startsWith(p))) {
        return { output: `Error: refusing to write to sensitive path: ${resolved}`, isError: true };
    }
    try {
        // Ensure parent directory exists
        const parentDir = path.dirname(resolved);
        fs.mkdirSync(parentDir, { recursive: true });
        const existed = fs.existsSync(resolved);
        fs.writeFileSync(resolved, content, 'utf-8');
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
