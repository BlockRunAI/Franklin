import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { appendToSession, createSessionId, updateSessionMeta } from './storage.js';
import type { Dialogue } from '../agent/types.js';

export type ExternalAgentSource = 'claude' | 'codex';

export interface ExternalSessionCandidate {
  id: string;
  source: ExternalAgentSource;
  cwd?: string;
  summary?: string;
  updatedAt: number;
  filePath: string;
  bytes: number;
}

interface ParsedExternalSession extends ExternalSessionCandidate {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
  toolEvents: string[];
}

const MAX_FILES_PER_SOURCE = 500;
const MAX_MESSAGES_IN_HANDOFF = 24;
const MAX_TOOL_EVENTS_IN_HANDOFF = 18;
const MAX_TEXT_CHARS = 3000;
const MAX_HANDOFF_CHARS = 24000;

export function parseExternalAgentSource(input: string): ExternalAgentSource | null {
  const normalized = input.trim().toLowerCase();
  return normalized === 'claude' || normalized === 'codex' ? normalized : null;
}

export async function importExternalSessionAsFranklin(
  source: ExternalAgentSource,
  externalSessionId: string | undefined,
  opts: { model: string; workDir: string },
): Promise<{ sessionId: string; imported: ExternalSessionCandidate }> {
  const candidates = discoverExternalSessions(source);
  if (candidates.length === 0) {
    throw new Error(`No ${source} sessions found.`);
  }

  if (!externalSessionId && !process.stdin.isTTY) {
    throw new Error(`--from ${source} requires a session id when stdin is not interactive.`);
  }

  const picked = externalSessionId
    ? resolveExternalSession(candidates, externalSessionId)
    : await pickExternalSession(source, candidates, opts.workDir);
  if (!picked) {
    throw new Error(`No ${source} session selected.`);
  }

  const parsed = parseExternalSession(picked);
  const sessionId = createSessionId();
  const now = Date.now();
  const handoff = buildHandoffPrompt(parsed);
  const handoffMessage: Dialogue = { role: 'user', content: handoff };
  const ackMessage: Dialogue = {
    role: 'assistant',
    content: 'I have the imported session context and will continue from that state in this new Franklin session.',
  };

  appendToSession(sessionId, handoffMessage);
  appendToSession(sessionId, ackMessage);
  updateSessionMeta(sessionId, {
    model: opts.model,
    workDir: parsed.cwd || opts.workDir,
    createdAt: now,
    updatedAt: now,
    turnCount: 1,
    messageCount: 2,
  });

  return { sessionId, imported: picked };
}

