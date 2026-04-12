/**
 * franklin migrate — one-click import from other AI coding agents.
 *
 * Detects installed tools (Claude Code, Cline, Cursor, etc.),
 * shows what can be migrated, and imports with user confirmation.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';
function detectSources() {
    const sources = [];
    const home = os.homedir();
    // ── Claude Code ──
    const claudeDir = path.join(home, '.claude');
    if (fs.existsSync(claudeDir)) {
        const items = [];
        // MCP servers
        const claudeMcp = path.join(claudeDir, 'mcp.json');
        if (fs.existsSync(claudeMcp)) {
            items.push({
                label: 'MCP servers',
                source: claudeMcp,
                target: path.join(BLOCKRUN_DIR, 'mcp.json'),
                size: fileSize(claudeMcp),
                transform: () => migrateMcp(claudeMcp),
            });
        }
        // Global instructions → learnings
        const claudeMd = path.join(claudeDir, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
            items.push({
                label: 'Global instructions (CLAUDE.md)',
                source: claudeMd,
                target: path.join(BLOCKRUN_DIR, 'learnings.jsonl'),
                size: fileSize(claudeMd),
                transform: () => migrateInstructions(claudeMd),
            });
        }
        // Session history
        const claudeHistory = path.join(claudeDir, 'history.jsonl');
        if (fs.existsSync(claudeHistory)) {
            const lines = countLines(claudeHistory);
            items.push({
                label: `Session history (${lines.toLocaleString()} messages)`,
                source: claudeHistory,
                target: path.join(BLOCKRUN_DIR, 'sessions'),
                size: fileSize(claudeHistory),
                transform: () => migrateSessions(claudeHistory),
            });
        }
        // Project memory files
        const projectsDir = path.join(claudeDir, 'projects');
        if (fs.existsSync(projectsDir)) {
            const memoryFiles = findMemoryFiles(projectsDir);
            if (memoryFiles.length > 0) {
                items.push({
                    label: `Project memories (${memoryFiles.length} files)`,
                    source: projectsDir,
                    target: path.join(BLOCKRUN_DIR, 'learnings.jsonl'),
                    size: `${memoryFiles.length} files`,
                    transform: () => migrateMemories(memoryFiles),
                });
            }
        }
        if (items.length > 0) {
            sources.push({ name: 'Claude Code', dir: claudeDir, items });
        }
    }
    // ── Cline / OpenClaw ──
    const clineDir = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    if (fs.existsSync(clineDir)) {
        const items = [];
        // TODO: detect Cline data
        if (items.length > 0) {
            sources.push({ name: 'Cline', dir: clineDir, items });
        }
    }
    // ── Cursor ──
    const cursorDir = path.join(home, 'Library', 'Application Support', 'Cursor');
    if (fs.existsSync(cursorDir)) {
        const items = [];
        // TODO: detect Cursor data
        if (items.length > 0) {
            sources.push({ name: 'Cursor', dir: cursorDir, items });
        }
    }
    return sources;
}
// ─── Transforms ───────────────────────────────────────────────────────────
function migrateMcp(source) {
    const target = path.join(BLOCKRUN_DIR, 'mcp.json');
    const raw = JSON.parse(fs.readFileSync(source, 'utf-8'));
    // Claude Code format: { mcpServers: { name: { command, args, env } } }
    // Franklin format:    { mcpServers: { name: { transport, command, args, label } } }
    const servers = {};
    if (raw.mcpServers) {
        for (const [name, config] of Object.entries(raw.mcpServers)) {
            servers[name] = {
                transport: config.transport || 'stdio',
                command: config.command,
                args: config.args || [],
                label: name,
                ...(config.env ? { env: config.env } : {}),
            };
        }
    }
    // Merge with existing Franklin MCP config
    let existing = {};
    try {
        if (fs.existsSync(target)) {
            existing = JSON.parse(fs.readFileSync(target, 'utf-8'));
        }
    }
    catch { /* start fresh */ }
    const merged = {
        mcpServers: {
            ...(existing.mcpServers || {}),
            ...servers,
        },
    };
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, null, 2));
    console.log(chalk.green(`    ✓ ${Object.keys(servers).length} MCP server(s) imported`));
}
function migrateInstructions(source) {
    // Read CLAUDE.md and convert key preferences to learnings
    const content = fs.readFileSync(source, 'utf-8');
    const learningsPath = path.join(BLOCKRUN_DIR, 'learnings.jsonl');
    // Extract simple preference lines as learnings
    const lines = content.split('\n');
    const learnings = [];
    const now = Date.now();
    let count = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines, headers, and code blocks
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('|'))
            continue;
        // Skip very short or very long lines
        if (trimmed.length < 15 || trimmed.length > 200)
            continue;
        // Skip lines that are just paths or URLs
        if (trimmed.startsWith('/') || trimmed.startsWith('http'))
            continue;
        // Lines starting with - or * are likely preference rules
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            const text = trimmed.slice(2).trim();
            if (text.length > 15) {
                const entry = {
                    id: `migrate-${count++}`,
                    learning: text.slice(0, 200),
                    category: 'other',
                    confidence: 0.8,
                    source_session: 'migrate:claude-code',
                    created_at: now,
                    last_confirmed: now,
                    times_confirmed: 1,
                };
                learnings.push(JSON.stringify(entry));
            }
        }
    }
    if (learnings.length > 0) {
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        // Append to existing learnings
        fs.appendFileSync(learningsPath, learnings.join('\n') + '\n');
        console.log(chalk.green(`    ✓ ${learnings.length} preferences imported`));
    }
    else {
        console.log(chalk.dim('    ○ No extractable preferences found'));
    }
}
function migrateSessions(source) {
    const sessionsDir = path.join(BLOCKRUN_DIR, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const raw = fs.readFileSync(source, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    // Group by conversation turns — each user+assistant pair is a chunk
    // We'll create session files grouped by day
    const sessions = new Map();
    for (const line of lines) {
        try {
            const msg = JSON.parse(line);
            // Use date from the line or current date as session key
            const dateKey = new Date().toISOString().split('T')[0];
            // Try to extract timestamp if present
            const ts = msg.timestamp || msg.created_at || msg.ts;
            const key = ts ? new Date(ts).toISOString().split('T')[0] : dateKey;
            if (!sessions.has(key))
                sessions.set(key, []);
            sessions.get(key).push(line);
        }
        catch {
            // Skip unparseable lines
        }
    }
    let imported = 0;
    for (const [dateKey, msgs] of sessions) {
        const sessionId = `imported-${dateKey}`;
        const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
        // Don't overwrite existing imported sessions
        if (fs.existsSync(sessionFile))
            continue;
        fs.writeFileSync(sessionFile, msgs.join('\n') + '\n');
        // Create metadata
        const meta = {
            id: sessionId,
            model: 'imported',
            workDir: os.homedir(),
            createdAt: new Date(dateKey).getTime(),
            updatedAt: Date.now(),
            turnCount: Math.floor(msgs.length / 2),
            messageCount: msgs.length,
        };
        fs.writeFileSync(path.join(sessionsDir, `${sessionId}.meta.json`), JSON.stringify(meta, null, 2));
        imported++;
    }
    console.log(chalk.green(`    ✓ ${lines.length.toLocaleString()} messages → ${imported} session(s)`));
}
function migrateMemories(files) {
    const learningsPath = path.join(BLOCKRUN_DIR, 'learnings.jsonl');
    const now = Date.now();
    let count = 0;
    const entries = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```'))
                    continue;
                if (trimmed.startsWith('- ') && trimmed.length > 20 && trimmed.length < 200) {
                    const text = trimmed.slice(2).trim();
                    // Skip index entries (links to other files)
                    if (text.startsWith('[') && text.includes(']('))
                        continue;
                    entries.push(JSON.stringify({
                        id: `memory-${count++}`,
                        learning: text.slice(0, 200),
                        category: 'other',
                        confidence: 0.7,
                        source_session: 'migrate:project-memory',
                        created_at: now,
                        last_confirmed: now,
                        times_confirmed: 1,
                    }));
                }
            }
        }
        catch { /* skip unreadable files */ }
    }
    if (entries.length > 0) {
        fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
        fs.appendFileSync(learningsPath, entries.join('\n') + '\n');
        console.log(chalk.green(`    ✓ ${entries.length} memories imported`));
    }
    else {
        console.log(chalk.dim('    ○ No extractable memories found'));
    }
}
// ─── Helpers ──────────────────────────────────────────────────────────────
function fileSize(p) {
    try {
        const bytes = fs.statSync(p).size;
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    catch {
        return '?';
    }
}
function countLines(p) {
    try {
        return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).length;
    }
    catch {
        return 0;
    }
}
function findMemoryFiles(projectsDir) {
    const files = [];
    try {
        for (const project of fs.readdirSync(projectsDir)) {
            const memoryDir = path.join(projectsDir, project, 'memory');
            if (!fs.existsSync(memoryDir))
                continue;
            for (const file of fs.readdirSync(memoryDir)) {
                if (file.endsWith('.md') && file !== 'MEMORY.md') {
                    files.push(path.join(memoryDir, file));
                }
            }
        }
    }
    catch { /* ignore */ }
    return files;
}
// ─── Interactive prompt ───────────────────────────────────────────────────
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
    });
}
// ─── Main command ─────────────────────────────────────────────────────────
export async function migrateCommand() {
    console.log(chalk.bold('\n  franklin migrate\n'));
    const sources = detectSources();
    if (sources.length === 0) {
        console.log(chalk.dim('  No other AI tools detected. Nothing to migrate.\n'));
        console.log(chalk.dim('  Supported: Claude Code, Cline, Cursor\n'));
        return;
    }
    // Show what was found
    for (const source of sources) {
        console.log(chalk.bold(`  ${chalk.green('●')} ${source.name}`) + chalk.dim(` (${source.dir})`));
        for (const item of source.items) {
            console.log(chalk.dim(`    ├─ ${item.label}`) + (item.size ? chalk.dim(` [${item.size}]`) : ''));
        }
        console.log('');
    }
    const total = sources.reduce((n, s) => n + s.items.length, 0);
    const answer = await ask(chalk.yellow(`  Import ${total} item(s) into Franklin? [Y/n] `));
    if (answer && answer !== 'y' && answer !== 'yes') {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
    }
    console.log('');
    // Run migrations
    for (const source of sources) {
        console.log(chalk.bold(`  Migrating from ${source.name}...`));
        for (const item of source.items) {
            try {
                item.transform();
            }
            catch (err) {
                console.log(chalk.red(`    ✗ ${item.label}: ${err.message}`));
            }
        }
        console.log('');
    }
    console.log(chalk.green('  Done.') + chalk.dim(' Run `franklin --trust` to start.\n'));
}
// ─── First-run detection (called from start.ts) ──────────────────────────
const MIGRATED_MARKER = path.join(BLOCKRUN_DIR, '.migrated');
/**
 * Check if other AI tools are installed and suggest migration.
 * Only runs once — writes a marker file after first check.
 * Returns true if the user chose to migrate (caller should re-run start after).
 */
export async function checkAndSuggestMigration() {
    // Only suggest once
    if (fs.existsSync(MIGRATED_MARKER))
        return false;
    // Write marker immediately so we never ask again
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString());
    const sources = detectSources();
    if (sources.length === 0)
        return false;
    const names = sources.map(s => s.name).join(', ');
    const total = sources.reduce((n, s) => n + s.items.length, 0);
    console.log(chalk.bold(`\n  ${chalk.green('●')} Found ${names} — ${total} items available to import.`));
    const answer = await ask(chalk.yellow(`  Import into Franklin? [Y/n] `));
    if (answer && answer !== 'y' && answer !== 'yes') {
        console.log(chalk.dim('  Skipped. Run `franklin migrate` anytime.\n'));
        return false;
    }
    console.log('');
    for (const source of sources) {
        console.log(chalk.bold(`  Migrating from ${source.name}...`));
        for (const item of source.items) {
            try {
                item.transform();
            }
            catch (err) {
                console.log(chalk.red(`    ✗ ${item.label}: ${err.message}`));
            }
        }
    }
    console.log(chalk.green('\n  Done.') + ' Starting Franklin...\n');
    return true;
}
