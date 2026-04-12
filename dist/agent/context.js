/**
 * Context Manager for runcode
 * Assembles system instructions, reads project config, injects environment info.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadLearnings, decayLearnings, saveLearnings, formatForPrompt } from '../learnings/store.js';
// ─── System Instructions Assembly ──────────────────────────────────────────
const BASE_INSTRUCTIONS = `You are runcode, an AI coding agent that helps users with software engineering tasks.
You have access to tools for reading, writing, editing files, running shell commands, searching codebases, web browsing, and more.

# Core Principles
- Read before writing: always understand existing code before making changes.
- Be precise: make minimal, targeted changes. Don't refactor code you weren't asked to touch.
- Be safe: never introduce security vulnerabilities. Validate at system boundaries.
- Be honest: if you're unsure, say so. Don't guess at implementation details.

# Tool Usage
- **Read**: Read files with line numbers. Use offset/limit for large files.
- **Edit**: Targeted string replacement (preferred for existing files). old_string must be unique.
- **Write**: Create new files or full rewrites.
- **Bash**: Run shell commands. Default timeout 2min. Batch sequential commands with && to reduce round-trips.
- **Glob**: Find files by pattern. Skips node_modules/.git.
- **Grep**: Regex search. Default: file paths. output_mode "content" for matching lines.
- **WebFetch** / **WebSearch**: Fetch pages or search the web.
- **Task**: Track multi-step work.
- **Agent**: Spawn parallel sub-agents.

# Best Practices
- Glob/Grep before Read; Read before Edit.
- **Parallel**: call independent tools together in one response.
- **Batch bash**: combine sequential shell commands into one Bash call with && or a script. Only split when you need to inspect intermediate output.
- **AskUser**: Only use AskUser when you are about to perform a destructive action (deleting files, dropping databases) and need explicit confirmation. NEVER use AskUser to ask what the user wants — just answer their message directly. If their request is vague, make a reasonable assumption and proceed.
- Never write to /etc, /usr, ~/.ssh, ~/.aws. Don't commit secrets.
- Type /help to see all slash commands.

# Access & Capabilities
When the user asks for something that needs external access you don't have yet, **ask for it directly** instead of silently degrading:
- **X / Twitter**: If the user asks about X posts, trending topics, or social media marketing, check if X is set up by running: cat ~/.blockrun/social-config.json 2>/dev/null | head -1. If missing or handle is empty, tell the user: "I can get live X data if you set up access. Run: franklin social setup && franklin social login x — want me to walk you through it?" If they decline, fall back to WebSearch and tell them you're using web search instead of live X data.
- **General rule**: Never silently fall back. If a better data source exists but requires setup, offer it first. Only use the fallback after explaining the tradeoff.`;
// Cache assembled instructions per workingDir — avoids re-running git commands
// when sub-agents are spawned (common in parallel tool use patterns).
const _instructionCache = new Map();
/**
 * Build the full system instructions array for a session.
 * Result is memoized per workingDir for the process lifetime.
 */
export function assembleInstructions(workingDir) {
    const cached = _instructionCache.get(workingDir);
    if (cached)
        return cached;
    const parts = [BASE_INSTRUCTIONS];
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
    // Inject per-user learnings from self-evolution system
    try {
        let learnings = loadLearnings();
        if (learnings.length > 0) {
            learnings = decayLearnings(learnings);
            saveLearnings(learnings);
            const personalContext = formatForPrompt(learnings);
            if (personalContext)
                parts.push(personalContext);
        }
    }
    catch { /* learnings are optional — never block startup */ }
    _instructionCache.set(workingDir, parts);
    return parts;
}
/** Invalidate cache for a workingDir (call after /clear or session reset). */
export function invalidateInstructionCache(workingDir) {
    _instructionCache.delete(workingDir);
}
// ─── Project Config ────────────────────────────────────────────────────────
/**
 * Look for RUNCODE.md, then CLAUDE.md in the working directory and parents.
 */
function readProjectConfig(dir) {
    const configNames = ['RUNCODE.md', 'CLAUDE.md'];
    let current = path.resolve(dir);
    const root = path.parse(current).root;
    while (current !== root) {
        for (const name of configNames) {
            const filePath = path.join(current, name);
            try {
                const content = fs.readFileSync(filePath, 'utf-8').trim();
                if (content)
                    return content;
            }
            catch {
                // File doesn't exist, keep looking
            }
        }
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
// ─── Environment ───────────────────────────────────────────────────────────
function buildEnvironmentSection(workingDir) {
    const lines = ['# Environment'];
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
function getGitContext(workingDir) {
    try {
        const isGit = execSync('git rev-parse --is-inside-work-tree', {
            cwd: workingDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: GIT_TIMEOUT_MS,
        }).trim();
        if (isGit !== 'true')
            return null;
        const lines = [];
        // Current branch
        try {
            const branch = execSync('git branch --show-current', {
                cwd: workingDir,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: GIT_TIMEOUT_MS,
            }).trim();
            if (branch)
                lines.push(`Branch: ${branch}`);
        }
        catch { /* detached HEAD or error */ }
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
            }
            else {
                lines.push('Status: clean');
            }
        }
        catch { /* ignore */ }
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
        }
        catch { /* ignore */ }
        // Git user
        try {
            const user = execSync('git config user.name', {
                cwd: workingDir,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: GIT_TIMEOUT_MS,
            }).trim();
            if (user)
                lines.push(`User: ${user}`);
        }
        catch { /* ignore */ }
        return lines.length > 0 ? lines.join('\n') : null;
    }
    catch {
        return null;
    }
}
