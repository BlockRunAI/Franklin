/**
 * Slash command registry for runcode.
 * Extracted from loop.ts for maintainability.
 *
 * Two types of commands:
 * 1. "Handled" — execute directly, emit events, return { handled: true }
 * 2. "Rewrite" — transform input into a prompt for the agent, return { handled: false, rewritten }
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { BLOCKRUN_DIR, VERSION } from '../config.js';
import { estimateHistoryTokens, getAnchoredTokenCount, getContextWindow, resetTokenAnchor } from './tokens.js';
import { forceCompact } from './compact.js';
import type { ModelClient } from './llm.js';
import type { AgentConfig, Dialogue, StreamEvent } from './types.js';
import {
  listSessions,
  loadSessionHistory,
  type SessionMeta,
} from '../session/storage.js';

type EventEmitter = (event: StreamEvent) => void;

interface CommandContext {
  history: Dialogue[];
  config: AgentConfig;
  client: ModelClient;
  sessionId: string;
  onEvent: EventEmitter;
}

interface CommandResult {
  handled: boolean;      // true = command fully handled, skip agent loop
  rewritten?: string;    // if set, replace input with this prompt
}

// ─── Git helpers ──────────────────────────────────────────────────────────

function gitExec(cmd: string, cwd: string, timeout = 5000, maxBuffer?: number): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer: maxBuffer || 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitCmd(ctx: CommandContext, cmd: string, timeout?: number, maxBuffer?: number): string | null {
  try {
    return gitExec(cmd, ctx.config.workingDir || process.cwd(), timeout, maxBuffer);
  } catch (e) {
    ctx.onEvent({ kind: 'text_delta', text: `Git error: ${(e as Error).message?.split('\n')[0] || 'unknown'}\n` });
    return null;
  }
}

function emitDone(ctx: CommandContext) {
  ctx.onEvent({ kind: 'turn_done', reason: 'completed' });
}

// ─── Command Definitions ──────────────────────────────────────────────────

// Direct-handled commands (don't go to agent)
const DIRECT_COMMANDS: Record<string, (ctx: CommandContext) => Promise<void> | void> = {
  '/stash': (ctx) => {
    const r = gitCmd(ctx, 'git stash push -m "runcode auto-stash"', 10000);
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r || 'No changes to stash.\n' });
    emitDone(ctx);
  },
  '/unstash': (ctx) => {
    const r = gitCmd(ctx, 'git stash pop', 10000);
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r || 'Stash applied.\n' });
    emitDone(ctx);
  },
  '/log': (ctx) => {
    const r = gitCmd(ctx, 'git log --oneline -15 --no-color');
    ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'No commits or not a git repo.\n' });
    emitDone(ctx);
  },
  '/status': (ctx) => {
    const r = gitCmd(ctx, 'git status --short --branch');
    ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'Not a git repo.\n' });
    emitDone(ctx);
  },
  '/diff': (ctx) => {
    const r = gitCmd(ctx, 'git diff --stat && echo "---" && git diff', 10000, 512 * 1024);
    ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`diff\n${r}\n\`\`\`\n` : 'No changes.\n' });
    emitDone(ctx);
  },
  '/undo': (ctx) => {
    const r = gitCmd(ctx, 'git reset --soft HEAD~1');
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: 'Last commit undone. Changes preserved in staging.\n' });
    emitDone(ctx);
  },
  '/bug': (ctx) => {
    ctx.onEvent({ kind: 'text_delta', text: 'Report issues at: https://github.com/BlockRunAI/runcode/issues\n' });
    emitDone(ctx);
  },
  '/version': (ctx) => {
    ctx.onEvent({ kind: 'text_delta', text: `RunCode v${VERSION}\n` });
    emitDone(ctx);
  },
  '/mcp': async (ctx) => {
    const { listMcpServers } = await import('../mcp/client.js');
    const servers = listMcpServers();
    if (servers.length === 0) {
      ctx.onEvent({ kind: 'text_delta', text: 'No MCP servers connected.\nAdd servers to `~/.blockrun/mcp.json` or `.mcp.json` in your project.\n' });
    } else {
      let text = `**${servers.length} MCP server(s) connected:**\n\n`;
      for (const s of servers) {
        text += `  **${s.name}** — ${s.toolCount} tools\n`;
        for (const t of s.tools) text += `    · ${t}\n`;
      }
      ctx.onEvent({ kind: 'text_delta', text });
    }
    emitDone(ctx);
  },
  '/context': async (ctx) => {
    const { estimated, apiAnchored } = getAnchoredTokenCount(ctx.history);
    const contextWindow = getContextWindow(ctx.config.model);
    const usagePct = ((estimated / contextWindow) * 100).toFixed(1);
    ctx.onEvent({ kind: 'text_delta', text:
      `**Session Context**\n` +
      `  Model:      ${ctx.config.model}\n` +
      `  Mode:       ${ctx.config.permissionMode || 'default'}\n` +
      `  Messages:   ${ctx.history.length}\n` +
      `  Tokens:     ~${estimated.toLocaleString()} / ${(contextWindow / 1000).toFixed(0)}k (${usagePct}%)${apiAnchored ? ' ✓' : ' ~'}\n` +
      `  Session:    ${ctx.sessionId}\n` +
      `  Directory:  ${ctx.config.workingDir || process.cwd()}\n`
    });
    emitDone(ctx);
  },
  '/doctor': (ctx) => {
    const checks: string[] = [];
    try { execSync('git --version', { stdio: 'pipe' }); checks.push('✓ git available'); }
    catch { checks.push('✗ git not found'); }
    try { execSync('rg --version', { stdio: 'pipe' }); checks.push('✓ ripgrep available'); }
    catch { checks.push('⚠ ripgrep not found (using native grep fallback)'); }
    checks.push(fs.existsSync(path.join(BLOCKRUN_DIR, 'wallet.json')) ? '✓ wallet configured' : '⚠ no wallet — run: runcode setup');
    checks.push(fs.existsSync(path.join(BLOCKRUN_DIR, 'runcode-config.json')) ? '✓ config file exists' : '⚠ no config — using defaults');
    checks.push(`✓ model: ${ctx.config.model}`);
    checks.push(`✓ history: ${ctx.history.length} messages, ~${estimateHistoryTokens(ctx.history).toLocaleString()} tokens`);
    checks.push(`✓ session: ${ctx.sessionId}`);
    checks.push(`✓ version: v${VERSION}`);
    ctx.onEvent({ kind: 'text_delta', text: `**Health Check**\n${checks.map(c => '  ' + c).join('\n')}\n` });
    emitDone(ctx);
  },
  '/plan': (ctx) => {
    if (ctx.config.permissionMode === 'plan') {
      ctx.onEvent({ kind: 'text_delta', text: 'Already in plan mode. Use /execute to exit.\n' });
    } else {
      (ctx.config as { permissionMode: string }).permissionMode = 'plan';
      ctx.onEvent({ kind: 'text_delta', text: '**Plan mode active.** Tools restricted to read-only. Use /execute when ready to implement.\n' });
    }
    emitDone(ctx);
  },
  '/execute': (ctx) => {
    if (ctx.config.permissionMode !== 'plan') {
      ctx.onEvent({ kind: 'text_delta', text: 'Not in plan mode. Use /plan to enter.\n' });
    } else {
      (ctx.config as { permissionMode: string }).permissionMode = 'default';
      ctx.onEvent({ kind: 'text_delta', text: '**Execution mode.** All tools enabled with permissions.\n' });
    }
    emitDone(ctx);
  },
  '/sessions': (ctx) => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      ctx.onEvent({ kind: 'text_delta', text: 'No saved sessions.\n' });
    } else {
      let text = `**${sessions.length} saved sessions:**\n\n`;
      for (const s of sessions.slice(0, 10)) {
        const date = new Date(s.updatedAt).toLocaleString();
        const dir = s.workDir ? ` — ${s.workDir.split('/').pop()}` : '';
        text += `  ${s.id}  ${s.model}  ${s.turnCount} turns  ${date}${dir}\n`;
      }
      if (sessions.length > 10) text += `  ... and ${sessions.length - 10} more\n`;
      text += '\nUse /resume <session-id> to continue a session.\n';
      ctx.onEvent({ kind: 'text_delta', text });
    }
    emitDone(ctx);
  },
  '/compact': async (ctx) => {
    const beforeTokens = estimateHistoryTokens(ctx.history);
    const { history: compacted, compacted: didCompact } =
      await forceCompact(ctx.history, ctx.config.model, ctx.client, ctx.config.debug);
    if (didCompact) {
      ctx.history.length = 0;
      ctx.history.push(...compacted);
      resetTokenAnchor();
    }
    const afterTokens = estimateHistoryTokens(ctx.history);
    ctx.onEvent({ kind: 'text_delta', text: didCompact
      ? `Compacted: ~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens\n`
      : `History too short to compact (${beforeTokens.toLocaleString()} tokens, ${ctx.history.length} messages).\n`
    });
    emitDone(ctx);
  },
};

// Prompt-rewrite commands (transformed into agent prompts)
const REWRITE_COMMANDS: Record<string, string> = {
  '/commit': 'Review the current git diff and staged changes. Stage relevant files with `git add`, then create a commit with a concise message summarizing the changes. Do NOT push to remote.',
  '/push': 'Push the current branch to the remote repository using `git push`. Show the result.',
  '/pr': 'Create a pull request for the current branch. First check `git log --oneline main..HEAD` to see commits, then use `gh pr create` with a descriptive title and body summarizing the changes. If gh CLI is not available, show the manual steps.',
  '/review': 'Review the current git diff. For each changed file, check for: bugs, security issues, missing error handling, performance problems, and style issues. Provide a brief summary of findings.',
  '/fix': 'Look at the most recent error or issue we discussed and fix it. Check the relevant files, identify the root cause, and apply the fix.',
  '/test': 'Detect the project test framework (look for package.json scripts, pytest, etc.) and run the test suite. Show a summary of results.',
  '/debug': 'Look at the most recent error in this session. Read the relevant source files, analyze the root cause, and suggest a fix with specific code changes.',
  '/init': 'Read the project structure: check package.json (or equivalent), README, and key config files. Summarize: what this project is, main language/framework, entry points, and how to run/test it.',
  '/todo': 'Search the codebase for TODO, FIXME, HACK, and XXX comments using Grep. Show the results grouped by file.',
  '/deps': 'Read the project dependency file (package.json, requirements.txt, go.mod, Cargo.toml, etc.) and list key dependencies with their versions.',
  '/optimize': 'Analyze the codebase for performance issues. Check for: unnecessary re-renders, N+1 queries, missing indexes, unoptimized loops, large bundle sizes, and memory leaks. Provide specific recommendations.',
  '/security': 'Audit the codebase for security issues. Check for: SQL injection, XSS, command injection, hardcoded secrets, insecure dependencies, OWASP top 10 vulnerabilities. Report findings with severity.',
  '/lint': 'Check for code quality issues: unused imports, inconsistent naming, missing type annotations, long functions, duplicated code. Suggest improvements.',
  '/migrate': 'Check for pending database migrations, outdated dependencies, or breaking changes that need addressing. List required migration steps.',
  '/clean': 'Find and remove dead code: unused imports, unreachable code, commented-out blocks, unused variables and functions. Show what would be removed before making changes.',
  '/tasks': 'List all current tasks using the Task tool.',
};

// Commands with arguments (prefix match → rewrite)
const ARG_COMMANDS: Array<{ prefix: string; rewrite: (arg: string) => string }> = [
  { prefix: '/explain ', rewrite: (a) => `Read and explain the code in ${a}. Cover: what it does, key functions/classes, how it connects to the rest of the codebase.` },
  { prefix: '/search ', rewrite: (a) => `Search the codebase for "${a}" using Grep. Show the matching files and relevant code context.` },
  { prefix: '/find ', rewrite: (a) => `Find files matching the pattern "${a}" using Glob. Show the results.` },
  { prefix: '/refactor ', rewrite: (a) => `Refactor: ${a}. Read the relevant code first, then make targeted changes. Explain each change.` },
  { prefix: '/scaffold ', rewrite: (a) => `Create the scaffolding/boilerplate for: ${a}. Generate the file structure and initial code. Ask me if you need clarification on requirements.` },
  { prefix: '/doc ', rewrite: (a) => `Generate documentation for ${a}. Include: purpose, API/interface description, usage examples, and important notes.` },
];

// ─── Main dispatch ────────────────────────────────────────────────────────

/**
 * Handle a slash command. Returns result indicating what happened.
 */
