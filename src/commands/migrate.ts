/**
 * franklin migrate — one-click import from existing AI-agent configs.
 *
 * Detects standard config locations on disk (`~/.claude/`, VS Code extension
 * storage, `~/Library/Application Support/` editor dirs) and imports what's
 * there with user confirmation. Recognizes tools by their config layout,
 * not by brand.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import chalk from 'chalk';
import { BLOCKRUN_DIR } from '../config.js';

// ─── Source detection ─────────────────────────────────────────────────────

interface MigrationSource {
  name: string;
  dir: string;
  items: MigrationItem[];
}

interface MigrationItem {
  label: string;
  source: string;
  target: string;
  transform: () => void;
  size?: string;
}

function detectSources(): MigrationSource[] {
  const sources: MigrationSource[] = [];
  const home = os.homedir();

  // ── `~/.claude/` config dir (used by several agent CLIs) ──
  // Real Claude Code (2026 layout) writes:
  //   ~/.claude.json                       (top-level, mcpServers + global state)
  //   ~/.claude/CLAUDE.md                  (global instructions)
  //   ~/.claude/projects/<slug>/<uuid>.jsonl  (one file per session)
  //   ~/.claude/projects/<slug>/memory/*.md   (project memories)
  // Older agents and pre-3.x Claude Code variants wrote:
  //   ~/.claude/mcp.json
  //   ~/.claude/history.jsonl
  // We support both — prefer the new layout but fall back so users with
  // legacy state still get their data imported.
  const claudeDir = path.join(home, '.claude');
  const claudeJson = path.join(home, '.claude.json');
  const hasClaudeData = fs.existsSync(claudeDir) || fs.existsSync(claudeJson);
  if (hasClaudeData) {
    const items: MigrationItem[] = [];

    // MCP servers — prefer top-level ~/.claude.json (new layout); fall back
    // to legacy ~/.claude/mcp.json. Only add one item; whichever we find
    // first is what migrateMcp() will read.
    const newMcpHasServers = fileHasMcpServers(claudeJson);
    const legacyMcp = path.join(claudeDir, 'mcp.json');
    if (newMcpHasServers) {
      items.push({
        label: 'MCP servers (~/.claude.json)',
        source: claudeJson,
        target: path.join(BLOCKRUN_DIR, 'mcp.json'),
        size: fileSize(claudeJson),
        transform: () => migrateMcp(claudeJson),
      });
    } else if (fs.existsSync(legacyMcp)) {
      items.push({
        label: 'MCP servers (legacy ~/.claude/mcp.json)',
        source: legacyMcp,
        target: path.join(BLOCKRUN_DIR, 'mcp.json'),
        size: fileSize(legacyMcp),
        transform: () => migrateMcp(legacyMcp),
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

    // Session history — prefer per-project session JSONLs (new layout); fall
    // back to legacy ~/.claude/history.jsonl. The new layout preserves session
    // boundaries (one file = one conversation) instead of collapsing every
    // message into a daily blob.
    const projectsDir = path.join(claudeDir, 'projects');
    const sessionFiles = fs.existsSync(projectsDir) ? findClaudeCodeSessionFiles(projectsDir) : [];
    const legacyHistory = path.join(claudeDir, 'history.jsonl');
    if (sessionFiles.length > 0) {
      items.push({
        label: `Session history (${sessionFiles.length.toLocaleString()} sessions)`,
        source: projectsDir,
        target: path.join(BLOCKRUN_DIR, 'sessions'),
        size: `${sessionFiles.length} files`,
        transform: () => migrateClaudeCodeSessions(sessionFiles),
      });
    } else if (fs.existsSync(legacyHistory)) {
      const lines = countLines(legacyHistory);
      items.push({
        label: `Session history (legacy, ${lines.toLocaleString()} messages)`,
        source: legacyHistory,
        target: path.join(BLOCKRUN_DIR, 'sessions'),
        size: fileSize(legacyHistory),
        transform: () => migrateSessions(legacyHistory),
      });
    }

    // Project memory files
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
      sources.push({ name: '~/.claude/', dir: claudeDir, items });
    }
  }

  // ── VS Code agent extension storage ──
  const clineDir = path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  if (fs.existsSync(clineDir)) {
    const items: MigrationItem[] = [];
    // TODO: detect VS Code agent extension data
    if (items.length > 0) {
      sources.push({ name: 'VS Code agent extension', dir: clineDir, items });
    }
  }

  // ── ~/Library/Application Support editor agent ──
  const cursorDir = path.join(home, 'Library', 'Application Support', 'Cursor');
  if (fs.existsSync(cursorDir)) {
    const items: MigrationItem[] = [];
    // TODO: detect editor agent data
    if (items.length > 0) {
      sources.push({ name: 'editor agent config', dir: cursorDir, items });
    }
  }

  return sources;
}

// ─── Transforms ───────────────────────────────────────────────────────────

function migrateMcp(source: string): void {
  const target = path.join(BLOCKRUN_DIR, 'mcp.json');
  const raw = JSON.parse(fs.readFileSync(source, 'utf-8'));

  // Source format (Claude Code ~/.claude.json or legacy mcp.json):
  //   { mcpServers: { name: { type?, transport?, command, args, env? } } }
  //   ~/.claude.json wraps mcpServers among hundreds of unrelated state keys —
  //   we only read the one field.
  // Franklin format: { mcpServers: { name: { transport, command, args, label } } }
  const servers: Record<string, unknown> = {};
  const skipped: string[] = [];
  if (raw.mcpServers) {
    for (const [name, config] of Object.entries(raw.mcpServers as Record<string, Record<string, unknown>>)) {
      // Skip MCP servers that require external credentials (OAuth, API keys,
      // tokens) — importing them causes noisy startup errors because the
      // credentials aren't available in Franklin's context. Users can add
      // these manually via ~/.blockrun/mcp.json if they set up the credentials.
      const configStr = JSON.stringify(config).toLowerCase();
      const needsCredentials =
        configStr.includes('oauth') ||
        configStr.includes('credential') ||
        configStr.includes('api_key') ||
        configStr.includes('api-key') ||
        configStr.includes('token') ||
        name.includes('calendar') ||
        name.includes('gmail') ||
        name.includes('google') ||
        name.includes('slack') ||
        name.includes('notion');
      if (needsCredentials) {
        skipped.push(name);
        continue;
      }
      servers[name] = {
        // Claude Code uses `type`; older agents used `transport`. Accept both.
        transport: (config.transport as string) || (config.type as string) || 'stdio',
        command: config.command,
        args: config.args || [],
        label: name,
        ...(config.env ? { env: config.env } : {}),
      };
    }
  }

  // Merge with existing Franklin MCP config
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(target)) {
      existing = JSON.parse(fs.readFileSync(target, 'utf-8'));
    }
  } catch { /* start fresh */ }

  const merged = {
    mcpServers: {
      ...((existing as { mcpServers?: Record<string, unknown> }).mcpServers || {}),
      ...servers,
    },
  };

  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  const importedCount = Object.keys(servers).length;
  console.log(chalk.green(`    ✓ ${importedCount} MCP server(s) imported`));
  if (skipped.length > 0) {
    console.log(chalk.dim(`    · ${skipped.length} skipped (need credentials): ${skipped.join(', ')}`));
  }
}

