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
function isCommonDevCommand(cmd) {
    const trimmed = cmd.trim();
    return COMMON_DEV_PATTERNS.some(p => p.test(trimmed));
}
// ─── Default Rules ─────────────────────────────────────────────────────────
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'Task', 'AskUser', 'ImageGen', 'TradingSignal', 'TradingMarket', 'SearchX']);
const DESTRUCTIVE_TOOLS = new Set(['Write', 'Edit', 'Bash']);
const DEFAULT_RULES = {
    allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'AskUser', 'ImageGen', 'TradingSignal', 'TradingMarket', 'SearchX'],
    deny: [],
    ask: ['Write', 'Edit', 'Bash', 'Agent', 'PostToX'],
};
// ─── Permission Manager ────────────────────────────────────────────────────
export class PermissionManager {
    rules;
    mode;
    sessionAllowed = new Set(); // "always allow" for this session
    promptFn;
    constructor(mode = 'default', promptFn) {
        this.mode = mode;
        this.rules = this.loadRules();
        this.promptFn = promptFn;
    }
    /**
     * Check if a tool can be used. Returns the decision.
     */
    async check(toolName, input) {
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
                const cmd = input.command || '';
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
    async promptUser(toolName, input, pendingCount = 1) {
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
        const answer = await askQuestion(chalk.bold('  Allow? ') + chalk.dim('[Y/a/n] '));
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
    loadRules() {
        const configPath = path.join(BLOCKRUN_DIR, 'runcode-permissions.json');
        try {
            if (fs.existsSync(configPath)) {
                const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                return {
                    allow: [...DEFAULT_RULES.allow, ...(raw.allow || [])],
                    deny: [...(raw.deny || [])],
                    ask: [...DEFAULT_RULES.ask, ...(raw.ask || [])],
                };
            }
        }
        catch { /* use defaults */ }
        return { ...DEFAULT_RULES };
    }
    matchesRule(toolName, input, rules) {
        for (const rule of rules) {
            // Exact tool name match
            if (rule === toolName)
                return true;
            // Pattern match: "Bash(git *)" matches Bash with command starting with "git "
            const patternMatch = rule.match(/^(\w+)\((.+)\)$/);
            if (patternMatch) {
                const [, ruleTool, pattern] = patternMatch;
                if (ruleTool !== toolName)
                    continue;
                // Match against the primary input field
                const primaryValue = this.getPrimaryInputValue(toolName, input);
                if (primaryValue && this.globMatch(pattern, primaryValue)) {
                    return true;
                }
            }
        }
        return false;
    }
    getPrimaryInputValue(toolName, input) {
        switch (toolName) {
            case 'Bash': return input.command || null;
            case 'Read': return input.file_path || null;
            case 'Write': return input.file_path || null;
            case 'Edit': return input.file_path || null;
            default: return null;
        }
    }
    globMatch(pattern, text) {
        // Glob matching: * matches non-space chars, ** matches anything
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('^' +
            escaped
                .replace(/\*\*/g, '{{GLOB_STAR}}')
                .replace(/\*/g, '[^ ]*')
                .replace(/\{\{GLOB_STAR\}\}/g, '.*')
            + '$');
        return regex.test(text);
    }
    sessionKey(toolName, input) {
        const primary = this.getPrimaryInputValue(toolName, input);
        return primary ? `${toolName}:${primary}` : toolName;
    }
    describeAction(toolName, input) {
        switch (toolName) {
            case 'Bash': {
                const cmd = input.command || '';
                const preview = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
                const risk = classifyBashRisk(cmd);
                if (risk.level === 'dangerous') {
                    return `\x1b[31m⚠ DANGEROUS: ${risk.reason}\x1b[0m\n  │ Execute: ${preview}`;
                }
                return `Execute: ${preview}`;
            }
            case 'Write': {
                const fp = input.file_path || '';
                return `Write file: ${fp}`;
            }
            case 'Edit': {
                const fp = input.file_path || '';
                const old = input.old_string || '';
                return `Edit ${fp}: replace "${old.slice(0, 60)}${old.length > 60 ? '...' : ''}"`;
            }
            case 'Agent':
                return `Launch sub-agent: ${input.description || input.prompt?.slice(0, 80) || 'task'}`;
            default:
                return JSON.stringify(input).slice(0, 120);
        }
    }
}
// ─── Helpers ───────────────────────────────────────────────────────────────
function askQuestion(prompt) {
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
    return new Promise((resolve) => {
        let answered = false;
        rl.question(prompt, (answer) => {
            answered = true;
            rl.close();
            resolve(answer);
        });
        rl.on('close', () => {
            if (!answered)
                resolve('n'); // Default deny on EOF for safety
        });
    });
}