export async function handleSlashCommand(
  input: string,
  ctx: CommandContext
): Promise<CommandResult> {
  // Direct-handled commands
  if (input in DIRECT_COMMANDS) {
    await DIRECT_COMMANDS[input](ctx);
    return { handled: true };
  }

  // /branch has both no-arg and with-arg forms
  if (input === '/branch' || input.startsWith('/branch ')) {
    const cwd = ctx.config.workingDir || process.cwd();
    if (input === '/branch') {
      const r = gitCmd(ctx, 'git branch -v --no-color');
      ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'Not a git repo.\n' });
    } else {
      const branchName = input.slice(8).trim();
      const r = gitCmd(ctx, `git checkout -b ${branchName}`);
      if (r !== null) ctx.onEvent({ kind: 'text_delta', text: `Created and switched to branch: **${branchName}**\n` });
    }
    emitDone(ctx);
    return { handled: true };
  }

  // /resume <id>
  if (input.startsWith('/resume ')) {
    const targetId = input.slice(8).trim();
    const restored = loadSessionHistory(targetId);
    if (restored.length === 0) {
      ctx.onEvent({ kind: 'text_delta', text: `Session "${targetId}" not found or empty.\n` });
    } else {
      ctx.history.length = 0;
      ctx.history.push(...restored);
      resetTokenAnchor();
      ctx.onEvent({ kind: 'text_delta', text: `Restored ${restored.length} messages from ${targetId}. Continue where you left off.\n` });
    }
    emitDone(ctx);
    return { handled: true };
  }

  // Simple rewrite commands (exact match)
  if (input in REWRITE_COMMANDS) {
    return { handled: false, rewritten: REWRITE_COMMANDS[input] };
  }

  // Argument-based rewrite commands (prefix match)
  for (const { prefix, rewrite } of ARG_COMMANDS) {
    if (input.startsWith(prefix)) {
      const arg = input.slice(prefix.length).trim();
      return { handled: false, rewritten: rewrite(arg) };
    }
  }

  // Not a recognized command
  return { handled: false };
}