function discoverExternalSessions(source: ExternalAgentSource): ExternalSessionCandidate[] {
  const roots = source === 'codex' ? codexRoots() : claudeRoots();
  const files = roots.flatMap((root) => walkSessionFiles(root, source));
  const candidates = files
    .map((filePath) => sessionCandidateFromFile(source, filePath))
    .filter((candidate): candidate is ExternalSessionCandidate => candidate !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const byId = new Map<string, ExternalSessionCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || existing.updatedAt < candidate.updatedAt) {
      byId.set(candidate.id, candidate);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function codexRoots(): string[] {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

function claudeRoots(): string[] {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(root, 'projects')];
}

function walkSessionFiles(root: string, source: ExternalAgentSource): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES_PER_SOURCE) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isSessionFileName(source, entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function isSessionFileName(source: ExternalAgentSource, name: string): boolean {
  if (source === 'codex') return name.startsWith('rollout-') && name.endsWith('.jsonl');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name);
}

function sessionCandidateFromFile(source: ExternalAgentSource, filePath: string): ExternalSessionCandidate | null {
  try {
    const stats = fs.statSync(filePath);
    const partial = source === 'codex' ? readCodexMeta(filePath) : readClaudeMeta(filePath);
    const id = partial.id || idFromFileName(source, filePath);
    if (!id) return null;
    return {
      id,
      source,
      cwd: partial.cwd,
      summary: partial.summary,
      updatedAt: partial.updatedAt || stats.mtimeMs,
      filePath,
      bytes: stats.size,
    };
  } catch {
    return null;
  }
}

function idFromFileName(source: ExternalAgentSource, filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  if (source === 'codex') return base.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
  return base;
}

function readCodexMeta(filePath: string): { id?: string; cwd?: string; summary?: string; updatedAt?: number } {
  const out: { id?: string; cwd?: string; summary?: string; updatedAt?: number } = {};
  for (const record of readJsonlPrefix(filePath, 180)) {
    const type = stringProp(record, 'type');
    if (type === 'session_meta') {
      const payload = objectProp(record, 'payload');
      out.cwd ||= stringProp(payload, 'cwd');
      out.updatedAt ||= timestampMs(stringProp(payload, 'timestamp')) || timestampMs(stringProp(record, 'timestamp'));
    }
    if (!out.summary) {
      const text = extractCodexMessageText(record);
      if (text && codexRole(record) === 'user') out.summary = cleanSummary(text);
    }
  }
  out.id = idFromFileName('codex', filePath);
  return out;
}

function readClaudeMeta(filePath: string): { id?: string; cwd?: string; summary?: string; updatedAt?: number } {
  const out: { id?: string; cwd?: string; summary?: string; updatedAt?: number } = {};
  for (const record of readJsonlPrefix(filePath, 180)) {
    out.id ||= stringProp(record, 'sessionId');
    out.cwd ||= stringProp(record, 'cwd');
    const ts = timestampMs(stringProp(record, 'timestamp'));
    if (ts) out.updatedAt = Math.max(out.updatedAt || 0, ts);
    if (!out.summary && stringProp(record, 'type') === 'user') {
      const text = extractClaudeMessageText(record);
      if (text && isHumanText(text)) out.summary = cleanSummary(text);
    }
  }
  out.id ||= idFromFileName('claude', filePath);
  return out;
}

function resolveExternalSession(candidates: ExternalSessionCandidate[], input: string): ExternalSessionCandidate {
  const exact = candidates.find((candidate) => candidate.id === input || candidate.filePath === input);
  if (exact) return exact;
  const matches = input.length >= 4 ? candidates.filter((candidate) => candidate.id.startsWith(input)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous ${matches[0].source} session id prefix: ${input}`);
  throw new Error(`No ${candidates[0]?.source ?? 'external'} session found with id: ${input}`);
}

async function pickExternalSession(
  source: ExternalAgentSource,
  candidates: ExternalSessionCandidate[],
  workDir: string,
): Promise<ExternalSessionCandidate | null> {
  const shown = prioritizeByCwd(candidates, workDir).slice(0, 20);
  if (process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === 'function') {
    return pickExternalSessionInteractive(source, shown, candidates, workDir);
  }

  console.error('');
  console.error(chalk.bold(`  Continue from ${source} session:\n`));
  shown.forEach((session, index) => {
    const here = session.cwd && samePath(session.cwd, workDir) ? chalk.green(' ●') : '';
    console.error(
      `  ${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.dim(formatRelative(session.updatedAt).padEnd(8))} ` +
        `${shortDir(session.cwd || '(unknown dir)').padEnd(42)} ${chalk.dim(session.id.slice(0, 12))}${here}`,
    );
    if (session.summary) console.error(chalk.dim(`      ${session.summary}`));
  });
  console.error('');
  console.error(chalk.dim('  Enter a number or session id. Press Enter to cancel.'));
  if (shown.some((session) => session.cwd && samePath(session.cwd, workDir))) {
    console.error(chalk.dim('  ● = matches current directory'));
  }
  console.error('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY ?? false });
  return new Promise((resolve) => {
    rl.question(chalk.bold('  session> '), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) return resolve(null);
      const num = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= shown.length) return resolve(shown[num - 1]);
      try {
        resolve(resolveExternalSession(candidates, trimmed));
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        resolve(null);
      }
    });
  });
}

async function pickExternalSessionInteractive(
  source: ExternalAgentSource,
  shown: ExternalSessionCandidate[],
  candidates: ExternalSessionCandidate[],
  workDir: string,
): Promise<ExternalSessionCandidate | null> {
  const pageSize = 5;
  let selected = 0;
  let offset = 0;

  const render = () => {
    offset = Math.min(offset, Math.max(0, shown.length - pageSize));
    if (selected < offset) offset = selected;
    if (selected >= offset + pageSize) offset = selected - pageSize + 1;

    readline.cursorTo(process.stderr, 0, 0);
    readline.clearScreenDown(process.stderr);
    process.stderr.write('\x1b[?25l');
    process.stderr.write(`\n${chalk.bold(`  Continue from ${source} session`)}\n\n`);
    process.stderr.write(chalk.dim('  ↑/↓ move · Enter select · type number/id then Enter · q/Esc cancel\n'));
    if (shown.some((session) => session.cwd && samePath(session.cwd, workDir))) {
      process.stderr.write(`${chalk.green('  ● Current Dir')} ${chalk.dim('= matches where you ran Franklin')}\n`);
    }
    process.stderr.write('\n');

    const page = shown.slice(offset, offset + pageSize);
    page.forEach((session, pageIndex) => {
      const index = offset + pageIndex;
      const active = index === selected;
      const pointer = active ? chalk.cyan('›') : ' ';
      const num = String(index + 1).padStart(2);
      const here = !!(session.cwd && samePath(session.cwd, workDir));
      const dir = shortDir(session.cwd || '(unknown dir)').padEnd(42);
      const dirText = here ? chalk.green.bold(dir) : dir;
      const hereText = here ? ` ${chalk.green.bold('● Current Dir')}` : '';
      const line = `${pointer} ${num}. ${formatRelative(session.updatedAt).padEnd(8)} ${dirText} ${session.id.slice(0, 12)}${hereText}`;
      process.stderr.write(active ? `${chalk.inverse(line)}\n` : `${line}\n`);
      if (session.summary) {
        const summary = truncate(session.summary, Math.max(60, (process.stderr.columns ?? 120) - 10));
        process.stderr.write(chalk.dim(`      ${summary}\n`));
      }
    });

    if (shown.length > pageSize) {
      process.stderr.write(chalk.dim(`\n  Showing ${offset + 1}-${Math.min(offset + pageSize, shown.length)} of ${shown.length}\n`));
    } else {
      process.stderr.write('\n');
    }
  };

  return new Promise((resolve) => {
    let buffer = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\x1b[?25h');
      readline.cursorTo(process.stderr, 0, 0);
      readline.clearScreenDown(process.stderr);
    };
    const finish = (value: ExternalSessionCandidate | null) => {
      cleanup();
      resolve(value);
    };
    const submitBuffer = () => {
      const trimmed = buffer.trim();
      if (!trimmed) return finish(shown[selected] ?? null);
      const num = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= shown.length) return finish(shown[num - 1]);
      try {
        return finish(resolveExternalSession(candidates, trimmed));
      } catch (err) {
        buffer = '';
        render();
        process.stderr.write(chalk.yellow(`  ${(err as Error).message}\n`));
      }
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString('utf8');
      if (key === '\u0003') {
        cleanup();
        process.kill(process.pid, 'SIGINT');
        return;
      }
      if (key === '\r' || key === '\n') return submitBuffer();
      if (key === '\u001b' || key.toLowerCase() === 'q') return finish(null);
      if (key === '\u001b[A') {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }
      if (key === '\u001b[B') {
        selected = Math.min(shown.length - 1, selected + 1);
        render();
        return;
      }
      if (key === '\u001b[5~') {
        selected = Math.max(0, selected - pageSize);
        render();
        return;
      }
      if (key === '\u001b[6~') {
        selected = Math.min(shown.length - 1, selected + pageSize);
        render();
        return;
      }
      if (key === '\u007f') {
        buffer = buffer.slice(0, -1);
        render();
        if (buffer) process.stderr.write(chalk.dim(`  filter/id: ${buffer}\n`));
        return;
      }
      if (/^[\w./:-]$/.test(key)) {
        buffer += key;
        render();
        process.stderr.write(chalk.dim(`  filter/id: ${buffer}\n`));
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

function prioritizeByCwd(candidates: ExternalSessionCandidate[], workDir: string): ExternalSessionCandidate[] {
  return [...candidates].sort((a, b) => {
    const ah = a.cwd && samePath(a.cwd, workDir) ? 1 : 0;
    const bh = b.cwd && samePath(b.cwd, workDir) ? 1 : 0;
    return bh - ah || b.updatedAt - a.updatedAt;
  });
}

function parseExternalSession(candidate: ExternalSessionCandidate): ParsedExternalSession {
  const messages: ParsedExternalSession['messages'] = [];
  const toolEvents: string[] = [];
  for (const record of readJsonlPrefix(candidate.filePath, 5000)) {
    const role = candidate.source === 'codex' ? codexRole(record) : claudeRole(record);
    const text = candidate.source === 'codex' ? extractCodexMessageText(record) : extractClaudeMessageText(record);
    if (role && text && isHumanText(text)) {
      messages.push({ role, text: truncate(text, MAX_TEXT_CHARS) });
      continue;
    }
    const tool = candidate.source === 'codex' ? extractCodexToolEvent(record) : extractClaudeToolEvent(record);
    if (tool) toolEvents.push(tool);
  }
  return { ...candidate, messages: messages.slice(-MAX_MESSAGES_IN_HANDOFF), toolEvents: toolEvents.slice(-MAX_TOOL_EVENTS_IN_HANDOFF) };
}

function buildHandoffPrompt(session: ParsedExternalSession): string {
  const lines: string[] = [
    'You are Franklin continuing work from another AI coding-agent session.',
    '',
    'This is a new Franklin session. Do not assume you can modify or resume the source agent session file. Use this handoff only as context awareness for what happened before.',
    '',
    '## Source Session',
    `- Agent: ${session.source}`,
    `- Session ID: ${session.id}`,
    `- Original path: ${session.filePath}`,
    `- Working directory: ${session.cwd || '(unknown)'}`,
    `- Last active: ${new Date(session.updatedAt).toLocaleString()}`,
  ];
  if (session.summary) lines.push(`- Summary: ${session.summary}`);
  if (session.toolEvents.length > 0) {
    lines.push('', '## Recent Tool Activity');
    for (const event of session.toolEvents) lines.push(`- ${event}`);
  }
  if (session.messages.length > 0) {
    lines.push('', '## Recent Conversation');
    for (const msg of session.messages) {
      lines.push('', `### ${msg.role}`, msg.text);
    }
  }
  lines.push('', '## Continue From Here', 'Ask the user what they want to do next if the next action is unclear. Otherwise continue the unfinished coding task using Franklin tools in the current workspace.');
  return truncate(lines.join('\n'), MAX_HANDOFF_CHARS);
}