function migrateInstructions(source: string): void {
  // Read CLAUDE.md and convert key preferences to learnings
  const content = fs.readFileSync(source, 'utf-8');
  const learningsPath = path.join(BLOCKRUN_DIR, 'learnings.jsonl');

  // Extract simple preference lines as learnings
  const lines = content.split('\n');
  const learnings: string[] = [];
  const now = Date.now();
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, headers, and code blocks
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('|')) continue;
    // Skip very short or very long lines
    if (trimmed.length < 15 || trimmed.length > 200) continue;
    // Skip lines that are just paths or URLs
    if (trimmed.startsWith('/') || trimmed.startsWith('http')) continue;

    // Lines starting with - or * are likely preference rules
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const text = trimmed.slice(2).trim();
      if (text.length > 15) {
        const entry = {
          id: `migrate-${count++}`,
          learning: text.slice(0, 200),
          category: 'other',
          confidence: 0.8,
          source_session: 'migrate:dot-claude',
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
  } else {
    console.log(chalk.dim('    ○ No extractable preferences found'));
  }
}

/**
 * Import per-session JSONL files written by current Claude Code (2026 layout).
 * One source file = one Franklin session — we preserve session boundaries
 * instead of mashing everything into a daily blob like the legacy importer.
 *
 * Source line shape:
 *   { type: "user"|"assistant"|"attachment"|"permission-mode"|...,
 *     message?: { role, content }, timestamp, sessionId, cwd }
 * Target Dialogue line shape: { role, content }
 */
