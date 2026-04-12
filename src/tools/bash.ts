/**
 * Bash capability — execute shell commands with timeout and output capture.
 */

import { spawn } from 'node:child_process';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

// ─── Smart Output Compression ─────────────────────────────────────────────
// Learned from RTK (Rust Token Killer): strip noise before sending to LLM.
// Applied after capture, before the 32KB cap — reduces tokens on verbose commands.

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function collapseBlankLines(s: string): string {
  // Collapse 3+ consecutive blank lines → 1 blank line
  return s.replace(/\n{3,}/g, '\n\n');
}

/** Extract the base command word (first non-env token). */
function baseCmd(command: string): string {
  // Strip leading env var assignments (FOO=bar cmd → cmd)
  const stripped = command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, '').trimStart();
  return stripped.split(/\s+/)[0] ?? '';
}

function compressOutput(command: string, output: string): string {
  // 1. Always strip ANSI escape codes
  let out = stripAnsi(output);

  const cmd = baseCmd(command);
  const fullCmd = command.trimStart();

  // 2. Git command-aware compression
  if (cmd === 'git') {
    const sub = fullCmd.split(/\s+/)[1] ?? '';
    out = compressGit(sub, out);
  }
  // 3. Package manager installs — keep only errors + final summary
  else if (/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/.test(fullCmd)) {
    out = compressInstall(out);
  }
  // 4. Test runners — keep only failures + summary line
  else if (/^(npm|pnpm|bun)\s+test\b|^(jest|vitest|mocha)\b/.test(fullCmd)) {
    out = compressTests(out);
  }
  // 5. Build commands — keep errors/warnings, drop verbose compile lines
  else if (/^(npm|pnpm|bun)\s+(run\s+)?(build|compile)\b|^tsc\b/.test(fullCmd)) {
    out = compressBuild(out);
  }
  // 6. cargo
  else if (cmd === 'cargo') {
    const sub = fullCmd.split(/\s+/)[1] ?? '';
    if (sub === 'test' || sub === 'nextest') out = compressTests(out);
    else if (sub === 'build' || sub === 'check' || sub === 'clippy') out = compressBuild(out);
    else if (sub === 'install') out = compressInstall(out);
  }

  // 7. Always collapse excessive blank lines
  out = collapseBlankLines(out);

  return out;
}

function compressGit(sub: string, out: string): string {
  switch (sub) {
    case 'add': {
      // git add is usually silent. Strip any blank output.
      const trimmed = out.trim();
      return trimmed || 'ok';
    }
    case 'commit': {
      // Keep: [branch abc1234] message + stats line. Strip verbose output.
      const lines = out.split('\n');
      const kept = lines.filter(l =>
        /^\[.+\]/.test(l) ||          // [main abc1234] commit msg
        /\d+ file/.test(l) ||          // 2 files changed, 10 insertions
        /^\s*(create|delete) mode/.test(l) ||
        l.trim() === ''
      );
      return kept.join('\n').trim() || out.trim();
    }
    case 'push': {
      // Strip verbose remote "enumerating/counting/compressing" lines
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l) &&
        !/^Counting objects|^Compressing objects|^Writing objects/.test(l) &&
        l.trim() !== ''
      );
      return lines.join('\n').trim() || 'ok';
    }
    case 'pull': {
      // Strip "remote: Counting..." lines, keep summary
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l) &&
        !/^Counting objects|^Compressing objects/.test(l)
      );
      return collapseBlankLines(lines.join('\n')).trim();
    }
    case 'fetch': {
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l)
      );
      return lines.join('\n').trim();
    }
    case 'log': {
      // Already terse if user uses --oneline; just collapse blanks
      return out.trim();
    }
    default:
      return out;
  }
}

function compressInstall(out: string): string {
  const lines = out.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    // Drop pure progress lines
    if (/^(Downloading|Fetching|Resolving|Progress|Preparing|Caching)/.test(l)) continue;
    if (/^[\s.]*$/.test(l)) continue;
    // Keep errors, warnings, and summary lines
    kept.push(line);
  }
  // If no lines kept, return original trimmed (don't lose error info)
  const result = kept.join('\n').trim();
  return result || out.trim();
}