function readJsonlPrefix(filePath: string, maxLines: number): unknown[] {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(Boolean);
  const start = Math.max(0, lines.length - maxLines);
  const out: unknown[] = [];
  for (const line of lines.slice(start)) {
    try { out.push(JSON.parse(line)); } catch { /* skip bad lines */ }
  }
  return out;
}

function codexRole(record: unknown): 'user' | 'assistant' | 'system' | null {
  const role = stringProp(record, 'role');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  const payload = objectProp(record, 'payload');
  const type = stringProp(payload, 'type');
  if (type === 'user_message') return 'user';
  if (type === 'agent_message' || type === 'assistant_message') return 'assistant';
  return null;
}

function claudeRole(record: unknown): 'user' | 'assistant' | 'system' | null {
  const type = stringProp(record, 'type');
  if (type === 'user' || type === 'assistant' || type === 'system') return type;
  const message = objectProp(record, 'message');
  const role = stringProp(message, 'role');
  return role === 'user' || role === 'assistant' || role === 'system' ? role : null;
}

function extractCodexMessageText(record: unknown): string {
  const payload = objectProp(record, 'payload');
  const direct = stringProp(record, 'content') || stringProp(payload, 'message') || stringProp(payload, 'text');
  if (direct) return direct;
  return extractTextFromUnknown(objectProp(record, 'message') || objectProp(payload, 'message'));
}

