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
import { getStatsSummary } from '../stats/tracker.js';
import { resolveModel } from '../ui/model-picker.js';
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
    // Prefer stderr (actual git error message) over the noisy "Command failed: ..." header
    const errObj = e as Error & { stderr?: Buffer | string };
    const stderr = errObj.stderr ? String(errObj.stderr).trim() : '';
    // Take only the first meaningful line (git sometimes dumps full usage on errors)
    const firstLine = (stderr || errObj.message || 'unknown').split('\n')[0].trim();
    ctx.onEvent({ kind: 'text_delta', text: `Git: ${firstLine}\n` });
    return null;
  }
}

function emitDone(ctx: CommandContext) {
  ctx.onEvent({ kind: 'turn_done', reason: 'completed' });
}

// ─── Exchange grouping ────────────────────────────────────────────────────────
// An "exchange" = one user text prompt + all following entries until the next
// user text prompt (tool calls, tool results, assistant replies).
// Operating on exchanges — not raw indices — guarantees history stays in valid
// user/assistant alternation after deletion (API rejects non-alternating roles).

interface Exchange {
  userText: string;
  assistantText: string;
  toolNames: string[];
  startIdx: number; // inclusive raw history index
  endIdx: number;   // inclusive raw history index
}

function buildExchanges(history: Dialogue[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let i = 0;
  while (i < history.length) {
    const msg = history[i];
    if (msg.role !== 'user') { i++; continue; }
    const userText = extractText(msg);
    if (!userText) { i++; continue; } // skip tool_result-only user messages

    const startIdx = i;
    let endIdx = i;
    let assistantText = '';
    const toolNames: string[] = [];

    let j = i + 1;
    while (j < history.length) {
      const next = history[j];
      if (next.role === 'user' && extractText(next)) break; // next exchange
      if (next.role === 'assistant') {
        const t = extractText(next);
        if (t && !assistantText) assistantText = t;
        if (Array.isArray(next.content)) {
          for (const p of next.content) {
            if (p.type === 'tool_use' && !toolNames.includes(p.name)) toolNames.push(p.name);
          }
        }
      }
      endIdx = j;
      j++;
    }
    exchanges.push({
      userText: userText.slice(0, 120) + (userText.length > 120 ? '…' : ''),
      assistantText: (assistantText.slice(0, 80) + (assistantText.length > 80 ? '…' : '')) || '(no text)',
      toolNames,
      startIdx,
      endIdx,
    });
    i = j;
  }
  return exchanges;
}

function extractText(msg: Dialogue): string {
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  for (const p of msg.content) {
    if (p.type === 'text' && p.text.trim()) return p.text.trim();
  }
  return '';
}

// ─── Command Definitions ──────────────────────────────────────────────────

// Direct-handled commands (don't go to agent)
const DIRECT_COMMANDS: Record<string, (ctx: CommandContext) => Promise<void> | void> = {
  '/stash': (ctx) => {
    const r = gitCmd(ctx, 'git stash push -m "runcode auto-stash"', 10000);
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r ? `${r}\n` : 'No changes to stash.\n' });
    emitDone(ctx);
  },
  '/unstash': (ctx) => {
    const r = gitCmd(ctx, 'git stash pop', 10000);
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r ? `${r}\n` : 'Stash applied.\n' });
    emitDone(ctx);
  },
  '/log': (ctx) => {
    const r = gitCmd(ctx, 'git log --oneline -15 --no-color');
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'No commits yet.\n' });
    emitDone(ctx);
  },
  '/status': (ctx) => {
    const r = gitCmd(ctx, 'git status --short --branch');
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'Working tree clean.\n' });
    emitDone(ctx);
  },
  '/diff': (ctx) => {
    // git diff with stat header then full diff
    const stat = gitCmd(ctx, 'git diff --stat --no-color');
    if (stat === null) { emitDone(ctx); return; }
    const full = gitCmd(ctx, 'git diff --no-color');
    if (full === null) { emitDone(ctx); return; }
    if (!stat && !full) {
      ctx.onEvent({ kind: 'text_delta', text: 'No unstaged changes.\n' });
    } else {
      ctx.onEvent({ kind: 'text_delta', text: `\`\`\`diff\n${[stat, full].filter(Boolean).join('\n---\n')}\n\`\`\`\n` });
    }
    emitDone(ctx);
  },
  '/undo': (ctx) => {
    const r = gitCmd(ctx, 'git reset --soft HEAD~1');
    if (r !== null) ctx.onEvent({ kind: 'text_delta', text: `Last commit undone. Changes preserved in staging.\n` });
    emitDone(ctx);
  },
  '/tokens': (ctx) => {
    const { estimated, apiAnchored } = getAnchoredTokenCount(ctx.history);
    const contextWindow = getContextWindow(ctx.config.model);
    const pct = (estimated / contextWindow) * 100;
    // Count tool results and thinking blocks
    let toolResults = 0;
    let thinkingBlocks = 0;
    let totalToolChars = 0;
    for (const msg of ctx.history) {
      if (typeof msg.content === 'string') continue;
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if ('type' in part) {
          if (part.type === 'tool_result') {
            toolResults++;
            const c = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
            totalToolChars += c.length;
          }
          if (part.type === 'thinking') thinkingBlocks++;
        }
      }
    }
    ctx.onEvent({ kind: 'text_delta', text:
      `**Token Usage**\n` +
      `  Estimated:  ~${estimated.toLocaleString()} tokens ${apiAnchored ? '(API-anchored)' : '(estimated)'}\n` +
      `  Context:    ${(contextWindow / 1000).toFixed(0)}k window (${pct.toFixed(1)}% used)\n` +
      `  Messages:   ${ctx.history.length}\n` +
      `  Tool results: ${toolResults} (${(totalToolChars / 1024).toFixed(0)}KB)\n` +
      `  Thinking:   ${thinkingBlocks} blocks\n` +
      (pct > 80 ? '  ⚠ Near limit — run /compact\n' : '') +
      (pct > 60 ? '' : '  ✓ Healthy\n')
    });
    emitDone(ctx);
  },
  '/help': (ctx) => {
    const ultrathinkOn = (ctx.config as { ultrathink?: boolean }).ultrathink;
    ctx.onEvent({ kind: 'text_delta', text:
      `**RunCode Commands**\n\n` +
      `  **Coding:** /commit /review /test /fix /debug /explain /search /find /refactor /scaffold\n` +
      `  **Git:** /push /pr /undo /status /diff /log /branch /stash /unstash\n` +
      `  **Analysis:** /security /lint /optimize /todo /deps /clean /migrate /doc\n` +
      `  **Session:** /plan /ultraplan /execute /compact /retry /sessions /resume /session-search /context /tasks\n` +
      `  **Power:** /ultrathink [query] /ultraplan /dump\n` +
      `  **Info:** /model /wallet /cost /tokens /learnings /mcp /doctor /version /bug /help\n` +
      `  **UI:** /clear /exit\n` +
      (ultrathinkOn ? `\n  Ultrathink: ON\n` : '')
    });
    emitDone(ctx);
  },
  '/history': (ctx) => {
    const { history, config } = ctx;
    const modelName = config.model.split('/').pop() || config.model;
    const exchanges = buildExchanges(history);
    let output = '**Conversation History**\n\n';
    if (exchanges.length === 0) {
      output += 'No history in the current session yet.\n';
    } else {
      for (let i = 0; i < exchanges.length; i++) {
        const ex = exchanges[i];
        const tools = ex.toolNames.length > 0 ? ` · used: ${ex.toolNames.join(', ')}` : '';
        output += `[${i + 1}] [user] ${ex.userText}\n`;
        output += `     [${modelName}] ${ex.assistantText}${tools}\n\n`;
      }
    }
    output += 'Use `/delete <number>` to remove exchanges (e.g., `/delete 2` or `/delete 3-5`).\n';
    ctx.onEvent({ kind: 'text_delta', text: output });
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
    const pct = (estimated / contextWindow) * 100;
    const usagePct = pct.toFixed(1);
    const warning = pct > 80 ? '  ⚠ Near limit — consider /compact\n' : '';
    ctx.onEvent({ kind: 'text_delta', text:
      `**Session Context**\n` +
      `  Model:      ${ctx.config.model}\n` +
      `  Mode:       ${ctx.config.permissionMode || 'default'}\n` +
      `  Messages:   ${ctx.history.length}\n` +
      `  Tokens:     ~${estimated.toLocaleString()} / ${(contextWindow / 1000).toFixed(0)}k (${usagePct}%)${apiAnchored ? ' ✓' : ' ~'}\n` +
      warning +
      `  Session:    ${ctx.sessionId}\n` +
      `  Directory:  ${ctx.config.workingDir || process.cwd()}\n`
    });
    emitDone(ctx);
  },
  '/doctor': async (ctx) => {
    const checks: string[] = [];
    try { execSync('git --version', { stdio: 'pipe' }); checks.push('✓ git available'); }
    catch { checks.push('✗ git not found'); }
    try { execSync('rg --version', { stdio: 'pipe' }); checks.push('✓ ripgrep available'); }
    catch { checks.push('⚠ ripgrep not found (using native grep fallback)'); }
    const hasWallet = fs.existsSync(path.join(BLOCKRUN_DIR, 'wallet.json'))
      || fs.existsSync(path.join(BLOCKRUN_DIR, 'solana-wallet.json'));
    checks.push(hasWallet ? '✓ wallet configured' : '⚠ no wallet — run: runcode setup');
    checks.push(fs.existsSync(path.join(BLOCKRUN_DIR, 'runcode-config.json')) ? '✓ config file exists' : '⚠ no config — using defaults');
    // Check MCP
    const { listMcpServers } = await import('../mcp/client.js');
    const mcpServers = listMcpServers();
    checks.push(mcpServers.length > 0
      ? `✓ MCP: ${mcpServers.length} server(s), ${mcpServers.reduce((a, s) => a + s.toolCount, 0)} tools`
      : '⚠ no MCP servers connected');
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
  '/ultrathink': (ctx) => {
    const cfg = ctx.config as { ultrathink?: boolean };
    cfg.ultrathink = !cfg.ultrathink;
    if (cfg.ultrathink) {
      ctx.onEvent({ kind: 'text_delta', text:
        '**Ultrathink mode ON.** Extended reasoning active — the model will think deeply before responding.\n' +
        'Use `/ultrathink` again to disable, or `/ultrathink <query>` to send a one-shot deep analysis.\n'
      });
    } else {
      ctx.onEvent({ kind: 'text_delta', text: '**Ultrathink mode OFF.** Normal response mode restored.\n' });
    }
    emitDone(ctx);
  },
  '/dump': (ctx) => {
    const instructions = ctx.config.systemInstructions;
    const joined = instructions.join('\n\n---\n\n');
    ctx.onEvent({ kind: 'text_delta', text:
      `**System Prompt** (${instructions.length} section${instructions.length !== 1 ? 's' : ''}):\n\n` +
      `\`\`\`\n${joined.slice(0, 4000)}${joined.length > 4000 ? `\n... (${joined.length - 4000} chars truncated)` : ''}\n\`\`\`\n`
    });
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
        const current = s.id === ctx.sessionId ? '  (current)' : '';
        text += `  ${s.id}  ${s.model}  ${s.turnCount} turns  ${date}${dir}${current}\n`;
      }
      if (sessions.length > 10) text += `  ... and ${sessions.length - 10} more\n`;
      text += '\nUse /resume to restore the latest session, or /resume <session-id> for a specific one.\n';
      ctx.onEvent({ kind: 'text_delta', text });
    }
    emitDone(ctx);
  },
  '/cost': async (ctx) => {
    const { stats, saved } = getStatsSummary();
    ctx.onEvent({ kind: 'text_delta', text:
      `**Session Cost**\n` +
      `  Requests: ${stats.totalRequests}\n` +
      `  Cost:     $${stats.totalCostUsd.toFixed(4)} USDC\n` +
      `  Saved:    $${saved.toFixed(2)} vs Claude Opus\n` +
      `  Tokens:   ${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out\n`
    });
    emitDone(ctx);
  },
  '/wallet': async (ctx) => {
    const chain = (await import('../config.js')).loadChain();
    try {
      let address: string;
      let balance: string;
      const fetchTimeout = (ms: number) => new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), ms)
      );
      if (chain === 'solana') {
        const { getOrCreateSolanaWallet, setupAgentSolanaWallet } = await import('@blockrun/llm');
        const w = await getOrCreateSolanaWallet();
        address = w.address;
        try {
          const client = await setupAgentSolanaWallet({ silent: true });
          const bal = await Promise.race([client.getBalance(), fetchTimeout(5000)]) as number;
          balance = `$${bal.toFixed(2)} USDC`;
        } catch { balance = '(unavailable)'; }
      } else {
        const { getOrCreateWallet, setupAgentWallet } = await import('@blockrun/llm');
        const w = getOrCreateWallet();
        address = w.address;
        try {
          const client = setupAgentWallet({ silent: true });
          const bal = await Promise.race([client.getBalance(), fetchTimeout(5000)]) as number;
          balance = `$${bal.toFixed(2)} USDC`;
        } catch { balance = '(unavailable)'; }
      }
      ctx.onEvent({ kind: 'text_delta', text:
        `**Wallet**\n` +
        `  Chain:   ${chain}\n` +
        `  Address: ${address}\n` +
        `  Balance: ${balance}\n`
      });
    } catch (err) {
      ctx.onEvent({ kind: 'text_delta', text: `Wallet error: ${(err as Error).message}\n` });
    }
    emitDone(ctx);
  },
  '/clear': (ctx) => {
    ctx.history.length = 0;
    resetTokenAnchor();
    ctx.onEvent({ kind: 'text_delta', text: 'Conversation history cleared.\n' });
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
      const afterTokens = estimateHistoryTokens(ctx.history);
      const saved = beforeTokens - afterTokens;
      const pct = Math.round((saved / beforeTokens) * 100);
      ctx.onEvent({ kind: 'text_delta', text:
        `Compacted: ~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens (saved ${pct}%)\n`
      });
    } else {
      ctx.onEvent({ kind: 'text_delta', text:
        `Nothing to compact — history is already minimal (${beforeTokens.toLocaleString()} tokens, ${ctx.history.length} messages).\n`
      });
    }
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
  '/ultraplan': 'Enter ultraplan mode: create a detailed, step-by-step implementation plan before writing any code. ' +
    'First, thoroughly read ALL relevant files. Map out every dependency and potential side effect. ' +
    'Identify edge cases, security considerations, and performance implications. ' +
    'Then produce a numbered implementation plan with specific file paths, function names, and code changes. ' +
    'Do NOT write any code yet — only the plan.',
};

