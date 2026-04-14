/**
 * Bash Risk Classifier — lightweight Guardian for Franklin.
 *
 * Classifies bash commands into three risk levels:
 *   safe      — read-only or standard dev commands → auto-approve
 *   normal    — typical mutations (file writes, installs) → default ask behavior
 *   dangerous — destructive/irreversible operations → always ask, with warning
 *
 * Inspired by OpenAI Codex's Guardian system, but deterministic pattern matching
 * instead of an LLM call. Fast, predictable, zero-cost.
 */
// ─── Dangerous Patterns ──────────────────────────────────────────────────
// Checked first. If ANY pattern matches, the command is dangerous.
const DANGEROUS_PATTERNS = [
    // Destructive file operations
    [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+[/~]/, 'recursive delete on root/home'],
    [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f/, 'forced recursive delete'],
    [/\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, 'forced recursive delete'],
    [/\bmkfs\b/, 'format filesystem'],
    [/\bdd\s+.*of=/, 'raw disk write'],
    // Git irreversible operations
    [/\bgit\s+push\s+.*--force\b/, 'force push'],
    [/\bgit\s+push\s+-f\b/, 'force push'],
    [/\bgit\s+reset\s+--hard\b/, 'hard reset — discards uncommitted changes'],
    [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean — deletes untracked files'],
    [/\bgit\s+checkout\s+--\s+\./, 'discard all working changes'],
    [/\bgit\s+branch\s+-D\b/, 'force delete branch'],
    // Database destructive
    [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 'drop database objects'],
    [/\bTRUNCATE\s+TABLE\b/i, 'truncate table'],
    // System-level danger
    [/\bchmod\s+(-R\s+)?777\b/, 'world-writable permissions'],
    [/\bcurl\s+.*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe URL to shell'],
    [/\bwget\s+.*\|\s*(sudo\s+)?(ba)?sh\b/, 'pipe URL to shell'],
    [/\bsudo\s+rm\b/, 'sudo delete'],
    // Kill/shutdown
    [/\bkill\s+-9\s+-1\b/, 'kill all processes'],
    [/\bshutdown\b/, 'system shutdown'],
    [/\breboot\b/, 'system reboot'],
];
// ─── Safe Commands ────────────────────────────────────────────────────────
// If ALL segments use these commands, auto-approve.
const SAFE_COMMANDS = new Set([
    // Filesystem read-only
    'ls', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'file', 'stat', 'tree',
    'find', 'grep', 'rg', 'ag', 'ack', 'which', 'whereis', 'type',
    'echo', 'printf', 'date', 'whoami', 'hostname', 'uname', 'printenv',
    'pwd', 'realpath', 'dirname', 'basename',
    // Text processing (read-only when not redirecting)
    'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'less', 'more',
    'wc', 'tee', 'xargs',
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
    'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
    'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list',
    'ls-files', 'ls-tree', 'ls-remote', 'config', 'reflog',
]);
const SAFE_PKG_SUBCOMMANDS = new Set([
    'test', 'run', 'list', 'ls', 'info', 'view', 'show',
    'outdated', 'audit', 'start', 'dev', 'serve', 'lint', 'check',
    'why', 'explain', 'doctor',
]);
const SAFE_CARGO_SUBCOMMANDS = new Set([
    'test', 'check', 'clippy', 'build', 'run', 'bench', 'doc',
    'fmt', 'tree', 'metadata', 'verify-project',
]);
// ─── Classifier ──────────────────────────────────────────────────────────
export function classifyBashRisk(command) {
    // 1. Check dangerous patterns first (highest priority)
    for (const [pattern, reason] of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
            return { level: 'dangerous', reason };
        }
    }
    // 2. Check if every segment is a known-safe command
    const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);
    let allSafe = true;
    for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed)
            continue;
        if (!isSegmentSafe(trimmed)) {
            allSafe = false;
            break;
        }
    }
    if (allSafe && segments.some(s => s.trim().length > 0)) {
        return { level: 'safe' };
    }
    return { level: 'normal' };
}
function isSegmentSafe(segment) {
    // Parse: strip env vars, extract command and args
    const words = segment.split(/\s+/).filter(w => !w.includes('='));
    let idx = 0;
    let cmd = words[idx] || '';
    // Strip harmless prefixes
    while (['time', 'nice'].includes(cmd) && idx < words.length - 1) {
        cmd = words[++idx] || '';
    }
    // sudo → not safe (even if the underlying command is safe)
    if (cmd === 'sudo')
        return false;
    const baseName = cmd.split('/').pop() || cmd;
    const argIdx = idx + 1;
    const subCmd = words[argIdx] || '';
    // git
    if (baseName === 'git') {
        return SAFE_GIT_SUBCOMMANDS.has(subCmd);
    }
    // npm / yarn / pnpm / bun / npx
    if (['npm', 'npx', 'yarn', 'pnpm', 'bun'].includes(baseName)) {
        // "npm run <script>" — safe (dev servers, linters, etc.)
        if (subCmd === 'run')
            return true;
        return SAFE_PKG_SUBCOMMANDS.has(subCmd);
    }
    // cargo
    if (baseName === 'cargo') {
        return SAFE_CARGO_SUBCOMMANDS.has(subCmd);
    }
    // rtk (RTK wrapper — safe, it's a proxy)
    if (baseName === 'rtk')
        return true;
    // Known safe base command
    if (SAFE_COMMANDS.has(baseName)) {
        // sed -i is not read-only
        if (baseName === 'sed' && segment.includes(' -i'))
            return false;
        // Output redirection means writing — not safe
        if (/>\s*[^&|]/.test(segment))
            return false;
        return true;
    }
    // Version/help checks are always safe
    if (/\s+(-v|--version|-V)\s*$/.test(segment))
        return true;
    if (/\s+(-h|--help)\s*$/.test(segment))
        return true;
    // gh (GitHub CLI) read-only commands
    if (baseName === 'gh') {
        const ghAction = words.slice(argIdx, argIdx + 2).join(' ');
        if (/^(pr|issue|repo|release|run)\s+(view|list|status|diff|checks|comments)/.test(ghAction))
            return true;
        if (subCmd === 'api')
            return true; // gh api is read-only (GET)
        if (subCmd === 'auth' && words[argIdx + 1] === 'status')
            return true;
        return false;
    }
    // docker/podman read-only
    if (baseName === 'docker' || baseName === 'podman') {
        if (['ps', 'images', 'inspect', 'logs', 'stats', 'top', 'port', 'version', 'info'].includes(subCmd))
            return true;
        return false;
    }
    return false;
}
