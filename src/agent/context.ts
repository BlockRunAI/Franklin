/**
 * Context Manager for runcode
 * Assembles system instructions, reads project config, injects environment info.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ─── System Instructions Assembly ──────────────────────────────────────────

const BASE_INSTRUCTIONS = `You are runcode, an AI coding agent that helps users with software engineering tasks.
You have access to tools for reading, writing, editing files, running shell commands, searching codebases, web browsing, and more.

# Core Principles
- Read before writing: always understand existing code before making changes.
- Be precise: make minimal, targeted changes. Don't refactor code you weren't asked to touch.
- Be safe: never introduce security vulnerabilities. Validate at system boundaries.
- Be honest: if you're unsure, say so. Don't guess at implementation details.

# Tool Usage
- **Read**: Read files with line numbers. Max 2MB; use offset/limit for large files.
- **Edit**: Targeted string replacement in files (preferred over Write for existing files). old_string must be unique in the file.
- **Write**: Create new files or complete rewrites. Creates parent directories automatically.
- **Bash**: Execute shell commands with timeout (default 2min, max 10min via timeout param). Output capped at 512KB.
- **Glob**: Find files by pattern (e.g. "**/*.ts"). Sorted by modification time. Skips node_modules, .git. Max 500 results.
- **Grep**: Search file contents by regex. Uses ripgrep. Default mode: files_with_matches. Use output_mode "content" for matching lines.
- **WebFetch**: Fetch and read web pages. HTML tags stripped for readability. Max 256KB.
- **WebSearch**: Search the web via DuckDuckGo. Returns titles, URLs, and snippets.
- **Task**: Create and manage tasks for tracking multi-step work within a session.
- **ImageGen**: Generate images from text prompts using DALL-E. Saves to file.
- **Agent**: Launch a sub-agent for independent parallel tasks. Sub-agents have their own context.

# Best Practices
- Use Glob/Grep to find files before reading them.
- Read a file before editing it — Edit requires exact string matching.
- Call multiple tools in parallel when they don't depend on each other.
- Use Bash for builds, tests, git operations, and system commands.
- Use WebSearch + WebFetch together to research topics.

# Safety
- Never write to system paths (/etc, /usr, ~/.ssh, ~/.aws).
- Avoid destructive git operations (force push, reset --hard) unless explicitly asked.
- Don't commit secrets, credentials, or .env files.
- When unsure about a destructive action, use AskUser to confirm.

# Communication
- Be concise. Lead with the answer or action.
- Show what you changed and why.
- When blocked, explain what you tried and ask for guidance.
- Use AskUser when you need clarification before proceeding with ambiguous requests.

# Slash Commands Available
The user can type these shortcuts: /commit, /review, /test, /fix, /debug, /explain <file>,
/search <query>, /find <pattern>, /refactor <desc>, /init, /todo, /deps, /diff, /status,
/log, /branch, /stash, /plan, /ultraplan, /execute, /compact, /retry, /sessions, /resume,
/tasks, /context, /doctor, /tokens, /model, /cost, /dump, /ultrathink [query], /clear,
/help, /exit.`;

// Cache assembled instructions per workingDir — avoids re-running git commands
// when sub-agents are spawned (common in parallel tool use patterns).
const _instructionCache = new Map<string, string[]>();

/**
 * Build the full system instructions array for a session.
 * Result is memoized per workingDir for the process lifetime.
 */
export function assembleInstructions(workingDir: string): string[] {
  const cached = _instructionCache.get(workingDir);
  if (cached) return cached;

  const parts: string[] = [BASE_INSTRUCTIONS];

  // Read RUNCODE.md or CLAUDE.md from the project
  const projectConfig = readProjectConfig(workingDir);
  if (projectConfig) {
    parts.push(`# Project Instructions\n\n${projectConfig}`);
  }

  // Inject environment info
  parts.push(buildEnvironmentSection(workingDir));

  // Inject git context
  const gitInfo = getGitContext(workingDir);
  if (gitInfo) {
    parts.push(`# Git Context\n\n${gitInfo}`);
  }

  _instructionCache.set(workingDir, parts);
  return parts;
}

/** Invalidate cache for a workingDir (call after /clear or session reset). */
export function invalidateInstructionCache(workingDir: string): void {
  _instructionCache.delete(workingDir);
}

// ─── Project Config ────────────────────────────────────────────────────────

/**
 * Look for RUNCODE.md, then CLAUDE.md in the working directory and parents.
 */
function readProjectConfig(dir: string): string | null {
  const configNames = ['RUNCODE.md', 'CLAUDE.md'];
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    for (const name of configNames) {
      const filePath = path.join(current, name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) return content;
      } catch {
        // File doesn't exist, keep looking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

// ─── Environment ───────────────────────────────────────────────────────────

function buildEnvironmentSection(workingDir: string): string {
  const lines: string[] = ['# Environment'];
  lines.push(`- Working directory: ${workingDir}`);
  lines.push(`- Platform: ${process.platform}`);
  lines.push(`- Node.js: ${process.version}`);

  // Detect shell
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown';
  lines.push(`- Shell: ${path.basename(shell)}`);

  // Date
  lines.push(`- Date: ${new Date().toISOString().split('T')[0]}`);

  return lines.join('\n');
}

// ─── Git Context ───────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 5_000;

// Max chars for git log output — long commit messages can bloat the system prompt
const MAX_GIT_LOG_CHARS = 2_000;

function getGitContext(workingDir: string): string | null {
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree', {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();

    if (isGit !== 'true') return null;

    const lines: string[] = [];

    // Current branch
    try {
      const branch = execSync('git branch --show-current', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      if (branch) lines.push(`Branch: ${branch}`);
    } catch { /* detached HEAD or error */ }

    // Git status (brief)
    try {
      const status = execSync('git status --short', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      if (status) {
        const fileCount = status.split('\n').length;
        lines.push(`Changed files: ${fileCount}`);
      } else {
        lines.push('Status: clean');
      }
    } catch { /* ignore */ }

    // Recent commits (last 5) — capped to prevent huge messages bloating context
    try {
      let log = execSync('git log --oneline -5', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      if (log) {
        if (log.length > MAX_GIT_LOG_CHARS) {
          log = log.slice(0, MAX_GIT_LOG_CHARS) + '\n... (truncated)';
        }
        lines.push(`\nRecent commits:\n${log}`);
      }
    } catch { /* ignore */ }

    // Git user
    try {
      const user = execSync('git config user.name', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      if (user) lines.push(`User: ${user}`);
    } catch { /* ignore */ }

    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}