function migrateClaudeCodeSessions(sessionFiles: string[]): void {
  const sessionsDir = path.join(BLOCKRUN_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  let imported = 0;
  let skipped = 0;
  let totalTurns = 0;

  for (const file of sessionFiles) {
    const sessionId = path.basename(file, '.jsonl');
    const targetJsonl = path.join(sessionsDir, `${sessionId}.jsonl`);
    const targetMeta = path.join(sessionsDir, `${sessionId}.meta.json`);

    // Don't re-import on a second run — the user might have already
    // resumed and added turns to the imported session.
    if (fs.existsSync(targetMeta)) { skipped++; continue; }

    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const dialogues: string[] = [];
    let firstTs = 0;
    let lastTs = 0;
    let workDir = os.homedir();
    let model = 'claude-code-import';

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(trimmed); } catch { continue; }

      // Track timestamps + cwd from any line that has them.
      const ts = entry.timestamp;
      if (typeof ts === 'string') {
        const t = Date.parse(ts);
        if (Number.isFinite(t)) {
          if (!firstTs || t < firstTs) firstTs = t;
          if (t > lastTs) lastTs = t;
        }
      }
      if (typeof entry.cwd === 'string' && entry.cwd) workDir = entry.cwd;

      // Only user/assistant turns become Franklin Dialogue lines. Everything
      // else (attachments, permission-mode, summary, system) is metadata
      // we don't replay.
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const msg = entry.message as { role?: string; content?: unknown; model?: string } | undefined;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      if (typeof msg.model === 'string') model = msg.model;

      dialogues.push(JSON.stringify({ role: msg.role, content: msg.content }));
    }

    if (dialogues.length === 0) { skipped++; continue; }

    fs.writeFileSync(targetJsonl, dialogues.join('\n') + '\n');
    fs.writeFileSync(targetMeta, JSON.stringify({
      id: sessionId,
      model,
      workDir,
      createdAt: firstTs || Date.now(),
      updatedAt: lastTs || Date.now(),
      turnCount: Math.floor(dialogues.length / 2),
      messageCount: dialogues.length,
      imported: true,
    }, null, 2));
    imported++;
    totalTurns += dialogues.length;
  }

  const skipNote = skipped > 0 ? chalk.dim(` (${skipped} skipped)`) : '';
  console.log(chalk.green(`    ✓ ${imported} session(s) imported, ${totalTurns.toLocaleString()} turns${skipNote}`));
}

/** Walk ~/.claude/projects/<slug>/*.jsonl — one file per Claude Code session. */
function findClaudeCodeSessionFiles(projectsDir: string): string[] {
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(projectsDir); } catch { return out; }
  for (const project of projects) {
    const projectPath = path.join(projectsDir, project);
    let entries: string[] = [];
    try {
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;
      entries = fs.readdirSync(projectPath);
    } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      out.push(path.join(projectPath, entry));
    }
  }
  return out;
}

/** True iff the file is JSON with a non-empty mcpServers object. */
function fileHasMcpServers(p: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return !!raw && typeof raw === 'object' &&
      !!raw.mcpServers && typeof raw.mcpServers === 'object' &&
      Object.keys(raw.mcpServers).length > 0;
  } catch { return false; }
}

