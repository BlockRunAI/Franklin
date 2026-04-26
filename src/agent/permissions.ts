/**
 * Permission system for Franklin.
 * Controls which tools can execute automatically vs. require user approval.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';
import { classifyBashRisk } from './bash-guard.js';

// ─── Common dev command patterns (auto-allow without prompting) ──────────
// These are "normal" risk commands that are too common to interrupt the user.
// Only applied when --trust flag is set (user explicitly opted into auto-mode).

const COMMON_DEV_PATTERNS = [
  /^npm\s+(install|i|ci|run|exec|test|start|build|lint|format|outdated|ls|list|info|view|pack)\b/,
  /^(pnpm|yarn|bun)\s+(install|add|run|test|build|lint|exec)\b/,
  /^pip3?\s+install\b/,
  /^python3?\s+/,
  /^node\s+/,
  /^(pytest|jest|vitest|mocha)\b/,
  /^(tsc|eslint|prettier|biome)\b/,
  /^git\s+(add|commit|push|pull|fetch|status|diff|log|branch|checkout|switch|merge|rebase|stash|tag|remote|show)\b/,
  /^(cat|head|tail|wc|sort|uniq|diff|file|which|whoami|hostname|uname|date|echo)\b/,
  /^(ls|pwd|cd|mkdir|touch)\b/,
  /^(docker|docker-compose)\s+(ps|logs|images|inspect|stats|exec|build|run|pull)\b/,
  /^(curl|wget)\s+/,
  /^make\b/,
  /^cargo\s+(build|test|check|clippy|run|bench|doc|fmt)\b/,
  /^go\s+(build|test|run|vet|fmt|mod)\b/,
];

function isCommonDevCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  return COMMON_DEV_PATTERNS.some(p => p.test(trimmed));
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export interface PermissionRules {
  allow: string[];  // Tool names auto-allowed (e.g. "Read", "Glob", "Bash(git *)")
  deny: string[];   // Tool names auto-denied
  ask: string[];    // Tool names that require prompting
}

export type PermissionMode = 'default' | 'trust' | 'deny-all' | 'plan';

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason?: string;
}

// ─── Default Rules ─────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'Task', 'AskUser', 'ActivateTool', 'ImageGen', 'TradingSignal', 'TradingMarket', 'SearchX']);
const DESTRUCTIVE_TOOLS = new Set(['Write', 'Edit', 'Bash']);

const DEFAULT_RULES: PermissionRules = {
  allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'AskUser', 'ActivateTool', 'ImageGen', 'TradingSignal', 'TradingMarket', 'SearchX'],
  deny: [],
  ask: ['Write', 'Edit', 'Bash', 'Agent', 'PostToX'],
};

// ─── Permission Manager ────────────────────────────────────────────────────

export class PermissionManager {
  private rules: PermissionRules;
  private mode: PermissionMode;
  private sessionAllowed = new Set<string>(); // "always allow" for this session
  private promptFn?: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;

  constructor(
    mode: PermissionMode = 'default',
    promptFn?: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>
  ) {
    this.mode = mode;
    this.rules = this.loadRules();
    this.promptFn = promptFn;
  }

  /**
   * Check if a tool can be used. Returns the decision.
   */
  async check(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    // Trust mode: allow everything
    if (this.mode === 'trust') {
      return { behavior: 'allow', reason: 'trust mode' };
    }

    // Plan mode: only allow read-only tools
    if (this.mode === 'plan') {
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: 'allow', reason: 'plan mode — read-only' };
      }
      return { behavior: 'deny', reason: 'plan mode — use /execute to enable writes' };
    }

    // Deny-all mode: deny everything that isn't read-only
    if (this.mode === 'deny-all') {
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: 'allow', reason: 'read-only tool' };
      }
      return { behavior: 'deny', reason: 'deny-all mode' };
    }

    // Check session-level always-allow
    const sessionKey = this.sessionKey(toolName, input);
    if (this.sessionAllowed.has(toolName) || this.sessionAllowed.has(sessionKey)) {
      return { behavior: 'allow', reason: 'session allow' };
    }

    // Check explicit deny rules
    if (this.matchesRule(toolName, input, this.rules.deny)) {
      return { behavior: 'deny', reason: 'denied by rule' };
    }

    // Check explicit allow rules
    if (this.matchesRule(toolName, input, this.rules.allow)) {
      return { behavior: 'allow', reason: 'allowed by rule' };
    }

    // Check explicit ask rules — with Bash risk classification
    if (this.matchesRule(toolName, input, this.rules.ask)) {
      // Bash Guardian: classify risk before blindly asking
      if (toolName === 'Bash') {
        const cmd = (input.command as string) || '';
        const risk = classifyBashRisk(cmd);
        if (risk.level === 'safe') {
          return { behavior: 'allow', reason: 'safe command' };
        }
        // dangerous and normal both ask, but dangerous gets a warning in describeAction
      }
      return { behavior: 'ask' };
    }

    // Default: read-only tools are auto-allowed, others ask
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: 'allow', reason: 'read-only default' };
    }

    return { behavior: 'ask' };
  }

  /**
   * Prompt the user interactively for permission.
   * Uses injected promptFn (Ink UI) when available, falls back to readline.
   * pendingCount: how many more operations of this type are waiting (including this one).
   * Returns true if allowed, false if denied.
   */
  async promptUser(
    toolName: string,
    input: Record<string, unknown>,
    pendingCount = 1
  ): Promise<boolean> {
    const description = this.describeAction(toolName, input);
    // Append pending-count hint so user knows to press [a] to skip all
    const hint = pendingCount > 1
      ? `${description}\n  │ \x1b[33m${pendingCount} pending — press [a] to allow all\x1b[0m`
      : description;

    // Ink UI path: use injected prompt function to avoid stdin conflict.
    // Ink owns stdin in raw mode; a second readline would get EOF immediately.
    if (this.promptFn) {
      const result = await this.promptFn(toolName, hint);
      if (result === 'always') {
        this.sessionAllowed.add(toolName);
        return true;
      }
      return result === 'yes';
    }

    // Readline fallback (basic terminal / piped mode)
    console.error('');
    console.error(chalk.yellow('  ╭─ Permission required ─────────────────'));
    console.error(chalk.yellow(`  │ ${toolName}`));
    console.error(chalk.dim(`  │ ${description}`));
    if (pendingCount > 1) {
      console.error(chalk.yellow(`  │ ${pendingCount} pending — press [a] to allow all`));
    }
    console.error(chalk.yellow('  ╰─────────────────────────────────────'));

    const answer = await askQuestion(
      chalk.bold('  Allow? ') + chalk.dim('[Y/a/n] ')
    );

    const normalized = answer.trim().toLowerCase();

    if (normalized === 'a' || normalized === 'always') {
      this.sessionAllowed.add(toolName);
      console.error(chalk.green(`  ✓ ${toolName} allowed for this session`));
      return true;
    }

    if (normalized === 'y' || normalized === 'yes' || normalized === '') {
      return true;
    }

    console.error(chalk.red(`  ✗ ${toolName} denied`));
    return false;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private loadRules(): PermissionRules {
    const configPath = path.join(BLOCKRUN_DIR, 'franklin-permissions.json');
    const legacyPath = path.join(BLOCKRUN_DIR, 'runcode-permissions.json');
    // One-shot migration from the old name. If the user only has the legacy
    // file, rename it so future writes/reads land on the franklin path.
    try {
      if (!fs.existsSync(configPath) && fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, configPath);
      }
    } catch { /* best effort */ }
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return {
          allow: [...DEFAULT_RULES.allow, ...(raw.allow || [])],
          deny: [...(raw.deny || [])],
          ask: [...DEFAULT_RULES.ask, ...(raw.ask || [])],
        };
      }
    } catch { /* use defaults */ }
    return { ...DEFAULT_RULES };
  }

  private matchesRule(
    toolName: string,
    input: Record<string, unknown>,
    rules: string[]
  ): boolean {
    for (const rule of rules) {
      // Exact tool name match
      if (rule === toolName) return true;

      // Pattern match: "Bash(git *)" matches Bash with command starting with "git "
      const patternMatch = rule.match(/^(\w+)\((.+)\)$/);
      if (patternMatch) {
        const [, ruleTool, pattern] = patternMatch;
        if (ruleTool !== toolName) continue;

        // Match against the primary input field
        const primaryValue = this.getPrimaryInputValue(toolName, input);
        if (primaryValue && this.globMatch(pattern, primaryValue)) {
          return true;
        }
      }
    }
    return false;
  }

  private getPrimaryInputValue(toolName: string, input: Record<string, unknown>): string | null {
    switch (toolName) {
      case 'Bash': return (input.command as string) || null;
      case 'Read': return (input.file_path as string) || null;
      case 'Write': return (input.file_path as string) || null;
      case 'Edit': return (input.file_path as string) || null;
      default: return null;
    }
  }

  private globMatch(pattern: string, text: string): boolean {
    // Glob matching: * matches non-space chars, ** matches anything
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      '^' +
      escaped
        .replace(/\*\*/g, '{{GLOB_STAR}}')
        .replace(/\*/g, '[^ ]*')
        .replace(/\{\{GLOB_STAR\}\}/g, '.*')
      + '$'
    );
    return regex.test(text);
  }

  private sessionKey(toolName: string, input: Record<string, unknown>): string {
    const primary = this.getPrimaryInputValue(toolName, input);
    return primary ? `${toolName}:${primary}` : toolName;
  }

  private describeAction(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        const cmd = (input.command as string) || '';
        const preview = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
        const risk = classifyBashRisk(cmd);
        if (risk.level === 'dangerous') {
          return `\x1b[31m⚠ DANGEROUS: ${risk.reason}\x1b[0m\n  │ Execute: ${preview}`;
        }
        return `Execute: ${preview}`;
      }
      case 'Write': {
        const fp = (input.file_path as string) || '';
        return `Write file: ${fp}`;
      }
      case 'Edit': {
        const fp = (input.file_path as string) || '';
        const old = (input.old_string as string) || '';
        return `Edit ${fp}: replace "${old.slice(0, 60)}${old.length > 60 ? '...' : ''}"`;
      }
      case 'Agent':
        return `Launch sub-agent: ${(input.description as string) || (input.prompt as string)?.slice(0, 80) || 'task'}`;
      default:
        return JSON.stringify(input).slice(0, 120);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function askQuestion(prompt: string): Promise<string> {
  // Non-TTY (piped/scripted) input: cannot ask interactively — auto-allow.
  // The caller (permissionMode logic in start.ts) already routes piped sessions
  // to trust mode, so this path is rarely hit. Guard here for safety.
  if (!process.stdin.isTTY) {
    process.stderr.write(prompt + 'y (auto-approved: non-interactive mode)\n');
    return Promise.resolve('y');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  return new Promise<string>((resolve) => {
    let answered = false;
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      if (!answered) resolve('n'); // Default deny on EOF for safety
    });
  });
}