function compressTests(out: string): string {
  const lines = out.split('\n');
  // Look for failure sections and summary
  const kept: string[] = [];
  let inFailure = false;

  for (const line of lines) {
    const l = line.trim();
    // Detect failure/error blocks
    if (/^(FAIL|FAILED|Error:|●|✕|✗|×|error\[)/.test(l)) {
      inFailure = true;
    }
    // Summary lines (always keep)
    if (/^(Tests?|Test Suites?|Suites?|PASS|FAIL|ok\s|error|warning|\d+ (test|spec|example))/.test(l) ||
        /\d+\s*(passed|failed|skipped|pending|todo)/.test(l)) {
      kept.push(line);
      inFailure = false;
      continue;
    }
    if (inFailure) {
      kept.push(line);
      // End failure block on blank line after content
      if (l === '' && kept[kept.length - 2]?.trim() !== '') inFailure = false;
    }
  }

  // If nothing matched (e.g. all passed with no verbose output), return original
  if (kept.length === 0) return out.trim();
  return collapseBlankLines(kept.join('\n')).trim();
}

function compressBuild(out: string): string {
  const lines = out.split('\n');
  const kept = lines.filter(l => {
    const t = l.trim();
    if (t === '') return false;
    // Drop pure progress/info lines from bundlers/compilers
    if (/^(Compiling|Finished|Checking|warning: unused import)/.test(t) &&
        !/^(Compiling.*error|Finished.*error)/.test(t)) {
      // Keep "Finished" summary
      if (/^Finished/.test(t)) return true;
      return false;
    }
    return true;
  });
  return collapseBlankLines(kept.join('\n')).trim() || out.trim();
}

interface BashInput {
  command: string;
  timeout?: number;
}

const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB capture buffer (prevents OOM)
const MAX_RETURN_CHARS = 32_000;    // 32KB return cap (~8,000 tokens) — prevents context bloat
const DEFAULT_TIMEOUT_MS = 120_000;  // 2 minutes

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { command, timeout } = input as unknown as BashInput;

  if (!command || typeof command !== 'string') {
    return { output: 'Error: command is required', isError: true };
  }

  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, 600_000);

  return new Promise<CapabilityResult>((resolve) => {
    const shell = process.env.SHELL || '/bin/bash';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-c', command], {
        cwd: ctx.workingDir,
        env: {
          ...process.env,
          RUNCODE: '1', // Let scripts detect they're running inside runcode
          RUNCODE_WORKDIR: ctx.workingDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      resolve({ output: `Error spawning shell: ${(spawnErr as Error).message}`, isError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let truncated = false;
    let killed = false;
    let abortedByUser = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000); // Give 5s for graceful shutdown before SIGKILL
    }, timeoutMs);

    // Handle abort signal
    const onAbort = () => {
      killed = true;
      abortedByUser = true;
      child.kill('SIGTERM');
    };
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    // Emit last non-empty line to UI progress (throttled to avoid flooding)
    let lastProgressEmit = 0;
    const emitProgress = (text: string) => {
      if (!ctx.onProgress) return;
      const now = Date.now();
      if (now - lastProgressEmit < 500) return; // max 2 updates/sec
      lastProgressEmit = now;
      const lastLine = text.split('\n').map(l => l.trim()).filter(Boolean).pop();
      if (lastLine) ctx.onProgress(lastLine.slice(0, 120));
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf-8');
      if (chunk.length <= remaining) {
        stdout += text;
        outputBytes += chunk.length;
      } else {
        stdout += text.slice(0, remaining);
        outputBytes = MAX_OUTPUT_BYTES;
        truncated = true;
      }
      emitProgress(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf-8');
      if (chunk.length <= remaining) {
        stderr += text;
        outputBytes += chunk.length;
      } else {
        stderr += text.slice(0, remaining);
        outputBytes = MAX_OUTPUT_BYTES;
        truncated = true;
      }
      emitProgress(text);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);

      let result = '';
      if (stdout) result += stdout;
      if (stderr) {
        if (result) result += '\n';
        result += stderr;
      }

      if (truncated) {
        result += '\n\n... (output truncated — command produced >512KB)';
      }

      // Smart compression: strip ANSI, collapse blank lines, command-aware filters
      result = compressOutput(command, result);

      // Cap returned output to prevent context bloat.
      // Keep the LAST part (most relevant for errors/test failures/build output).
      if (result.length > MAX_RETURN_CHARS) {
        const lines = result.split('\n');
        let trimmed = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = lines[i] + '\n' + trimmed;
          if (candidate.length > MAX_RETURN_CHARS) break;
          trimmed = candidate;
        }
        const omitted = result.length - trimmed.length;
        result = `... (${omitted.toLocaleString()} chars omitted from start)\n${trimmed}`;
      }

      if (killed) {
        const reason = abortedByUser
          ? 'aborted by user'
          : `timeout after ${timeoutMs / 1000}s. Set timeout param up to 600000ms for longer.`;
        resolve({
          output: result + `\n\n(command killed — ${reason})`,
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

export const bashCapability: CapabilityHandler = {
  spec: {
    name: 'Bash',
    description: 'Execute a shell command and return stdout+stderr. Runs in working directory with user env. Output capped at 512KB. Default timeout: 2min, max: 10min (set via timeout param in ms).',
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
