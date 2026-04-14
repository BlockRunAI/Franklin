/**
 * Write capability — creates or overwrites files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { partiallyReadFiles, fileReadTracker } from './read.js';

interface WriteInput {
  file_path: string;
  content: string;
}

function withTrailingSep(value: string): string {
  return value.endsWith(path.sep) ? value : value + path.sep;
}

function isWithinDir(target: string, dir: string): boolean {
  const normalizedTarget = path.resolve(target);
  const normalizedDir = withTrailingSep(path.resolve(dir));
  return normalizedTarget === normalizedDir.slice(0, -1) || normalizedTarget.startsWith(normalizedDir);
}

function getAllowedTempDirs(): string[] {
  const candidates = new Set<string>([path.resolve(os.tmpdir())]);

  for (const dir of [...candidates]) {
    try {
      candidates.add(path.resolve(fs.realpathSync(dir)));
    } catch {
      // Best effort only.
    }
    if (dir.startsWith('/private/')) {
      candidates.add(dir.slice('/private'.length));
    } else {
      candidates.add(path.join('/private', dir));
    }
  }

  return [...candidates];
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { file_path: filePath, content } = input as unknown as WriteInput;

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
  const checkPath = (p: string) =>
    !allowedTempDirs.some(dir => isWithinDir(p, dir)) &&
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
  } catch { /* parent doesn't exist yet, will be created */ }

  // Also check if target file itself is a symlink to a sensitive location
  try {
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      const realTarget = fs.realpathSync(resolved);
      if (checkPath(realTarget)) {
        return { output: `Error: refusing to write — symlink resolves to sensitive location: ${realTarget}`, isError: true };
      }
    }
  } catch { /* file doesn't exist yet, ok */ }

  // Enforce read-before-overwrite for existing files
  const fileExists = fs.existsSync(resolved);
  if (fileExists && !fileReadTracker.has(resolved)) {
    return {
      output: `Error: this file already exists. You MUST use Read first to understand its current content before overwriting.\nFile: ${resolved}`,
      isError: true,
    };
  }

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(resolved);
    fs.mkdirSync(parentDir, { recursive: true });

    fs.writeFileSync(resolved, content, 'utf-8');
    partiallyReadFiles.delete(resolved);
    // Update read tracker so subsequent edits don't trigger stale detection
    const newStat = fs.statSync(resolved);
    fileReadTracker.set(resolved, { mtimeMs: newStat.mtimeMs, readAt: Date.now() });

    const lineCount = content.split('\n').length;
    const byteCount = Buffer.byteLength(content, 'utf-8');
    const sizeStr = byteCount >= 1024 ? `${(byteCount / 1024).toFixed(1)}KB` : `${byteCount}B`;

    return {
      output: `${fileExists ? 'Updated' : 'Created'} ${resolved} (${lineCount} lines, ${sizeStr})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error writing file: ${msg}`, isError: true };
  }
}

export const writeCapability: CapabilityHandler = {
  spec: {
    name: 'Write',
    description: `Write a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use Read first to read the file's contents. This tool will fail if you did not read an existing file first.
- Prefer Edit for modifying existing files — it only sends the diff. Only use Write to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the user.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.

IMPORTANT: Always use Write instead of echo/heredoc/cat redirection via Bash.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to write (must be absolute, not relative)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  execute,
  concurrent: false,
};