// Commands with arguments (prefix match → rewrite)
const ARG_COMMANDS: Array<{ prefix: string; rewrite: (arg: string) => string }> = [
  { prefix: '/ultrathink ', rewrite: (a) =>
    `Think deeply, carefully, and thoroughly before responding. ` +
    `Consider multiple approaches, check edge cases, reason through implications step by step, ` +
    `and challenge your initial assumptions. Take your time — quality of reasoning matters more than speed. ` +
    `Now respond to: ${a}`
  },
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

  // /session-search <query> — full-text search past sessions
  if (
    input === '/session-search' ||
    input.startsWith('/session-search ') ||
    input === '/ssearch' ||
    input.startsWith('/ssearch ')
  ) {
    const prefix = input.startsWith('/ssearch') ? '/ssearch' : '/session-search';
    const query = input === prefix ? '' : input.slice(prefix.length + 1).trim();
    if (!query) {
      ctx.onEvent({ kind: 'text_delta', text:
        'Usage: /session-search <query>\n' +
        'Finds past sessions whose messages match the query.\n' +
        'Use quotes for phrase search: /session-search "payment loop"\n'
      });
      emitDone(ctx);
      return { handled: true };
    }
    const { searchSessions, formatSearchResults } = await import('../session/search.js');
    const matches = searchSessions(query, { limit: 10 });
    ctx.onEvent({ kind: 'text_delta', text: formatSearchResults(matches, query) });
    emitDone(ctx);
    return { handled: true };
  }

  // /insights [--days N] — rich usage insights
  if (input === '/insights' || input.startsWith('/insights ')) {
    const daysMatch = input.match(/--days\s+(\d+)/);
    const days = daysMatch ? parseInt(daysMatch[1], 10) : 30;
    const { generateInsights, formatInsights } = await import('../stats/insights.js');
    const report = generateInsights(days);
    ctx.onEvent({ kind: 'text_delta', text: formatInsights(report, days) });
    emitDone(ctx);
    return { handled: true };
  }

  // /learnings — view or clear per-user learnings
  if (input === '/learnings' || input.startsWith('/learnings ')) {
    const { loadLearnings, decayLearnings, saveLearnings } = await import('../learnings/store.js');
    const arg = input.slice('/learnings'.length).trim();
    if (arg === 'clear') {
      saveLearnings([]);
      ctx.onEvent({ kind: 'text_delta', text: 'All learnings cleared.\n' });
    } else {
      let learnings = loadLearnings();
      if (learnings.length === 0) {
        ctx.onEvent({ kind: 'text_delta', text: 'No learnings yet. Franklin learns your preferences over time.\n' });
      } else {
        learnings = decayLearnings(learnings);
        const sorted = [...learnings].sort(
          (a, b) => (b.confidence * b.times_confirmed) - (a.confidence * a.times_confirmed)
        );
        let text = `**Personal Learnings** (${sorted.length})\n\n`;
        for (const l of sorted) {
          const conf = l.confidence >= 0.8 ? 'high' : l.confidence >= 0.5 ? 'mid' : 'low';
          text += `  [${conf}] ${l.learning} (×${l.times_confirmed})\n`;
        }
        text += '\nUse `/learnings clear` to reset.\n';
        ctx.onEvent({ kind: 'text_delta', text });
      }
    }
    emitDone(ctx);
    return { handled: true };
  }

  // /model — show current model or switch with /model <name>
  if (input === '/model' || input.startsWith('/model ')) {
    if (input === '/model') {
      ctx.onEvent({ kind: 'text_delta', text:
        `Current model: **${ctx.config.model}**\n` +
        `Switch with: \`/model <name>\` (e.g. \`/model sonnet\`, \`/model free\`, \`/model gemini\`)\n`
      });
    } else {
      const newModel = resolveModel(input.slice(7).trim());
      ctx.config.model = newModel;
      ctx.config.onModelChange?.(newModel);
      ctx.onEvent({ kind: 'text_delta', text: `Model → **${newModel}**\n` });
    }
    emitDone(ctx);
    return { handled: true };
  }

  // /branch has both no-arg and with-arg forms
  if (input === '/branch' || input.startsWith('/branch ')) {
    const cwd = ctx.config.workingDir || process.cwd();
    if (input === '/branch') {
      const r = gitCmd(ctx, 'git branch -v --no-color');
      if (r !== null) ctx.onEvent({ kind: 'text_delta', text: r ? `\`\`\`\n${r}\n\`\`\`\n` : 'No branches yet.\n' });
    } else {
      const branchName = input.slice(8).trim();
      const r = gitCmd(ctx, `git checkout -b ${branchName}`);
      if (r !== null) ctx.onEvent({ kind: 'text_delta', text: `Created and switched to branch: **${branchName}**\n` });
    }
    emitDone(ctx);
    return { handled: true };
  }

  // /delete <...>
  if (input.startsWith('/delete ')) {
    const arg = input.slice('/delete '.length).trim();
    if (!arg) {
      ctx.onEvent({ kind: 'text_delta', text: 'Usage: /delete <exchange> (e.g., /delete 3, /delete 2,5, /delete 4-7)\n' });
      emitDone(ctx);
      return { handled: true };
    }

    // Parse exchange numbers (1-based) into a set of 0-based exchange indices
    const exchangeIndicesToDelete = new Set<number>();
    const parts = arg.split(',').map(p => p.trim());
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n, 10));
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          for (let i = start; i <= end; i++) exchangeIndicesToDelete.add(i - 1);
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n)) exchangeIndicesToDelete.add(n - 1);
      }
    }

    if (exchangeIndicesToDelete.size === 0) {
      ctx.onEvent({ kind: 'text_delta', text: 'No valid exchange numbers provided.\n' });
      emitDone(ctx);
      return { handled: true };
    }

    // Map exchange indices → raw history index ranges, then delete descending.
    // This preserves valid user/assistant alternation — each exchange covers the
    // full unit: user prompt + all tool calls/results + assistant replies.
    const exchanges = buildExchanges(ctx.history);
    const rawToDelete = new Set<number>();
    const deletedNums: number[] = [];

    for (const exIdx of exchangeIndicesToDelete) {
      const ex = exchanges[exIdx];
      if (!ex) continue;
      for (let i = ex.startIdx; i <= ex.endIdx; i++) rawToDelete.add(i);
      deletedNums.push(exIdx + 1);
    }

    const sorted = Array.from(rawToDelete).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx >= 0 && idx < ctx.history.length) ctx.history.splice(idx, 1);
    }

    if (deletedNums.length > 0) {
      resetTokenAnchor();
      ctx.onEvent({ kind: 'text_delta', text: `Deleted exchange(s) ${deletedNums.sort((a, b) => a - b).join(', ')} from history.\n` });
    } else {
      ctx.onEvent({ kind: 'text_delta', text: 'No matching exchanges found to delete.\n' });
    }

    emitDone(ctx);
    return { handled: true };
  }

  // /resume or /resume <id>
  if (input === '/resume' || input.startsWith('/resume ')) {
    const targetId = input === '/resume'
      ? listSessions().find((session) => session.id !== ctx.sessionId)?.id ?? ''
      : input.slice(8).trim();

    if (!targetId) {
      ctx.onEvent({ kind: 'text_delta', text: 'No previous session available to resume.\n' });
      emitDone(ctx);
      return { handled: true };
    }

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

  // Not a recognized command — suggest closest match
  const allCommands = [
    ...Object.keys(DIRECT_COMMANDS),
    ...Object.keys(REWRITE_COMMANDS),
    ...ARG_COMMANDS.map(c => c.prefix.trim()),
    '/branch', '/resume', '/model', '/wallet', '/cost', '/help', '/clear', '/retry', '/exit', '/session-search', '/ssearch',
  ];
  const cmd = input.split(/\s/)[0];
  const close = allCommands.filter(c => {
    // Simple distance: share >= 50% of characters
    const shorter = Math.min(cmd.length, c.length);
    let matches = 0;
    for (let i = 0; i < shorter; i++) {
      if (cmd[i] === c[i]) matches++;
    }
    return matches >= shorter * 0.5 && matches >= 3;
  });
  if (close.length > 0) {
    ctx.onEvent({ kind: 'text_delta', text: `Unknown command: ${cmd}. Did you mean: ${close.slice(0, 3).join(', ')}?\n` });
    emitDone(ctx);
    return { handled: true };
  }

  // Truly unknown — pass through as regular input
  return { handled: false };
}