function extractClaudeMessageText(record: unknown): string {
  const message = objectProp(record, 'message');
  return extractTextFromUnknown(rawProp(message, 'content') ?? rawProp(record, 'content'));
}

function extractCodexToolEvent(record: unknown): string | null {
  const payload = objectProp(record, 'payload');
  const type = stringProp(payload, 'type') || stringProp(record, 'type');
  if (!type || !/(tool|exec|command|patch|call)/i.test(type)) return null;
  const name = stringProp(payload, 'name') || stringProp(record, 'name') || type;
  const command = stringProp(payload, 'command') || stringProp(payload, 'cmd');
  return truncate(command ? `${name}: ${command}` : name, 300);
}

function extractClaudeToolEvent(record: unknown): string | null {
  const message = objectProp(record, 'message');
  const content = rawProp(message, 'content') ?? rawProp(record, 'content');
  if (!Array.isArray(content)) return null;
  const events: string[] = [];
  for (const block of content) {
    const type = stringProp(block, 'type');
    if (type !== 'tool_use' && type !== 'tool_result') continue;
    const name = stringProp(block, 'name') || type;
    const input = objectProp(block, 'input');
    const command = stringProp(input, 'command') || stringProp(input, 'file_path') || stringProp(input, 'path');
    events.push(truncate(command ? `${name}: ${command}` : name, 300));
  }
  return events.length > 0 ? events.join(' · ') : null;
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') return stripMarkup(value).trim();
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part)) {
        if (stringProp(part, 'type') === 'text') return stringProp(part, 'text') || '';
        if (stringProp(part, 'type') === 'input_text') return stringProp(part, 'text') || '';
      }
      return '';
    }).filter(Boolean).join('\n').trim();
  }
  return '';
}

function stripMarkup(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/giu, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/giu, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/giu, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/giu, '')
    .trim();
}

function isHumanText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('<system-reminder>') && !trimmed.startsWith('[Request interrupted');
}

function cleanSummary(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 100);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const prop = value[key];
  return typeof prop === 'string' ? prop : undefined;
}

function objectProp(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const prop = value[key];
  return isRecord(prop) ? prop : undefined;
}

function rawProp(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

function shortDir(dir: string): string {
  const home = os.homedir();
  const clean = dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  return clean.length > 40 ? `…${clean.slice(-39)}` : clean;
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