function migrateSessions(source: string): void {
  const sessionsDir = path.join(BLOCKRUN_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const raw = fs.readFileSync(source, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Group by conversation turns — each user+assistant pair is a chunk
  // We'll create session files grouped by day
  const sessions = new Map<string, string[]>();

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      // Use date from the line or current date as session key
      const dateKey = new Date().toISOString().split('T')[0];
      // Try to extract timestamp if present
      const ts = msg.timestamp || msg.created_at || msg.ts;
      const key = ts ? new Date(ts).toISOString().split('T')[0] : dateKey;

      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key)!.push(line);
    } catch {
      // Skip unparseable lines
    }
  }

  let imported = 0;
  for (const [dateKey, msgs] of sessions) {
    const sessionId = `imported-${dateKey}`;
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

    // Don't overwrite existing imported sessions
    if (fs.existsSync(sessionFile)) continue;

    fs.writeFileSync(sessionFile, msgs.join('\n') + '\n');

    // Create metadata. `imported: true` shields these from pruneOldSessions —
    // a fresh import of 200+ historical sessions would otherwise be deleted
    // on the next `franklin` launch when the agent loop prunes to 20.
    const meta = {
      id: sessionId,
      model: 'imported',
      workDir: os.homedir(),
      createdAt: new Date(dateKey).getTime(),
      updatedAt: Date.now(),
      turnCount: Math.floor(msgs.length / 2),
      messageCount: msgs.length,
      imported: true,
    };
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify(meta, null, 2)
    );
    imported++;
  }

  console.log(chalk.green(`    ✓ ${lines.length.toLocaleString()} messages → ${imported} session(s)`));
}

function migrateMemories(files: string[]): void {
  const learningsPath = path.join(BLOCKRUN_DIR, 'learnings.jsonl');
  const now = Date.now();
  let count = 0;
  const entries: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
        if (trimmed.startsWith('- ') && trimmed.length > 20 && trimmed.length < 200) {
          const text = trimmed.slice(2).trim();
          // Skip index entries (links to other files)
          if (text.startsWith('[') && text.includes('](')) continue;
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
    } catch { /* skip unreadable files */ }
  }

  if (entries.length > 0) {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.appendFileSync(learningsPath, entries.join('\n') + '\n');
    console.log(chalk.green(`    ✓ ${entries.length} memories imported`));
  } else {
    console.log(chalk.dim('    ○ No extractable memories found'));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fileSize(p: string): string {
  try {
    const bytes = fs.statSync(p).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch { return '?'; }
}

function countLines(p: string): number {
  try {
    return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).length;
  } catch { return 0; }
}

function findMemoryFiles(projectsDir: string): string[] {
  const files: string[] = [];
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const memoryDir = path.join(projectsDir, project, 'memory');
      if (!fs.existsSync(memoryDir)) continue;
      for (const file of fs.readdirSync(memoryDir)) {
        if (file.endsWith('.md') && file !== 'MEMORY.md') {
          files.push(path.join(memoryDir, file));
        }
      }
    }
  } catch { /* ignore */ }
  return files;
}

// ─── Interactive prompt ───────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ─── Main command ─────────────────────────────────────────────────────────

export async function migrateCommand(): Promise<void> {
  console.log(chalk.bold('\n  franklin migrate\n'));

  const sources = detectSources();

  if (sources.length === 0) {
    console.log(chalk.dim('  No other AI tools detected. Nothing to migrate.\n'));
    console.log(chalk.dim('  Looked for: ~/.claude.json, ~/.claude/, VS Code agent extension, editor agent configs\n'));
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
      } catch (err) {
        console.log(chalk.red(`    ✗ ${item.label}: ${(err as Error).message}`));
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
export async function checkAndSuggestMigration(): Promise<boolean> {
  // Only suggest once
  if (fs.existsSync(MIGRATED_MARKER)) return false;

  // Write marker immediately so we never ask again
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString());

  const sources = detectSources();
  if (sources.length === 0) return false;

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
      try { item.transform(); }
      catch (err) { console.log(chalk.red(`    ✗ ${item.label}: ${(err as Error).message}`)); }
    }
  }
  console.log(chalk.green('\n  Done.') + ' Starting Franklin...\n');
  return true;
}
