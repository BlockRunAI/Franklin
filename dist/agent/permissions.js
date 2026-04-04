/**
 * Permission system for runcode.
 * Controls which tools can execute automatically vs. require user approval.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';
// ─── Default Rules ─────────────────────────────────────────────────────────
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'Task']);
const DESTRUCTIVE_TOOLS = new Set(['Write', 'Edit', 'Bash']);
const DEFAULT_RULES = {
    allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'],
    deny: [],
    ask: ['Write', 'Edit', 'Bash', 'Agent'],
};
// ─── Permission Manager ────────────────────────────────────────────────────
export class PermissionManager {
    rules;
    mode;
    sessionAllowed = new Set(); // "always allow" for this session
    constructor(mode = 'default') {
        this.mode = mode;
        this.rules = this.loadRules();
    }
    /**
     * Check if a tool can be used. Returns the decision.
     */
    async check(toolName, input) {
        // Trust mode: allow everything
        if (this.mode === 'trust') {
            return { behavior: 'allow', reason: 'trust mode' };
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
        // Check explicit ask rules
        if (this.matchesRule(toolName, input, this.rules.ask)) {
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
     * Returns true if allowed, false if denied.
     */
    async promptUser(toolName, input) {
        const description = this.describeAction(toolName, input);
        console.error('');
        console.error(chalk.yellow(`  Permission required: ${toolName}`));
        console.error(chalk.dim(`  ${description}`));
        console.error('');
        const answer = await askQuestion(chalk.bold('  Allow? ') + chalk.dim('[Y/n/a]lways: '));
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
                return `Execute: ${cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd}`;
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
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: process.stdin.isTTY ?? false,
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
                resolve('n'); // Default deny on EOF (piped input) for safety
        });
    });
}
