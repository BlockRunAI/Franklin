/**
 * Context Manager for Franklin
 * Assembles system instructions, reads project config, injects environment info.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadLearnings, decayLearnings, saveLearnings, formatForPrompt } from '../learnings/store.js';

// ─── System Instructions Assembly ──────────────────────────────────────────

const BASE_INSTRUCTIONS = `You are Franklin, an AI coding agent that helps users with software engineering tasks.
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

# Tool-Use Enforcement
You MUST use tools to take action — do not describe what you would do without doing it.
Never end your turn with a promise of future action — execute it now.
Every response should either (a) contain tool calls that make progress, or (b) deliver a final result to the user.
Responses that only describe intentions without acting are not acceptable.

# Missing Access
Always deliver results first using whatever tools work (WebSearch, WebFetch, etc.). Never let missing access block you.
After delivering results, if a better data source exists, add one line at the end:
"Tip: run franklin social setup && franklin social login x for live X data."
Do NOT check access before acting. Do NOT explain what you tried. Just deliver, then tip.

# X / Social Marketing — STRICT RULES
SearchX is the ONLY tool that can access X.com. WebSearch and WebFetch CANNOT access X.com content.

RULES (violations will produce garbage output):
1. Make ONE SearchX call per topic. Never retry with variations.
2. If SearchX returns empty, tell the user "No posts found" and suggest a different keyword. Do NOT fall back to WebSearch/WebFetch — they will return non-X content that you must NEVER present as X posts.
3. NEVER fabricate X post URLs. Every link you show MUST come from SearchX results. If a URL doesn't start with "https://x.com/", do NOT present it as an X post.
4. Present results as a numbered list. Each item: author, snippet, URL from SearchX, and a 1-2 sentence suggested reply.
5. Reply drafts must sound like a real human: short, specific to the post content, conversational. NO marketing speak, NO "Great point about...", NO corporate tone. Write like a smart friend, not a LinkedIn bot.
6. End with: "Reply to any? Give me the number."
7. Do NOT auto-post. Do NOT explain how the social system works.

When checking notifications/mentions: Use SearchX with mode="notifications". One call, done.

# Token Efficiency
- **Search once, not 10 times.** Do NOT run WebSearch with slight query variations. 3-5 searches MAX per topic. If results are empty, stop searching — do not rephrase and retry.
- **Stop after repeated misses.** If 2 similar searches for the same topic return empty/low-signal results, stop and synthesize what you have.
- **Read files once.** Do NOT re-read files you already read in this conversation. The content is already in your context.
- **Parallel tool calls.** When you need multiple independent pieces of information, call all tools in a single response. Never call them one-by-one in separate turns.
- **Present results early.** After 3 searches, present what you found. Do not keep searching for "more" — the user can ask if they want more.

# Before Responding (verification checklist)
- Correctness: does your output satisfy the user's request?
- Grounding: are all factual claims backed by tool results, not your memory?
- URLs: does every link come from a tool result? NEVER fabricate URLs.
- Conciseness: is the response direct and actionable, not verbose filler?`;

// Cache assembled instructions per workingDir — avoids re-running git commands
// when sub-agents are spawned (common in parallel tool use patterns).
const _instructionCache = new Map<string, string[]>();

/**
 * Build the full system instructions array for a session.
 * Result is memoized per workingDir for the process lifetime.
 */
export function assembleInstructions(workingDir: string, model?: string): string[] {
  const cacheKey = model ? `${workingDir}::${model}` : workingDir;
  const cached = _instructionCache.get(cacheKey);
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

  // Inject per-user learnings from self-evolution system
  try {
    let learnings = loadLearnings();
    if (learnings.length > 0) {
      learnings = decayLearnings(learnings);
      saveLearnings(learnings);
      const personalContext = formatForPrompt(learnings);
      if (personalContext) parts.push(personalContext);
    }
  } catch { /* learnings are optional — never block startup */ }

  // Model-specific execution guidance
  if (model) {
    parts.push(getModelGuidance(model));
  }

  _instructionCache.set(cacheKey, parts);
  return parts;
}

/**
 * Model-family-specific execution guidance.
 * Weak models get strict guardrails. Strong models get quality standards.
 */
export function getModelGuidance(model: string): string {
  const m = model.toLowerCase();

  // Weak/cheap models: strict discipline to prevent looping and hallucination
  if (m.includes('glm') || m.includes('gpt-oss') || m.includes('nemotron') ||
      m.includes('minimax') || m.includes('devstral') || m.includes('llama-4')) {
    return `# Execution Discipline (strict — this model requires guardrails)
- Make ONE tool call per task. Do NOT retry the same tool with query variations.
- If a tool returns empty results, tell the user immediately. Do NOT fall back to other tools.
- NEVER fabricate data, URLs, or quotes. If you don't have it, say so.
- Keep responses under 300 words. Be direct, not verbose.
- Before responding: does every URL and fact come from a tool result? If not, remove it.`;
  }

  // Medium models: balanced guidance
  if (m.includes('kimi') || m.includes('grok') || m.includes('flash') ||
      m.includes('haiku') || m.includes('deepseek') || m.includes('qwen')) {
    return `# Execution Guidance
- Use tools to verify facts before stating them. Do not answer from memory when a tool can confirm.
- Batch independent tool calls in one response (parallel execution).
- If a tool fails, explain the failure to the user. Do not silently retry with a different tool.
- Before responding: are all claims grounded in tool output? Remove anything unverified.`;
  }

  // Strong models: quality standards
  if (m.includes('claude') || m.includes('gpt-5') || m.includes('opus') ||
      m.includes('sonnet') || m.includes('gemini-2.5-pro') || m.includes('gemini-3') ||
      m.includes('o3') || m.includes('o1') || m.includes('codex')) {
    return `# Quality Standards
- Keep calling tools until the task is complete AND the result is verified.
- Before finalizing: check correctness, grounding in tool output, and formatting.
- If proceeding with incomplete information, label assumptions explicitly.
- Prefer depth over breadth — a thorough answer to one question beats shallow answers to many.`;
  }

  // Default: basic guidance
  return `# Execution Guidance
- Use tools to verify facts. Do not answer from memory when a tool can confirm.
- If a tool fails, tell the user. Do not silently retry.
- Before responding: are claims grounded in tool output?`;
}

/** Invalidate cache for a workingDir (call after /clear or session reset). */
export function invalidateInstructionCache(workingDir?: string): void {
  if (workingDir) {
    // Clear all entries for this workDir (any model)
    for (const key of _instructionCache.keys()) {
      if (key.startsWith(workingDir)) {
        _instructionCache.delete(key);
      }
    }
  } else {
    _instructionCache.clear();
  }
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
