/**
 * Bash capability — execute shell commands with timeout and output capture.
 */
import { spawn } from 'node:child_process';
const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB output cap
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
async function execute(input, ctx) {
    const { command, timeout } = input;
    if (!command || typeof command !== 'string') {
        return { output: 'Error: command is required', isError: true };
    }
    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, 600_000);
    return new Promise((resolve) => {
        const shell = process.env.SHELL || '/bin/bash';
        const child = spawn(shell, ['-c', command], {
            cwd: ctx.workingDir,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let truncated = false;
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            child.kill('SIGTERM');
            setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch { /* already dead */ }
            }, 3000);
        }, timeoutMs);
        // Handle abort signal
        const onAbort = () => {
            killed = true;
            child.kill('SIGTERM');
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        child.stdout?.on('data', (chunk) => {
            if (truncated)
                return;
            const remaining = MAX_OUTPUT_BYTES - outputBytes;
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            const text = chunk.toString('utf-8');
            if (chunk.length <= remaining) {
                stdout += text;
                outputBytes += chunk.length;
            }
            else {
                stdout += text.slice(0, remaining);
                outputBytes = MAX_OUTPUT_BYTES;
                truncated = true;
            }
        });
        child.stderr?.on('data', (chunk) => {
            if (truncated)
                return;
            const remaining = MAX_OUTPUT_BYTES - outputBytes;
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            const text = chunk.toString('utf-8');
            if (chunk.length <= remaining) {
                stderr += text;
                outputBytes += chunk.length;
            }
            else {
                stderr += text.slice(0, remaining);
                outputBytes = MAX_OUTPUT_BYTES;
                truncated = true;
            }
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            ctx.abortSignal.removeEventListener('abort', onAbort);
            let result = '';
            if (stdout)
                result += stdout;
            if (stderr) {
                if (result)
                    result += '\n';
                result += stderr;
            }
            if (truncated) {
                result += '\n\n... (output truncated at 512KB)';
            }
            if (killed) {
                resolve({
                    output: result + `\n\n(command killed — timeout after ${timeoutMs / 1000}s. Set timeout param up to 600000ms for longer.)`,
                    isError: true,
                });
                return;
            }
            if (code !== 0 && code !== null) {
                resolve({
                    output: result || `Command exited with code ${code}`,
                    isError: true,
                });
                return;
            }
            resolve({ output: result || '(no output)' });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            ctx.abortSignal.removeEventListener('abort', onAbort);
            resolve({
                output: `Error spawning command: ${err.message}`,
                isError: true,
            });
        });
    });
}
export const bashCapability = {
    spec: {
        name: 'Bash',
        description: 'Execute a shell command and return its output. Commands run in the working directory.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
            },
            required: ['command'],
        },
    },
    execute,
    concurrent: false,
};
