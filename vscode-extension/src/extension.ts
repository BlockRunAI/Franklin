import * as vscode from 'vscode';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  runVsCodeSession,
  getVsCodeWelcomeInfo,
  getVsCodeWalletStatus,
  estimateCost,
  listSessions,
  loadSessionHistory,
  loadSessionMeta,
  deleteSession,
  renameSession,
  generateInsights,
  runDoctorChecks,
  saveChain,
  loadChain,
  loadConfig,
  saveConfig,
  getModelsByCategory,
  // Task subsystem (v3.10.0 Detach tool integration) — extension surfaces
  // running / completed background tasks in a Tasks overlay.
  listTasks,
  readTaskMeta,
  readTaskEvents,
  reconcileLostTasks,
  deleteTask,
  pruneCompletedTasks,
  taskLogPath,
  // Session import (v3.10 PR #37) — bring in Claude Code / Codex sessions.
  listExternalSessionCandidates,
  importExternalSessionAsFranklin,
  // Wallet QR — chain-aware payload (EIP-681 / Solana Pay).
  generateWalletQrSvg,
  // Modal GPU sandboxes — list active + bulk-terminate.
  listSessionSandboxes,
  terminateAllSessionSandboxes,
  type StreamEvent,
  type SessionMeta,
  type Dialogue,
  type GatewayModel,
  type TaskRecord,
  type ExternalAgentSource,
} from '@blockrun/franklin/vscode-session';

/** Resolve the working directory: workspace folder if available, else home dir */
function getWorkDir(): { dir: string; hasWorkspace: boolean } {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) return { dir: folder, hasWorkspace: true };
  return { dir: os.homedir(), hasWorkspace: false };
}

/** Inline model shortcuts — synced with src/ui/model-picker.ts MODEL_SHORTCUTS.
 *  When that CLI table changes, mirror the edits here AND in
 *  franklin-desktop/src/host.ts. Three places, same content. */
const MODEL_SHORTCUTS: Record<string, string> = {
  // Routing — eco/premium retired 2026-05-03, kept as aliases for back-compat.
  auto: 'blockrun/auto',
  smart: 'blockrun/auto',
  eco: 'blockrun/auto',
  premium: 'blockrun/auto',
  // Anthropic
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  'sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.7',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  'haiku-4.5': 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI — gpt/gpt5/gpt-5 follow the current flagship (5.5).
  gpt: 'openai/gpt-5.5',
  gpt5: 'openai/gpt-5.5',
  'gpt-5': 'openai/gpt-5.5',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.3': 'openai/gpt-5.3',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-pro': 'openai/gpt-5.2-pro',
  'gpt-4.1': 'openai/gpt-4.1',
  codex: 'openai/gpt-5.3-codex',
  nano: 'openai/gpt-5-nano',
  mini: 'openai/gpt-5-mini',
  o3: 'openai/o3',
  o4: 'openai/o4-mini',
  'o4-mini': 'openai/o4-mini',
  o1: 'openai/o1',
  // Google
  gemini: 'google/gemini-2.5-pro',
  'gemini-2.5': 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  'gemini-3': 'google/gemini-3.1-pro',
  'gemini-3.1': 'google/gemini-3.1-pro',
  // xAI
  grok: 'xai/grok-3',
  'grok-3': 'xai/grok-3',
  'grok-4': 'xai/grok-4-0709',
  'grok-fast': 'xai/grok-4-1-fast-reasoning',
  'grok-4.1': 'xai/grok-4-1-fast-reasoning',
  // DeepSeek — paid V4 Pro / V4 Flash; free tier via nvidia.
  deepseek: 'deepseek/deepseek-chat',
  r1: 'deepseek/deepseek-reasoner',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'dsv4-pro': 'deepseek/deepseek-v4-pro',
  'v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4': 'nvidia/deepseek-v4-flash',
  'deepseek-v4-flash': 'nvidia/deepseek-v4-flash',
  dsv4: 'nvidia/deepseek-v4-flash',
  'deepseek-v3.2': 'nvidia/deepseek-v3.2',
  'deepseek-v3': 'nvidia/deepseek-v3.2',
  // Free fallbacks
  free: 'nvidia/qwen3-coder-480b',
  glm4: 'nvidia/qwen3-coder-480b',
  'deepseek-free': 'nvidia/qwen3-coder-480b',
  'qwen-coder': 'nvidia/qwen3-coder-480b',
  'qwen-think': 'nvidia/qwen3-coder-480b',
  maverick: 'nvidia/llama-4-maverick',
  'gpt-oss': 'nvidia/qwen3-coder-480b',
  'gpt-oss-small': 'nvidia/qwen3-coder-480b',
  'mistral-small': 'nvidia/llama-4-maverick',
  nemotron: 'nvidia/qwen3-coder-480b',
  devstral: 'nvidia/qwen3-coder-480b',
  // Others
  minimax: 'minimax/minimax-m2.7',
  'm2.7': 'minimax/minimax-m2.7',
  glm: 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5-turbo',
  glm5: 'zai/glm-5.1',
  kimi: 'moonshot/kimi-k2.6',
  'k2.6': 'moonshot/kimi-k2.6',
  // K2.5 retired by gateway in favor of K2.6 — aliases stay for muscle memory.
  'kimi-k2.5': 'moonshot/kimi-k2.6',
  'k2.5': 'moonshot/kimi-k2.6',
};
function resolveModel(input: string): string {
  return MODEL_SHORTCUTS[input.trim().toLowerCase()] || input.trim();
}

let latestAbort: (() => void) | undefined;

export const log = vscode.window.createOutputChannel('Franklin');

export function activate(context: vscode.ExtensionContext) {
  log.appendLine('[Franklin] Extension activating…');

  // ── Tell the bundled core where the franklin CLI script actually lives ──
  // Without this, src/tasks/spawn.ts's `import.meta.url` resolves to the
  // bundled extension.cjs (because esbuild inlines spawn.js into the
  // bundle), which produces e.g. <ext>/index.js — a path that doesn't
  // exist. The npm-style file:.. dep means @blockrun/franklin/dist/index.js
  // lives next to the extension's node_modules, so we compute that path
  // here and inject it via the FRANKLIN_CLI_PATH env var (highest-priority
  // strategy in resolveCliPath).
  try {
    const candidates = [
      // Dev / file:.. install: vscode-extension/node_modules/@blockrun/franklin/dist/index.js
      path.resolve(__dirname, '..', 'node_modules', '@blockrun', 'franklin', 'dist', 'index.js'),
      // Packaged VSIX (if/when @blockrun/franklin is bundled as a real dep):
      path.resolve(context.extensionPath, 'node_modules', '@blockrun', 'franklin', 'dist', 'index.js'),
    ];
    for (const p of candidates) {
      try {
        if (fs.statSync(p).isFile()) {
          process.env.FRANKLIN_CLI_PATH = p;
          log.appendLine(`[Franklin] FRANKLIN_CLI_PATH = ${p}`);
          break;
        }
      } catch { /* try next */ }
    }
    if (!process.env.FRANKLIN_CLI_PATH) {
      log.appendLine(
        `[Franklin] WARNING: could not locate franklin/dist/index.js next to extension. ` +
        `Detached tasks will fall back to spawn.ts heuristics.`
      );
    }
  } catch (e) {
    log.appendLine(`[Franklin] FRANKLIN_CLI_PATH probe error: ${(e as Error).message}`);
  }

  // Silent housekeeping: drop terminal background tasks older than 7 days
  // so ~/.franklin/tasks doesn't grow unbounded for users who never open
  // the Tasks panel. Manual prune button uses a tighter 24h threshold.
  // Best-effort — never blocks activation.
  try {
    const result = pruneCompletedTasks(7 * 24 * 60 * 60 * 1000);
    if (result.deleted > 0) {
      log.appendLine(`[Franklin] Auto-pruned ${result.deleted} terminal task(s) older than 7 days.`);
    }
  } catch { /* ignore */ }

  const provider = new FranklinChatProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FranklinChatProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('franklin.stopGeneration', () => {
      latestAbort?.();
    })
  );

  // ── Status Bar ──
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(sparkle) Franklin';
  statusItem.tooltip = 'Open Franklin Chat';
  statusItem.command = 'franklin.chatPanel.focus';
  statusItem.show();
  context.subscriptions.push(statusItem);

  // ── Open in New Tab ──
  context.subscriptions.push(
    vscode.commands.registerCommand('franklin.openInNewTab', () => {
      const panel = vscode.window.createWebviewPanel(
        'franklin.chatTab',
        'Franklin Chat',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const tabProvider = new FranklinChatProvider(context.extensionUri);
      tabProvider.resolveWebviewPanel(panel);
    })
  );

  // ── History ──
  context.subscriptions.push(
    vscode.commands.registerCommand('franklin.refreshHistory', () => {
      provider.sendHistoryList();
    })
  );
}

export function deactivate() {
  latestAbort = undefined;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSessionTitle(m: SessionMeta): string {
  // User-assigned title (via the rename button) wins over the auto-derived one.
  if (m.title && m.title.trim().length > 0) return m.title;
  // Try to get first user message as title
  try {
    const history = loadSessionHistory(m.id);
    for (const d of history) {
      if (d.role === 'user') {
        const text = typeof d.content === 'string'
          ? d.content
          : Array.isArray(d.content)
            ? d.content
                .filter((p): p is { type: 'text'; text: string } => (p as unknown as Record<string, unknown>).type === 'text')
                .map(p => p.text).join(' ')
            : '';
        if (text) return text.length > 40 ? text.slice(0, 40) + '...' : text;
      }
    }
  } catch { /* fall through */ }
  return m.workDir ? m.workDir.split('/').pop() || m.id.slice(0, 8) : m.id.slice(0, 8);
}

function getHistoryList(): { id: string; title: string; ago: string; model: string; turns: number }[] {
  try {
    const sessions = listSessions().filter(s => s.turnCount > 0 && s.messageCount > 0).slice(0, 20);
    const result: { id: string; title: string; ago: string; model: string; turns: number }[] = [];
    for (const m of sessions) {
      try {
        result.push({
          id: m.id,
          title: getSessionTitle(m),
          ago: formatTimeAgo(m.updatedAt),
          model: m.model.split('/').pop() || m.model,
          turns: m.turnCount,
        });
      } catch {
        result.push({
          id: m.id,
          title: m.id.slice(0, 8),
          ago: formatTimeAgo(m.updatedAt),
          model: m.model.split('/').pop() || m.model,
          turns: m.turnCount,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

class FranklinChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'franklin.chatPanel';

  private webview?: vscode.Webview;
  private resolveInput?: (value: string | null) => void;
  private resolveAskUser?: (value: string) => void;
  private agentRunning = false;
  /** Set by startNewSession() so the next runAgentSession skips auto-resume. */
  private forceFreshSession = false;
  /**
   * Set by resumeExistingSession() — overrides the auto-resume logic in
   * runAgentSession() so we restart the loop pointed at a specific
   * sessionId (the one the user just clicked in the history list).
   * Without this the webview shows the old transcript but the agent
   * keeps running against whatever session it auto-resumed at panel
   * open, so the model "forgets" everything visible on screen.
   */
  private pendingResumeSessionId: string | null = null;
  /**
   * Monotonic generation counter — incremented every time a new agent
   * session is started (panel open or "+ new chat"). Embedded in every
   * event posted to the webview so late-arriving events from a now-aborted
   * loop can be silently discarded by the webview instead of bleeding
   * into the new chat. Without this guard, mid-stream tool_use / text
   * events from the old loop paint old content into the freshly cleared
   * UI right after the user clicks "+".
   */
  private sessionGen = 0;
  private walletRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private agentConfig?: { model: string; baseModel?: string };

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Called when sidebar view is created */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.initWebview(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.cleanup();
    });

    void this.pushWelcome();
    this.sendHistoryList();
    this.sendLastSession();
    void this.runAgentSession();
  }

  /** Called when opening in a new editor tab */
  resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    this.initWebview(panel.webview);

    panel.onDidDispose(() => {
      this.cleanup();
    });

    void this.pushWelcome();
    void this.runAgentSession();
  }

  /** Send the history list to the webview */
  sendHistoryList(): void {
    const items = getHistoryList();
    void this.webview?.postMessage({ type: 'historyList', items });
  }

  /** Send the most-recent session for auto-resume banner */
  sendLastSession(): void {
    try {
      const sessions = listSessions().filter(s => s.turnCount > 0 && s.messageCount > 0);
      if (sessions.length === 0) return;
      const last = sessions[0];
      const title = getSessionTitle(last);
      void this.webview?.postMessage({
        type: 'lastSession',
        session: {
          id: last.id,
          title,
          ago: formatTimeAgo(last.updatedAt),
          model: last.model.split('/').pop() || last.model,
        },
      });
    } catch { /* ignore */ }
  }

  /** Run doctor checks and push results to webview */
  /**
   * Detect ImageGen / VideoGen output and send the generated file to the
   * webview so it can show an inline preview. Matches the output format
   * from src/tools/imagegen.ts and src/tools/videogen.ts.
   */
  private maybeSendMediaPreview(output: string): void {
    if (!this.webview) return;
    const match = output.match(/^(Image|Video) saved to (\S+?\.(?:png|jpg|jpeg|webp|gif|mp4|webm|mov))/i);
    if (!match) return;
    const kind = match[1].toLowerCase() === 'video' ? 'video' : 'image';
    const filePath = match[2];
    try {
      const fileUri = vscode.Uri.file(filePath);
      const webviewUri = this.webview.asWebviewUri(fileUri).toString();
      void this.webview.postMessage({ type: 'mediaPreview', kind, path: filePath, src: webviewUri });
    } catch {
      /* path not previewable — skip silently */
    }
  }

  /**
   * Snapshots of pre-edit file contents, keyed by absolute path. Kept in
   * memory only — used when the user clicks "Revert" on an edit diff card.
   * Stores the exact bytes before the Edit tool touched the file, so Revert
   * restores the file to its pre-edit state even if the user already kept
   * working and has unsaved changes in the editor.
   */
  private editSnapshots = new Map<string, string>();

  /**
   * When Edit / Write / MultiEdit returns a structured diff, push a compact
   * diff preview card to the webview so the user can see exactly what
   * changed and optionally revert. Side-effect: stash the old content in
   * memory for Revert.
   */
  private maybeSendEditDiff(result: { diff?: { file: string; oldLines: string[]; newLines: string[]; count: number }; output: string }): void {
    if (!this.webview || !result.diff) return;
    const { file, oldLines, newLines, count } = result.diff;
    // Stash the pre-edit content so Revert can write it back even if the
    // user keeps editing in the meantime.
    this.editSnapshots.set(file, oldLines.join('\n'));
    void this.webview.postMessage({
      type: 'editDiff',
      file,
      oldLines,
      newLines,
      count,
    });
  }

  private openFile(filePath: string): void {
    try {
      const uri = vscode.Uri.file(filePath);
      void vscode.window.showTextDocument(uri, { preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage(`Franklin: Cannot open ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private revertEdit(filePath: string): void {
    const snap = this.editSnapshots.get(filePath);
    if (snap === undefined) {
      void vscode.window.showWarningMessage(`Franklin: No snapshot available for ${filePath}. The file may have been edited again after the original change.`);
      return;
    }
    try {
      fs.writeFileSync(filePath, snap, 'utf-8');
      this.editSnapshots.delete(filePath);
      void this.webview?.postMessage({ type: 'editReverted', file: filePath });
      void vscode.window.showInformationMessage(`Franklin: Reverted ${path.basename(filePath)}`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Franklin: Failed to revert ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runDoctor(): Promise<void> {
    try {
      const allChecks = await runDoctorChecks();
      // Drop the Franklin core version check — it reads the extension's
      // package.json by mistake (bundled __dirname) and compares to the
      // npm-published core version, which is apples-to-oranges. Extension
      // users upgrade via the VS Code Marketplace, not npm.
      const checks = allChecks.filter(c => c.name !== 'Franklin');
      void this.webview?.postMessage({ type: 'doctorResults', checks });
    } catch (e) {
      void this.webview?.postMessage({ type: 'doctorResults', checks: [], error: String(e) });
    }
  }

  /** Find an executable by searching process.env.PATH + platform-specific locations */
  private findBin(name: string): string | null {
    const isWin = process.platform === 'win32';
    const extraDirs = isWin
      ? [
          path.join(process.env.APPDATA || '', 'npm'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
        ]
      : [
          '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin',
          path.join(os.homedir(), '.nvm', 'current', 'bin'),
        ];
    const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraDirs];
    const candidates = isWin ? [name + '.cmd', name + '.exe', name] : [name];
    for (const dir of dirs) {
      if (!dir) continue;
      for (const candidate of candidates) {
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  }

  /** Auto-launch franklin panel and open browser */
  private async openTradingDashboard(): Promise<void> {
    const PORT = 3100;
    const url = `http://localhost:${PORT}`;

    if (await this.isPortOpen(PORT)) {
      void vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    void vscode.window.showInformationMessage('Franklin: Starting panel…');

    // Strategy: prefer local dist/index.js (dev mode) with real node, else global franklin CLI
    const localDist = path.join(this.extensionUri.fsPath, '..', 'dist', 'index.js');
    const hasLocal = fs.existsSync(localDist);
    const nodeBin = this.findBin('node');
    const franklinBin = this.findBin('franklin');

    let cmd: string, args: string[];
    if (hasLocal && nodeBin) {
      cmd = nodeBin; args = [localDist, 'panel', '--port', String(PORT)];
    } else if (franklinBin) {
      cmd = franklinBin; args = ['panel', '--port', String(PORT)];
    } else {
      void vscode.window.showErrorMessage("Franklin: Cannot find 'node' or 'franklin'. Run: npm i -g @blockrun/franklin");
      return;
    }

    const proc = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });

    let spawnError = '';
    proc.stderr?.on('data', (d: unknown) => { spawnError += String(d); });
    proc.on('error', (err: Error) => {
      void vscode.window.showErrorMessage(`Franklin: Failed to start panel — ${err.message}`);
    });

    const ready = await this.waitForPort(PORT, 10000);
    proc.unref();
    if (!ready) {
      const detail = spawnError.trim() ? spawnError.trim().slice(0, 150) : "Run `franklin panel` in terminal to debug.";
      void vscode.window.showErrorMessage(`Franklin: Panel failed to start — ${detail}`);
    }
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(300, () => { s.destroy(); resolve(false); });
    });
  }

  private waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        void this.isPortOpen(port).then((open) => {
          if (open) { resolve(true); return; }
          if (Date.now() >= deadline) { resolve(false); return; }
          setTimeout(poll, 600);
        });
      };
      setTimeout(poll, 1000);
    });
  }

  /** Generate usage insights and push to webview */
  private sendInsights(): void {
    try {
      const data = generateInsights(30);
      void this.webview?.postMessage({ type: 'insightsData', data });
    } catch (e) {
      void this.webview?.postMessage({ type: 'insightsData', error: String(e) });
    }
  }

  /** Pull task list (with zombie reconciliation) and push to webview. */
  private sendTasks(): void {
    try {
      try { reconcileLostTasks(); } catch { /* best-effort */ }
      const tasks = listTasks();
      // Trim payload — only the fields the panel needs. Avoids shipping
      // command strings (can be huge) to the webview on every refresh.
      const slim = tasks.map((t: TaskRecord) => ({
        runId: t.runId,
        label: t.label,
        status: t.status,
        runtime: t.runtime,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        exitCode: t.exitCode,
        progressSummary: t.progressSummary,
        terminalSummary: t.terminalSummary,
        error: t.error,
        // Truncate command preview at 120 chars — full command available on
        // demand via tail-log if user wants more detail.
        command: t.command.length > 120 ? t.command.slice(0, 120) + '…' : t.command,
        pid: t.pid,
      }));
      void this.webview?.postMessage({ type: 'tasksData', tasks: slim });
    } catch (e) {
      void this.webview?.postMessage({ type: 'tasksData', tasks: [], error: String(e) });
    }
  }

  /** Tail a task's log file and push the (possibly truncated) tail to the panel. */
  private sendTaskLog(runId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return;
    try {
      const meta = readTaskMeta(runId);
      const logPath = taskLogPath(runId);
      let content = '';
      try {
        const raw = fs.readFileSync(logPath, 'utf-8');
        // Tail to last ~12KB so a giant log doesn't blow up the webview.
        const TAIL_BYTES = 12_000;
        content = raw.length > TAIL_BYTES
          ? '… (truncated head — showing last ' + (TAIL_BYTES / 1000).toFixed(0) + 'KB) …\n' + raw.slice(-TAIL_BYTES)
          : raw;
      } catch {
        content = '(no log output yet)';
      }
      const events = readTaskEvents(runId).slice(-20);
      void this.webview?.postMessage({ type: 'taskLogData', runId, meta, log: content, events });
    } catch (e) {
      void this.webview?.postMessage({ type: 'taskLogData', runId, error: String(e) });
    }
  }

  /** Cancel a task by SIGTERM-ing its pid; runner writes the cancelled event itself. */
  private cancelTask(runId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return;
    try {
      const meta = readTaskMeta(runId);
      if (!meta) {
        void this.webview?.postMessage({ type: 'taskCancelResult', runId, ok: false, reason: 'not found' });
        return;
      }
      if (typeof meta.pid !== 'number') {
        void this.webview?.postMessage({ type: 'taskCancelResult', runId, ok: false, reason: 'no pid recorded' });
        return;
      }
      try {
        process.kill(meta.pid, 'SIGTERM');
        void this.webview?.postMessage({ type: 'taskCancelResult', runId, ok: true });
      } catch (err) {
        void this.webview?.postMessage({ type: 'taskCancelResult', runId, ok: false, reason: (err as Error).message });
      }
    } catch (e) {
      void this.webview?.postMessage({ type: 'taskCancelResult', runId, ok: false, reason: String(e) });
    }
  }

  /** Permanently delete a single task (only allowed when terminal). */
  private deleteOneTask(runId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) return;
    try {
      const result = deleteTask(runId);
      void this.webview?.postMessage({
        type: 'taskDeleteResult', runId, ok: result.ok, reason: result.reason,
      });
      this.sendTasks();
    } catch (e) {
      void this.webview?.postMessage({
        type: 'taskDeleteResult', runId, ok: false, reason: String(e),
      });
    }
  }

  /** Bulk-prune terminal tasks older than 24 hours. */
  private pruneOldTasks(): void {
    try {
      const result = pruneCompletedTasks();
      void this.webview?.postMessage({
        type: 'tasksPruneResult', deleted: result.deleted, skipped: result.skipped,
      });
      this.sendTasks();
    } catch (e) {
      void this.webview?.postMessage({ type: 'tasksPruneResult', error: String(e) });
    }
  }

  /** Generate and push the wallet QR (chain-aware payload). */
  private async sendWalletQr(): Promise<void> {
    try {
      const { dir } = getWorkDir();
      const w = await getVsCodeWalletStatus(dir);
      if (!w.walletAddress) {
        void this.webview?.postMessage({ type: 'walletQrData', error: 'No wallet found yet. Run `franklin setup` first.' });
        return;
      }
      const chain: 'base' | 'solana' = w.chain === 'solana' ? 'solana' : 'base';
      const result = await generateWalletQrSvg(w.walletAddress, chain);
      void this.webview?.postMessage({
        type: 'walletQrData',
        svg: result.svg,
        payload: result.payload,
        address: w.walletAddress,
        chain,
      });
    } catch (e) {
      void this.webview?.postMessage({ type: 'walletQrData', error: String(e) });
    }
  }

  /** Push current Modal GPU sandbox list to webview (badge + overlay). */
  private sendSandboxes(): void {
    try {
      const sandboxes = listSessionSandboxes();
      void this.webview?.postMessage({ type: 'sandboxesData', sandboxes });
    } catch (e) {
      void this.webview?.postMessage({ type: 'sandboxesData', sandboxes: [], error: String(e) });
    }
  }

  /** Bulk-terminate every tracked sandbox (called from the overlay's "kill all" button). */
  private async cleanupSandboxes(): Promise<void> {
    try {
      const result = await terminateAllSessionSandboxes();
      void this.webview?.postMessage({
        type: 'sandboxesCleanup',
        attempted: result.attempted,
        succeeded: result.succeeded,
        failed: result.failed,
      });
      this.sendSandboxes();
    } catch (e) {
      void this.webview?.postMessage({ type: 'sandboxesCleanup', error: String(e) });
    }
  }

  /** List importable external sessions (Claude Code or Codex). */
  private sendImportCandidates(source: ExternalAgentSource): void {
    try {
      const candidates = listExternalSessionCandidates(source).slice(0, 25);
      void this.webview?.postMessage({ type: 'importCandidates', source, candidates });
    } catch (e) {
      void this.webview?.postMessage({ type: 'importCandidates', source, candidates: [], error: String(e) });
    }
  }

  /**
   * Import a Claude Code / Codex session as a new Franklin session, then
   * load it in the chat view so the user can keep going from where they
   * left off in the other tool.
   */
  private async importSession(source: ExternalAgentSource, externalId: string): Promise<void> {
    if (!externalId || externalId.length > 200) return;
    const { dir } = getWorkDir();
    try {
      const config = loadConfig();
      const model = config['default-model'] || 'blockrun/auto';
      const result = await importExternalSessionAsFranklin(source, externalId, { model, workDir: dir });
      void this.webview?.postMessage({ type: 'importDone', sessionId: result.sessionId });
      // Auto-load the imported session into the chat view.
      const history = loadSessionHistory(result.sessionId);
      if (history.length > 0) {
        const summary = result.imported.summary || `${source} session ${result.imported.id.slice(0, 8)}`;
        this.loadHistory(history, summary.slice(0, 40));
      }
    } catch (e) {
      void this.webview?.postMessage({ type: 'importDone', error: String(e) });
    }
  }

  /** Load a historical session into the chat view */
  loadHistory(dialogues: Dialogue[], title?: string): void {
    if (!this.webview) return;
    // Build a richer message list than just role+text — preserve any
    // image / video paths that were generated mid-conversation so the
    // webview can re-render them as inline preview cards (instead of
    // silently dropping them on history replay). Same for the agent's
    // textual tool_result summary so the user can see which tools were
    // called per turn.
    type HistoryItem = {
      role: string;
      text: string;
      mediaPaths?: { kind: 'image' | 'video'; path: string }[];
    };
    const messages: HistoryItem[] = [];
    for (const d of dialogues) {
      let text = '';
      const mediaPaths: HistoryItem['mediaPaths'] = [];

      if (typeof d.content === 'string') {
        text = d.content;
      } else if (Array.isArray(d.content)) {
        const textParts: string[] = [];
        for (const p of d.content as unknown as Array<Record<string, unknown>>) {
          if (p.type === 'text' && typeof p.text === 'string') {
            textParts.push(p.text);
          } else if (p.type === 'tool_result') {
            // tool_result.content can be a string or an array of blocks.
            const tc = p.content;
            const tcText = typeof tc === 'string'
              ? tc
              : Array.isArray(tc)
                ? (tc as Array<Record<string, unknown>>)
                    .filter(b => b.type === 'text' && typeof b.text === 'string')
                    .map(b => b.text as string).join('\n')
                : '';
            // Detect ImageGen / VideoGen save lines so we can re-render
            // the media inline. Same regex used by maybeSendMediaPreview.
            const m = tcText.match(/^(Image|Video) saved to (\S+?\.(?:png|jpg|jpeg|webp|gif|mp4|webm|mov))/im);
            if (m) {
              const kind = m[1].toLowerCase() === 'video' ? 'video' : 'image';
              mediaPaths.push({ kind, path: m[2] });
            }
          }
          // Skip tool_use, thinking, image, etc. — too noisy to replay
          // verbatim, and generated media is already captured above.
        }
        text = textParts.join('\n');
      }

      if (text || (mediaPaths && mediaPaths.length > 0)) {
        const item: HistoryItem = { role: d.role, text };
        if (mediaPaths.length > 0) {
          // Convert local paths to webview-safe URIs so <img>/<video>
          // can actually load them.
          item.mediaPaths = mediaPaths;
        }
        messages.push(item);
      }
    }

    // Resolve webview URIs for any media paths so the webview JS can use
    // them directly (it can't call asWebviewUri itself).
    const enriched = messages.map(m => {
      if (!m.mediaPaths) return m;
      const resolved = m.mediaPaths.map(({ kind, path: p }) => {
        try {
          const uri = vscode.Uri.file(p);
          const src = this.webview!.asWebviewUri(uri).toString();
          return { kind, path: p, src };
        } catch {
          return { kind, path: p, src: '' };
        }
      }).filter(x => x.src);
      return { ...m, mediaPaths: resolved };
    });

    void this.webview.postMessage({ type: 'loadHistory', messages: enriched, title: title || 'History' });
  }

  private initWebview(webview: vscode.Webview): void {
    this.webview = webview;

    const workspaceFolders = vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [];
    webview.options = {
      enableScripts: true,
      // Allow webview to load images/videos from the extension dir AND any open workspace folder,
      // so ImageGen / VideoGen outputs saved into the workspace can be previewed inline.
      localResourceRoots: [this.extensionUri, ...workspaceFolders],
    };

    webview.html = getWebviewHtml(webview, this.extensionUri);

    webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(msg);
    });
  }

  private cleanup(): void {
    if (this.walletRefreshTimer) {
      clearTimeout(this.walletRefreshTimer);
      this.walletRefreshTimer = undefined;
    }
    this.finishInput(null);
    const askR = this.resolveAskUser;
    this.resolveAskUser = undefined;
    askR?.('');
  }

  /**
   * Persist a base64 data URL (image/png|jpeg|gif|webp) to a temp file and
   * return its absolute path. Used by the image-attachment bridge: webview
   * collects images, sends them via postMessage as data URLs, we drop them
   * to disk, and the agent's existing Read tool picks up the path and
   * forwards the bytes to vision-capable models. Returns null on any error
   * (oversized, malformed mime, write failure) so the caller skips that
   * image without aborting the whole turn.
   */
  private async saveImageDataUrlToTemp(dataURL: string, hintName?: string): Promise<string | null> {
    try {
      const m = dataURL.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i);
      if (!m) return null;
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const buf = Buffer.from(m[2], 'base64');
      // Mirror src/tools/read.ts IMAGE_MAX_BYTES (10 MB). Bigger payloads
      // would also blow past LLM provider request size caps anyway.
      if (buf.length > 10 * 1024 * 1024) return null;
      const dir = path.join(os.tmpdir(), 'franklin-vscode-images');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
      // Sanitize hintName (drop directory parts, restrict charset) so a
      // malicious clipboard payload can't escape the temp dir or land
      // weird characters in the path.
      const safeBase = (hintName ?? 'pasted')
        .replace(/.*[\\/]/, '')
        .replace(/\.[^.]*$/, '')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 40) || 'pasted';
      const stamp = Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
      const file = path.join(dir, `${safeBase}-${stamp}.${ext}`);
      fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      log.appendLine(`[saveImageDataUrlToTemp] error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async pushWelcome() {
    const { dir, hasWorkspace } = getWorkDir();
    log.appendLine(`[pushWelcome] workDir=${dir}`);
    void this.webview?.postMessage({ type: 'loadingStep', text: 'Resolving workspace…' });
    try {
      void this.webview?.postMessage({ type: 'loadingStep', text: 'Loading wallet & model…' });
      log.appendLine('[pushWelcome] calling getVsCodeWelcomeInfo…');
      const info = await getVsCodeWelcomeInfo(dir);
      log.appendLine(`[pushWelcome] got info: model=${info.model} chain=${info.chain} balance=${info.balance}`);
      void this.webview?.postMessage({ type: 'welcome', info, hasWorkspace });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.appendLine(`[pushWelcome] ERROR: ${err}`);
      void this.webview?.postMessage({ type: 'welcomeError', message: err });
    }
  }

  private finishInput(value: string | null) {
    const r = this.resolveInput;
    this.resolveInput = undefined;
    r?.(value);
  }

  private postEvent(ev: StreamEvent) {
    void this.webview?.postMessage({ type: 'event', event: ev, gen: this.sessionGen });
  }

  private async handleSwitchChain() {
    const current = loadChain();
    const next = current === 'base' ? 'solana' : 'base';
    saveChain(next);
    void vscode.window.showInformationMessage(`Franklin: Switched to ${next}`);
    await this.refreshWalletStatus();
  }

  /** Gather current settings + gateway catalog and push to the webview's settings popover. */
  private async sendSettings(): Promise<void> {
    const config = loadConfig();
    let chain: 'base' | 'solana' = 'base';
    try { chain = loadChain(); } catch { /* default */ }

    let imageModels: GatewayModel[] = [];
    let videoModels: GatewayModel[] = [];
    try {
      imageModels = await getModelsByCategory('image');
      videoModels = await getModelsByCategory('video');
      log.appendLine(`[settings] gateway catalog: ${imageModels.length} image, ${videoModels.length} video models`);
    } catch (err) {
      log.appendLine(`[settings] gateway fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const toOption = (m: GatewayModel) => {
      const p = (m.pricing as unknown as Record<string, number> | undefined) ?? {};
      const price = p.per_image != null
        ? `$${p.per_image}/img`
        : p.per_second != null
          ? `$${p.per_second}/s`
          : '';
      return { id: m.id, label: price ? `${m.id} — ${price}` : m.id };
    };

    void this.webview?.postMessage({
      type: 'settingsData',
      current: {
        chain,
        'default-image-model': config['default-image-model'] ?? null,
        'default-video-model': config['default-video-model'] ?? null,
        // max-turn-spend-usd was removed in core v3.11.0 — wallet balance
        // is now the ceiling. Field intentionally absent here.
      },
      imageModels: imageModels.map(toOption),
      videoModels: videoModels.map(toOption),
    });
  }

  /** Persist the chain + media-model defaults from the settings popover. */
  private async applySettings(settings: Record<string, string | undefined>): Promise<void> {
    // Chain
    if (settings.chain === 'base' || settings.chain === 'solana') {
      const current = (() => { try { return loadChain(); } catch { return 'base' as const; } })();
      if (current !== settings.chain) {
        saveChain(settings.chain);
        await this.refreshWalletStatus();
      }
    }
    // Media defaults — empty string / '__unset__' means "clear it".
    const config = loadConfig();
    const img = settings['default-image-model'];
    const vid = settings['default-video-model'];
    if (img && img !== '__unset__') config['default-image-model'] = img;
    else delete config['default-image-model'];
    if (vid && vid !== '__unset__') config['default-video-model'] = vid;
    else delete config['default-video-model'];
    // Defensively strip the legacy max-turn-spend-usd from any old config
    // file written by a pre-v3.11.0 build. Without this, a stale value
    // hangs around in franklin-config.json forever even though core no
    // longer reads it.
    if ('max-turn-spend-usd' in (config as Record<string, unknown>)) {
      delete (config as Record<string, unknown>)['max-turn-spend-usd'];
    }
    // Strip stale batch-concurrency from old configs (parallel media gen
    // is deferred to feature/parallel-media-gen branch and not in this
    // build).
    if ('batch-concurrency' in (config as Record<string, unknown>)) {
      delete (config as Record<string, unknown>)['batch-concurrency'];
    }
    saveConfig(config);
    void this.webview?.postMessage({ type: 'settingsSaved' });
  }

  private async refreshWalletStatus() {
    const { dir } = getWorkDir();
    if (!this.webview) return;
    try {
      const w = await getVsCodeWalletStatus(dir);
      void this.webview.postMessage({
        type: 'status',
        partial: {
          balance: w.balance,
          walletAddress: w.walletAddress || '—',
          chain: w.chain,
        },
      });
    } catch {
      /* ignore */
    }
  }

  private scheduleWalletRefresh() {
    if (this.walletRefreshTimer) {
      clearTimeout(this.walletRefreshTimer);
    }
    this.walletRefreshTimer = setTimeout(() => {
      this.walletRefreshTimer = undefined;
      void this.refreshWalletStatus();
    }, 400);
  }

  private async handleMessage(msg: { type?: string; text?: string; settings?: unknown; images?: Array<{ dataURL?: string; name?: string }> }) {
    if (msg.type === 'send' && typeof msg.text === 'string') {
      const t = msg.text.trim();
      // Save any attached images to disk first, then prepend their paths to
      // the user prompt. The agent's Read tool detects the file extensions
      // and loads them as vision content for vision-capable models. We
      // don't need to touch the agent loop or Read tool — the bridge IS
      // the temp-file path written here.
      const imgs = Array.isArray(msg.images) ? msg.images : [];
      const tempPaths: string[] = [];
      for (const img of imgs) {
        if (!img || typeof img.dataURL !== 'string') continue;
        const p = await this.saveImageDataUrlToTemp(img.dataURL, img.name);
        if (p) tempPaths.push(p);
      }
      // Schedule cleanup AFTER agent has had time to read. 5 minutes is
      // generous (covers slow Read on big PNGs, slow LLM, multi-tool
      // chains). If the user really hits Send 60+ times in 5 min the
      // worst case is some pending unlinks pile up — small price.
      if (tempPaths.length > 0) {
        setTimeout(() => {
          for (const p of tempPaths) {
            try { fs.unlinkSync(p); } catch { /* already gone or in use */ }
          }
        }, 5 * 60_000);
      }
      let enriched = t;
      if (tempPaths.length > 0) {
        const list = tempPaths.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
        // STRONG instruction: models (especially fast ones) tend to skip
        // Read and guess from filenames. Make refusal-to-Read explicitly
        // unacceptable. Paths are temp files — the filename is meaningless
        // (it's just an upload stamp), only the bytes matter.
        const intro = [
          `[USER ATTACHED ${tempPaths.length} IMAGE${tempPaths.length === 1 ? '' : 'S'} — YOU MUST READ THEM]`,
          `Paths:`,
          list,
          ``,
          `MANDATORY: call the Read tool on EACH path above before responding.`,
          `The path filename is a meaningless upload stamp — it tells you NOTHING about content.`,
          `You CANNOT see the image without calling Read. Do NOT guess. Do NOT skip. Do NOT compare to "previous similar images" — each upload is independent.`,
        ].join('\n');
        enriched = t ? `${intro}\n\nUser question after reading: ${t}` : intro;
      }
      if (!enriched) return;  // truly nothing
      this.finishInput(enriched);
      return;
    }
    if (msg.type === 'askUserReply' && typeof msg.text === 'string') {
      const r = this.resolveAskUser;
      this.resolveAskUser = undefined;
      r?.(msg.text);
      return;
    }
    if (msg.type === 'stop') {
      const hadAbort = latestAbort != null;
      latestAbort?.();
      void this.webview?.postMessage({ type: 'stopAck', hadAbort });
    }
    if (msg.type === 'newSession') {
      void this.startNewSession();
    }
    if (msg.type === 'switchModel' && msg.text) {
      const newModel = resolveModel(msg.text);
      if (this.agentConfig) {
        this.agentConfig.model = newModel;
        this.agentConfig.baseModel = newModel;
        void this.webview?.postMessage({
          type: 'event',
          event: { kind: 'status_update', model: newModel },
        });
      }
    }
    if (msg.type === 'switchChain') {
      void this.handleSwitchChain();
    }
    if (msg.type === 'loadSettings') {
      void this.sendSettings();
    }
    if (msg.type === 'openFile' && typeof msg.text === 'string') {
      this.openFile(msg.text);
    }
    if (msg.type === 'openExternal' && typeof msg.text === 'string') {
      try {
        void vscode.env.openExternal(vscode.Uri.file(msg.text));
      } catch (err) {
        void vscode.window.showErrorMessage(`Franklin: Cannot open ${msg.text}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (msg.type === 'revertEdit' && typeof msg.text === 'string') {
      this.revertEdit(msg.text);
    }
    if (msg.type === 'saveSettings' && msg.settings && typeof msg.settings === 'object') {
      await this.applySettings(msg.settings as Record<string, string | undefined>);
    }
    if (msg.type === 'requestHistory') {
      this.sendHistoryList();
    }
    if (msg.type === 'deleteSession' && typeof msg.text === 'string') {
      const id = msg.text;
      if (/^[a-zA-Z0-9_-]+$/.test(id)) {
        try {
          const removed = deleteSession(id);
          void this.webview?.postMessage({ type: 'sessionDeleted', id, ok: removed });
        } catch (e) {
          void this.webview?.postMessage({ type: 'sessionDeleted', id, ok: false, error: String(e) });
        }
        // Push a fresh history list so the row vanishes immediately.
        this.sendHistoryList();
      }
    }
    if (msg.type === 'renameSession' && msg.settings && typeof msg.settings === 'object') {
      const s = msg.settings as { id?: string; title?: string };
      if (typeof s.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(s.id)) {
        try {
          renameSession(s.id, s.title);
          void this.webview?.postMessage({ type: 'sessionRenamed', id: s.id, ok: true });
        } catch (e) {
          void this.webview?.postMessage({ type: 'sessionRenamed', id: s.id, ok: false, error: String(e) });
        }
        this.sendHistoryList();
      }
    }
    if (msg.type === 'runDoctor') {
      void this.runDoctor();
    }
    if (msg.type === 'loadInsights') {
      this.sendInsights();
    }
    if (msg.type === 'loadTasks') {
      this.sendTasks();
    }
    if (msg.type === 'tailTaskLog' && typeof msg.text === 'string') {
      this.sendTaskLog(msg.text);
    }
    if (msg.type === 'cancelTask' && typeof msg.text === 'string') {
      this.cancelTask(msg.text);
    }
    if (msg.type === 'deleteTask' && typeof msg.text === 'string') {
      this.deleteOneTask(msg.text);
    }
    if (msg.type === 'pruneOldTasks') {
      this.pruneOldTasks();
    }
    if (msg.type === 'loadWalletQr') {
      void this.sendWalletQr();
    }
    if (msg.type === 'loadSandboxes') {
      this.sendSandboxes();
    }
    if (msg.type === 'cleanupSandboxes') {
      void this.cleanupSandboxes();
    }
    if (msg.type === 'listImportCandidates' && typeof msg.text === 'string') {
      const src = msg.text === 'claude' || msg.text === 'codex' ? msg.text : null;
      if (src) this.sendImportCandidates(src);
    }
    if (msg.type === 'importSession' && msg.settings && typeof msg.settings === 'object') {
      const s = msg.settings as { source?: string; id?: string };
      const src = s.source === 'claude' || s.source === 'codex' ? s.source : null;
      if (src && typeof s.id === 'string') void this.importSession(src, s.id);
    }
    if (msg.type === 'openTrading') {
      void this.openTradingDashboard();
    }
    if (msg.type === 'loadSession' && msg.text) {
      const sessionId = msg.text;
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) { return; }
      const history = loadSessionHistory(sessionId);
      if (history.length > 0) {
        // Find title from first user message
        let title = msg.text.slice(0, 8);
        for (const d of history) {
          if (d.role === 'user') {
            const text = typeof d.content === 'string' ? d.content : '';
            if (text) { title = text.length > 30 ? text.slice(0, 30) + '...' : text; break; }
          }
        }
        this.loadHistory(history, title);
        // NOTE: we previously seeded the ring with meta.inputTokens here,
        // but that field is the cumulative sum of every turn's input
        // (loop.ts:sessionInputTokens), not the current context size.
        // With the webview's fixed "assign, don't accumulate" ring logic,
        // feeding the cumulative number in would over-state context by
        // N× turn count. Ring shows 0% briefly until the next live turn
        // emits a real `usage` event with `contextPct`.
        // Tear down the running loop and restart it pointed at this
        // sessionId — otherwise the UI shows the old transcript but
        // the agent keeps running blind against a different (or empty)
        // session, and the context-window ring sits at 0%.
        void this.resumeExistingSession(sessionId);
      }
    }
  }

  /**
   * Tear down the current agent loop and start a fresh one. Called when
   * the user clicks "+" new chat — without this, the webview clears but
   * the underlying agent keeps the same sessionId, the same history, and
   * every session-level state (tool guards, baseModel, completedTools).
   */
  private async startNewSession(): Promise<void> {
    log.appendLine('[startNewSession] aborting current loop and starting fresh');
    this.forceFreshSession = true;
    // Bump generation FIRST — any event posted by the old (now-aborting)
    // loop after this point will arrive at the webview tagged with the
    // OLD gen and be discarded by the webview's gen guard.
    this.sessionGen++;
    void this.webview?.postMessage({ type: 'sessionReset', gen: this.sessionGen });
    // Cancel the current input wait + loop
    this.finishInput(null);
    latestAbort?.();
    // The agent loop's finally block sets agentRunning=false, then we
    // kick off a new run. Wait briefly to ensure cleanup happens first.
    setTimeout(() => { void this.runAgentSession(); }, 50);
  }

  /**
   * Like startNewSession() but targets a specific past session: stages
   * `pendingResumeSessionId`, aborts the current loop, then restarts
   * runAgentSession which picks it up. UI history was already painted
   * by the caller (loadSession handler) so the experience is "click an
   * old chat in the sidebar → keep typing where you left off."
   */
  private async resumeExistingSession(sessionId: string): Promise<void> {
    log.appendLine(`[resumeExistingSession] switching to ${sessionId}`);
    this.pendingResumeSessionId = sessionId;
    this.sessionGen++;
    void this.webview?.postMessage({ type: 'sessionReset', gen: this.sessionGen, resumed: sessionId });
    this.finishInput(null);
    latestAbort?.();
    setTimeout(() => { void this.runAgentSession(); }, 50);
  }

  private async runAgentSession() {
    if (this.agentRunning) return;
    this.agentRunning = true;
    log.appendLine('[runAgentSession] starting…');
    const { dir, hasWorkspace } = getWorkDir();
    log.appendLine(`[runAgentSession] workDir=${dir} hasWorkspace=${hasWorkspace}`);

    if (!hasWorkspace) {
      void this.webview?.postMessage({
        type: 'event',
        event: { kind: 'text_delta', text: '' },
      });
    }

    // ── Auto-resume the most recent session if it's still "warm" ──
    // Without this, every panel re-open creates a fresh sessionId and the
    // user's conversation gets fragmented across multiple /history entries
    // even though they think they're in one continuous chat. We pick the
    // most recently updated session that's been touched within the last
    // RESUME_WINDOW_MS — long enough to cover "I closed VS Code overnight"
    // for active users, short enough that opening Franklin a week later
    // doesn't dredge up an unrelated old conversation.
    //
    // EXCEPT when forceFreshSession is set (user explicitly clicked "+"
    // new chat). Then we deliberately skip resume so the new chat is
    // truly clean — no inherited tool guards, no prior context.
    const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
    let resumeSessionId: string | undefined;
    if (this.pendingResumeSessionId) {
      // User explicitly clicked a history item — honor that, bypass the
      // auto-resume heuristic. Clearing here so a later panel re-open
      // falls back to the default behaviour.
      resumeSessionId = this.pendingResumeSessionId;
      this.pendingResumeSessionId = null;
      log.appendLine(`[runAgentSession] explicit resume of ${resumeSessionId}`);
    } else if (this.forceFreshSession) {
      log.appendLine('[runAgentSession] forceFreshSession set — skipping auto-resume');
      this.forceFreshSession = false;
    } else {
      try {
        const sessions = listSessions().filter(s => s.turnCount > 0 && s.messageCount > 0);
        const newest = sessions[0];
        if (newest && Date.now() - newest.updatedAt < RESUME_WINDOW_MS) {
          resumeSessionId = newest.id;
          log.appendLine(`[runAgentSession] resuming ${newest.id} (last update ${Math.round((Date.now() - newest.updatedAt) / 60000)}m ago)`);
        }
      } catch (err) {
        log.appendLine(`[runAgentSession] resume probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const getUserInput = () =>
      new Promise<string | null>((resolve) => {
        this.resolveInput = resolve;
      });

    const onAskUser = (question: string, options?: string[]) =>
      new Promise<string>((resolve) => {
        this.resolveAskUser = resolve;
        void this.webview?.postMessage({ type: 'askUser', question, options: options || [] });
      });

    try {
      await runVsCodeSession({
        workDir: dir,
        trust: true,
        debug: false,
        resumeSessionId,
        getUserInput,
        onAskUser,
        onConfigReady: (config) => {
          this.agentConfig = config;
        },
        onEvent: (event) => {
          if (event.kind === 'usage') {
            const cost = estimateCost(event.model, event.inputTokens, event.outputTokens, event.calls);
            (event as unknown as Record<string, unknown>).cost = cost;
          }
          this.postEvent(event);
          if (event.kind === 'capability_done' && !event.result.isError) {
            this.maybeSendMediaPreview(event.result.output);
            this.maybeSendEditDiff(event.result);
          }
          if (event.kind === 'turn_done' && event.reason === 'completed') {
            this.scheduleWalletRefresh();
          }
        },
        onAbortReady: (abort) => {
          latestAbort = abort;
        },
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.appendLine(`[runAgentSession] ERROR: ${err}`);
      void this.webview?.postMessage({ type: 'error', message: err });
      void vscode.window.showErrorMessage(`Franklin: ${err}`);
    } finally {
      log.appendLine('[runAgentSession] session ended');
      void this.webview?.postMessage({ type: 'sessionEnded' });
      this.agentRunning = false;
    }
  }
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  // Mascot used in the empty state. franklin-portrait.jpg is kept around as
  // a historical fallback. franklin-mascot.png is the original AI+coin
  // enhanced render; franklin-mascot-transparent.png is the same image
  // with the dark frame chopped out (flood-fill from the corners) so the
  // mascot blends seamlessly with whichever theme background sits behind
  // the panel — no rounded-rectangle frame, no mix-blend-mode hacks.
  const mascotUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'franklin-mascot-transparent.png')
  );
  const portraitUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'franklin-portrait.jpg')
  );
  void portraitUri; // referenced for future use; suppress unused warning
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `media-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: #1a1a1c;
      margin: 0;
      padding: 8px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 200px;
      transition: background 0.2s ease;
    }
    body.session-busy {
      background: #1a1a1c;
    }
    #log {
      flex: 1;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: none;
      padding: 8px;
      margin-bottom: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    /* User messages: right-aligned chat bubbles (Wechat / ChatGPT
     * convention). Assistant messages stay left-aligned with the
     * workflow timeline so the eye can quickly separate "what I said"
     * (right) from "what the agent did" (left). Colors use vscode-*
     * tokens so the bubble adapts to whichever VS Code theme the user
     * is on (dark / light / high-contrast). */
    .user {
      display: flex;
      justify-content: flex-end;
      margin: 16px 0 8px;
      padding: 0;
      border: none;
    }
    .user .bubble {
      display: inline-block;
      background: var(--vscode-input-background, rgba(127,127,127,0.15));
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.20));
      border-radius: 16px 16px 4px 16px;
      padding: 8px 14px;
      max-width: 75%;
      font-size: 13px;
      line-height: 1.55;
      color: var(--vscode-foreground);
      word-break: break-word;
      text-align: left;
      box-shadow: 0 1px 2px rgba(0,0,0,0.15);
    }
    .assistant {
      color: var(--vscode-foreground);
      margin-top: 8px;
      font-size: 13px;
      line-height: 1.6;
    }
    .assistant .msg-content { }
    .msg-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      padding-top: 4px;
    }
    .msg-actions button {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      opacity: 0.6;
      transition: opacity 0.15s, background 0.15s;
    }
    .msg-actions button:hover { opacity: 1; background: rgba(128,128,128,0.15); }
    .msg-actions button.active { opacity: 1; color: var(--vscode-foreground); }
    .msg-actions .msg-model {
      margin-left: auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .meta { color: var(--vscode-descriptionForeground); font-size: 10px; margin-top: 6px; }
    .tool { color: var(--vscode-symbolIcon-functionForeground); font-size: 10px; margin-top: 4px; }
    /* ── Markdown rendering ── */
    .assistant code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: rgba(128,128,128,0.15);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .assistant .code-block {
      position: relative;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 6px;
      margin: 8px 0;
      overflow: hidden;
    }
    .assistant .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      background: rgba(128,128,128,0.08);
      border-bottom: 1px solid var(--vscode-widget-border, #444);
    }
    .assistant .code-lang {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .assistant .code-copy {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
      opacity: 0.7;
      transition: opacity 0.15s, background 0.15s;
    }
    .assistant .code-copy:hover { opacity: 1; background: rgba(128,128,128,0.2); }
    .assistant pre {
      margin: 0;
      padding: 10px 12px;
      overflow-x: auto;
      white-space: pre;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
      background: none;
    }
    .assistant pre code {
      background: none;
      padding: 0;
      border-radius: 0;
    }
    .assistant strong { font-weight: 600; }
    .assistant em { font-style: italic; }
    /* ── Routing chip ── shown at the start of an assistant turn when the
       router decides which model handles it (e.g. "*Auto → google/gemini-2.5-flash*").
       Replaces a plain markdown italic with a styled animated badge so users
       can see at a glance which tier / provider / model handled the turn. */
    .route-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      margin: 0 2px 4px 0;
      border-radius: 999px;
      background: linear-gradient(135deg,
        rgba(120, 120, 140, 0.10),
        rgba(120, 120, 140, 0.18));
      border: 1px solid rgba(128, 128, 128, 0.25);
      font-size: 11px;
      line-height: 1.4;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      vertical-align: middle;
      white-space: nowrap;
      animation: route-chip-in 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      transition: transform 0.18s ease, border-color 0.18s ease;
    }
    /* Suppress the entrance animation on re-renders of the same chip
       identity. The streaming markdown re-renderer recreates the DOM on
       every text_delta, which would otherwise replay the bounce ~30
       times per turn. */
    .route-chip.route-chip-static { animation: none; }
    .route-chip:hover {
      transform: translateY(-1px);
      border-color: rgba(128, 128, 128, 0.55);
    }
    .route-chip .route-tier {
      font-weight: 700;
      letter-spacing: 0.3px;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      font-size: 9px;
    }
    .route-chip .route-arrow {
      opacity: 0.55;
      animation: route-arrow-glide 1.4s ease-in-out infinite;
    }
    .route-chip .route-model {
      display: inline-flex;
      align-items: baseline;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .route-chip .route-provider {
      opacity: 0.7;
      font-size: 10px;
    }
    .route-chip .route-slash {
      opacity: 0.45;
      margin: 0 1px;
    }
    .route-chip .route-modelname {
      color: var(--vscode-foreground);
      font-weight: 500;
    }
    .route-chip .route-spark {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-focusBorder, #4ea3f5);
      box-shadow: 0 0 6px var(--vscode-focusBorder, #4ea3f5);
      animation: route-spark-pulse 1.6s ease-in-out infinite;
    }
    /* Tier-specific accent on the spark */
    .route-tier-auto .route-spark    { background: #4ea3f5; box-shadow: 0 0 6px #4ea3f5; }
    .route-tier-eco .route-spark     { background: #6ed68a; box-shadow: 0 0 6px #6ed68a; }
    .route-tier-premium .route-spark { background: #c89af0; box-shadow: 0 0 8px #c89af0; }
    .route-tier-free .route-spark    { background: #9da3ad; box-shadow: 0 0 6px #9da3ad; }
    @keyframes route-chip-in {
      0%   { opacity: 0; transform: translateY(-4px) scale(0.92); }
      60%  { opacity: 1; transform: translateY(0) scale(1.02); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes route-spark-pulse {
      0%, 100% { transform: scale(1);   opacity: 0.85; }
      50%      { transform: scale(1.4); opacity: 1; }
    }
    @keyframes route-arrow-glide {
      0%, 100% { transform: translateX(0); }
      50%      { transform: translateX(2px); }
    }
    /* ── Composer (Cursor-style) ── */
    #composer {
      flex-shrink: 0;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 10px;
      padding: 0;
      margin: 0;
      background: var(--vscode-input-background);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    #composer:focus-within {
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }
    @keyframes fk-border-flow {
      0%, 100% { border-color: rgba(128,128,128,0.35); box-shadow: none; }
      50%       { border-color: var(--vscode-focusBorder, #007fd4);
                  box-shadow: 0 0 0 1px rgba(0,127,212,0.25); }
    }
    body.session-busy #composer:not(:focus-within) {
      animation: fk-border-flow 2.2s ease-in-out infinite;
    }
    /* Image attachments strip — sits above textarea inside composer.
       Each tile shows a 64px thumbnail with an × remove button. */
    #image-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 10px 0 10px;
      max-height: 160px;
      overflow-y: auto;
    }
    #image-strip .img-tile {
      position: relative;
      width: 64px;
      height: 64px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--vscode-widget-border, #444);
      background: var(--vscode-editor-background);
    }
    #image-strip .img-tile img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    #image-strip .img-tile .rm {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      border: none;
      font-size: 11px;
      line-height: 16px;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #image-strip .img-tile .rm:hover { background: #c00; }
    /* Drag-over visual cue for the whole composer */
    #composer.dragover {
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4);
    }
    #in {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 14px 8px 14px;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      outline: none;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
      /* textarea defaults */
      resize: none;
      overflow-y: auto;
      /* Auto-grow logic in JS sets height up to this; beyond it scrolls. */
      max-height: 220px;
      /* Whitespace handling: wrap long lines automatically, including
         long unbroken tokens (URLs, base64) so the composer never
         widens horizontally past the panel. */
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      display: block;
    }
    #in:disabled { opacity: 0.55; cursor: not-allowed; }
    #in::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
    #composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px 6px 8px;
    }
    #model-picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 5px;
      background: rgba(128,128,128,0.12);
      color: var(--vscode-foreground);
      font-size: 11px;
      border: none;
      cursor: pointer;
      transition: background 0.15s;
      position: relative;
    }
    #model-picker-btn:hover { background: rgba(128,128,128,0.25); }
    #model-picker-btn .chevron { font-size: 8px; opacity: 0.6; }
    #model-dropdown {
      display: none;
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      min-width: 220px;
      max-height: 300px;
      overflow-y: auto;
      overscroll-behavior: contain;
      background: var(--vscode-dropdown-background, #1e1e1e);
      border: 1px solid var(--vscode-dropdown-border, #444);
      border-radius: 6px;
      /* No top padding — the sticky search bar handles the gap itself.
       * Otherwise scrolling items leak into the 4px padding band above
       * the sticky element, which looks like clipping. */
      padding: 0 0 4px;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    #model-dropdown.open { display: block; }
    #model-dropdown .md-search-wrap {
      position: sticky; top: 0; padding: 8px 8px; z-index: 3;
      background: var(--vscode-dropdown-background, #1e1e1e);
      border-bottom: 1px solid rgba(128,128,128,0.25);
    }
    #model-dropdown .md-search {
      width: 100%; box-sizing: border-box; padding: 4px 8px; font: inherit; font-size: 11px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35)); border-radius: 3px;
      outline: none;
    }
    #model-dropdown .md-search:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    #model-dropdown .md-empty {
      padding: 14px 16px; font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic;
    }
    /* ── Routing profile card ── */
    #model-dropdown .md-profile-card {
      padding: 12px 14px; background: rgba(128,128,128,0.06);
      border-radius: 5px; margin: 6px;
      transform-origin: top center;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #model-dropdown .md-profile-card.dismissing {
      opacity: 0; transform: translateY(-4px) scale(0.98);
    }
    .md-profile-hd { display: flex; align-items: center; justify-content: space-between; }
    .md-profile-name { font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
    .md-profile-desc {
      margin-top: 6px; font-size: 11px; line-height: 1.45;
      color: var(--vscode-descriptionForeground);
    }
    .md-profile-toggle {
      position: relative; width: 34px; height: 18px; padding: 0; cursor: pointer;
      background: rgba(128,128,128,0.35); border: none; border-radius: 10px;
      transition: background 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .md-profile-toggle.on { background: #3fb950; }
    .md-profile-toggle .md-toggle-thumb {
      position: absolute; top: 2px; left: 2px;
      width: 14px; height: 14px; border-radius: 50%;
      background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.35);
      /* Spring-ish ease-out so sliding back feels springy instead of linear. */
      transition: left 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .md-profile-toggle.on .md-toggle-thumb { left: 18px; }
    #model-dropdown .md-group {
      padding: 4px 10px 2px 10px;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    #model-dropdown .md-item {
      padding: 5px 12px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--vscode-foreground);
      position: relative;
    }
    #model-dropdown .md-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
    #model-dropdown .md-item.active { background: var(--vscode-list-activeSelectionBackground, rgba(0,127,212,0.25)); }
    #model-dropdown .md-price { font-size: 9px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
    .md-item .md-free { font-size: 9px; color: var(--vscode-terminal-ansiGreen, #3fb950); font-weight: 600; }
    .md-item .md-new { font-size: 8px; background: #e8a020; color: #000; font-weight: 700; border-radius: 3px; padding: 1px 4px; letter-spacing: 0.04em; flex-shrink: 0; }
    #model-dropdown .md-tooltip {
      visibility: hidden;
      opacity: 0;
      position: fixed;
      width: 190px;
      padding: 10px 12px;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 200;
      pointer-events: none;
      transition: opacity 0.12s;
    }
    #model-dropdown .md-item:hover .md-tooltip { visibility: visible; opacity: 1; }
    .md-tooltip .md-tt-name { font-weight: 600; font-size: 12px; margin-bottom: 4px; color: var(--vscode-foreground); }
    .md-tooltip .md-tt-desc { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; margin-bottom: 8px; }
    .md-tooltip .md-tt-ctx { font-size: 10px; color: var(--vscode-descriptionForeground); }
    #input-area { position: relative; flex-shrink: 0; }
    #slash-menu {
      display: none;
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 220px;
      overflow-y: scroll;
      overscroll-behavior: contain;
      background: var(--vscode-dropdown-background, #1e1e1e);
      border: 1px solid var(--vscode-dropdown-border, #444);
      border-radius: 6px;
      padding: 4px 0;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    #slash-menu::-webkit-scrollbar { width: 6px; }
    #slash-menu::-webkit-scrollbar-track { background: transparent; }
    #slash-menu::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4)); border-radius: 3px; }
    #slash-menu::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.7)); }
    #slash-menu.open { display: block; }
    .slash-item {
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 10px;
      color: var(--vscode-foreground);
    }
    .slash-item:hover, .slash-item.selected {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15));
    }
    /* ── AskUser prompt ── */
    .ask-user-card {
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      background: var(--vscode-editorHoverWidget-background, rgba(0,127,212,0.08));
      border-radius: 6px; padding: 10px 12px; margin: 8px 12px;
    }
    .ask-user-question { font-size: 12px; white-space: pre-wrap; margin-bottom: 8px; color: var(--vscode-foreground); }
    .ask-user-options { display: flex; flex-wrap: wrap; gap: 6px; }
    .ask-user-btn {
      font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer;
      background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
      border: 1px solid transparent;
    }
    .ask-user-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .ask-user-btn.secondary {
      background: transparent; color: var(--vscode-foreground);
      border-color: rgba(128,128,128,0.35);
    }
    .ask-user-btn.secondary:hover { background: rgba(128,128,128,0.12); }
    .ask-user-input {
      width: 100%; box-sizing: border-box; padding: 4px 8px; margin-top: 6px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); border-radius: 3px;
      font: inherit;
    }
    /* ── Media preview (ImageGen / VideoGen) ──
     * Thumbnail-by-default to avoid webview jank from inline-decoded
     * multi-MB PNGs. Click the thumb to open a lightbox modal that
     * renders the full image. Videos stay full-size since the user is
     * usually about to play them and a thumb would be misleading. */
    .media-preview {
      margin: 8px 12px; padding: 6px; border-radius: 6px;
      background: rgba(128,128,128,0.08); border: 1px solid rgba(128,128,128,0.2);
      max-width: calc(100% - 24px);
    }
    .media-preview img.media-thumb {
      display: block;
      max-width: 240px;
      max-height: 200px;
      border-radius: 4px;
      cursor: zoom-in;
      transition: transform 120ms ease;
    }
    .media-preview img.media-thumb:hover { transform: scale(1.02); }
    .media-preview video {
      display: block; max-width: 100%; max-height: 360px; border-radius: 4px;
    }
    .media-preview-footer {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-top: 4px;
    }
    .media-preview-path {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .media-preview-open {
      flex-shrink: 0; font-size: 10px; padding: 2px 8px; cursor: pointer;
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid rgba(128,128,128,0.4); border-radius: 3px;
    }
    .media-preview-open:hover { background: rgba(128,128,128,0.15); }
    /* Lightbox: full-bleed black overlay, click anywhere to dismiss.
     * Used for thumbnails that the user clicks to expand. The overlay
     * also respects Escape to close. */
    #media-lightbox {
      position: fixed; inset: 0; z-index: 400;
      background: rgba(0,0,0,0.88);
      display: none;
      align-items: center; justify-content: center;
      padding: 24px; box-sizing: border-box;
      cursor: zoom-out;
      animation: lightbox-fade 160ms ease-out;
    }
    #media-lightbox.open { display: flex; }
    #media-lightbox img {
      max-width: 100%; max-height: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      border-radius: 4px;
      cursor: default;
    }
    #media-lightbox-close {
      position: absolute; top: 12px; right: 12px;
      background: rgba(0,0,0,0.5);
      color: #fff; border: 1px solid rgba(255,255,255,0.15);
      border-radius: 4px;
      padding: 4px 8px; cursor: pointer;
      font-size: 12px;
    }
    #media-lightbox-close:hover { background: rgba(255,255,255,0.12); }
    @keyframes lightbox-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    /* ── Edit diff card (Edit / Write / MultiEdit) ── */
    .edit-diff-card {
      margin: 8px 12px; border-radius: 6px; overflow: hidden;
      background: var(--vscode-editor-background, rgba(128,128,128,0.04));
      border: 1px solid rgba(128,128,128,0.3);
    }
    .edit-diff-card.reverted { opacity: 0.5; }
    .edit-diff-hd {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; gap: 8px;
      background: rgba(128,128,128,0.08);
      border-bottom: 1px solid rgba(128,128,128,0.25);
      font-size: 11px;
    }
    .edit-diff-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
    .edit-diff-icon { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .edit-diff-name {
      font-weight: 600; color: var(--vscode-foreground);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .edit-diff-count {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      padding: 1px 6px; background: rgba(128,128,128,0.2); border-radius: 3px;
      flex-shrink: 0;
    }
    .edit-diff-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .edit-diff-open, .edit-diff-revert {
      font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid rgba(128,128,128,0.4);
    }
    .edit-diff-open:hover { background: rgba(128,128,128,0.15); }
    .edit-diff-revert:hover { background: rgba(248,81,73,0.15); border-color: rgba(248,81,73,0.5); color: #f85149; }
    .edit-diff-revert:disabled { opacity: 0.5; cursor: default; background: transparent; }
    .edit-diff-body {
      margin: 0; padding: 6px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; line-height: 1.5; max-height: 260px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-all;
    }
    .edit-diff-line { padding: 0 4px; }
    .edit-diff-del { background: rgba(248,81,73,0.12); color: #f85149; }
    .edit-diff-add { background: rgba(63,185,80,0.12); color: #3fb950; }
    .slash-item.selected { background: var(--vscode-list-activeSelectionBackground, rgba(0,127,212,0.25)); }
    .slash-cmd { font-weight: 600; color: var(--vscode-foreground); min-width: 80px; }
    .slash-desc { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .composer-right { display: flex; align-items: center; gap: 6px; }
    #wallet-btn, #trading-btn {
      display: inline-flex; align-items: center; justify-content: center;
      background: none; border: none; cursor: pointer;
      padding: 3px; border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      position: relative;
    }
    #wallet-btn { cursor: pointer; }
    #wallet-popover {
      position: fixed;
      left: 8px; right: 8px; bottom: 72px;
      max-width: 280px;
      margin-left: auto;
      box-sizing: border-box;
      background: var(--vscode-editorHoverWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.4));
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25);
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      pointer-events: none;
      visibility: hidden;
      transition:
        opacity 160ms cubic-bezier(0.2,0.8,0.2,1),
        transform 160ms cubic-bezier(0.2,0.8,0.2,1),
        visibility 0s linear 160ms;
      z-index: 150;
      padding: 12px 14px;
    }
    #wallet-popover.open {
      opacity: 1; transform: translateY(0) scale(1);
      pointer-events: auto; visibility: visible;
      transition: opacity 180ms, transform 180ms, visibility 0s;
    }
    .wallet-pop-title {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--vscode-foreground); opacity: 0.85;
      margin-bottom: 8px;
    }
    .wallet-pop-row {
      display: flex; align-items: center; gap: 8px;
      font-size: 11.5px;
      margin-bottom: 6px;
    }
    .wallet-pop-row-label {
      font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.06em; opacity: 0.65;
      width: 60px; flex-shrink: 0;
    }
    .wallet-pop-addr {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 3px;
    }
    .wallet-pop-addr:hover { background: rgba(128,128,128,0.12); }
    .wallet-pop-copy {
      background: transparent; border: 1px solid rgba(128,128,128,0.3);
      color: var(--vscode-foreground);
      font-size: 10px;
      padding: 2px 8px; border-radius: 3px; cursor: pointer;
      flex-shrink: 0;
    }
    .wallet-pop-copy:hover { background: rgba(128,128,128,0.12); }
    #wallet-btn:hover, #trading-btn:hover, #settings-btn:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.15); }
    /* ── Settings button + popover ── */
    #settings-wrap { position: relative; }
    #settings-btn {
      display: inline-flex; align-items: center; gap: 4px;
      background: none; border: none; cursor: pointer;
      padding: 3px 5px; border-radius: 4px;
      color: var(--vscode-descriptionForeground);
    }
    #settings-panel {
      /* Fixed to the webview viewport — NOT absolute inside settings-wrap.
       * Anchoring to the container was rendering the left half of the panel
       * outside the webview iframe on narrow sidebars (covered by VS Code's
       * main editor area). With left/right on the viewport itself the panel
       * is guaranteed to fit. */
      position: fixed;
      left: 8px; right: 8px; bottom: 72px;
      max-width: 340px;
      max-height: calc(100vh - 120px);
      margin-left: auto;
      box-sizing: border-box;
      background: var(--vscode-editorHoverWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.4));
      border-radius: 8px;
      box-shadow:
        0 12px 32px rgba(0,0,0,0.45),
        0 2px 8px rgba(0,0,0,0.25),
        inset 0 1px 0 rgba(255,255,255,0.04);
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      pointer-events: none;
      visibility: hidden;
      transition:
        opacity 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
        transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1),
        visibility 0s linear 160ms;
      z-index: 150;
      font-size: 11px;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    #settings-panel.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
      visibility: visible;
      transition:
        opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
        transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
        visibility 0s;
    }
    .settings-header {
      padding: 10px 14px 9px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      background: linear-gradient(
        to bottom,
        rgba(255,255,255,0.025),
        transparent
      );
    }
    .settings-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-foreground);
      opacity: 0.85;
    }
    .settings-body {
      padding: 12px 14px 4px;
      overflow-y: auto;
      flex: 1 1 auto;
    }
    .settings-section {
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.12));
    }
    .settings-section:last-of-type {
      margin-bottom: 4px;
      padding-bottom: 0;
      border-bottom: none;
    }
    .settings-section-title {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      margin-bottom: 8px;
      padding-left: 1px;
    }
    .settings-row { margin-bottom: 10px; }
    .settings-row:last-child { margin-bottom: 0; }
    .settings-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: var(--vscode-foreground);
      opacity: 0.92;
      margin-bottom: 5px;
      letter-spacing: 0.01em;
    }
    .settings-chain-toggle {
      display: inline-flex;
      gap: 0;
      background: var(--vscode-input-background, rgba(0,0,0,0.2));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
      border-radius: 5px;
      padding: 2px;
    }
    .settings-chain-opt {
      font-size: 11px;
      padding: 4px 14px;
      border-radius: 3px;
      cursor: pointer;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.7;
      transition: background 120ms, color 120ms, opacity 120ms;
    }
    .settings-chain-opt:hover { opacity: 1; }
    .settings-chain-opt.active {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      opacity: 1;
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
    }
    .settings-select {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      font: inherit;
      font-size: 11.5px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      transition: border-color 120ms, box-shadow 120ms;
    }
    .settings-select:hover {
      border-color: var(--vscode-input-border, rgba(128,128,128,0.45));
    }
    .settings-select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }
    .settings-hint {
      margin-top: 5px;
      font-size: 10px;
      line-height: 1.45;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
    .settings-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 14px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      background: linear-gradient(
        to top,
        rgba(0,0,0,0.18),
        transparent
      );
    }
    #settings-status {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      transition: opacity 200ms;
    }
    .settings-save {
      font-size: 11.5px;
      font-weight: 500;
      padding: 5px 16px;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: 1px solid transparent;
      transition: background 120ms, transform 80ms;
    }
    .settings-save:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .settings-save:active { transform: translateY(1px); }
    /* Custom scrollbar inside the body so it blends */
    .settings-body::-webkit-scrollbar { width: 6px; }
    .settings-body::-webkit-scrollbar-thumb {
      background: rgba(128,128,128,0.25);
      border-radius: 3px;
    }
    .settings-body::-webkit-scrollbar-thumb:hover {
      background: rgba(128,128,128,0.4);
    }
    #prefetch-indicator {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      padding: 3px 8px; display: flex; align-items: center; gap: 6px;
    }
    #prefetch-indicator::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--vscode-focusBorder, #007fd4);
      animation: prefetch-pulse 1s ease-in-out infinite;
    }
    @keyframes prefetch-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
    /* ── Overlay panels (doctor + insights) ── */
    .overlay-panel {
      position: fixed;
      inset: 0;
      z-index: 200;
      background: rgba(0,0,0,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .overlay-panel.hidden { display: none; }
    .overlay-box {
      background: var(--vscode-editorHoverWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 8px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .overlay-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #444);
    }
    .overlay-header h3 {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-foreground);
    }
    .overlay-close {
      background: none; border: none; cursor: pointer; padding: 2px;
      border-radius: 4px; color: var(--vscode-descriptionForeground);
      display: flex; align-items: center;
    }
    .overlay-close:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.15); }
    .overlay-body { padding: 10px 14px 14px; }
    /* Nav-action badge (active task count) */
    .nav-badge {
      position: absolute;
      top: -2px; right: -2px;
      min-width: 14px; height: 14px;
      padding: 0 3px;
      border-radius: 7px;
      background: var(--vscode-statusBarItem-prominentBackground, #007fd4);
      color: var(--vscode-statusBarItem-prominentForeground, #fff);
      font-size: 9px;
      font-weight: 700;
      line-height: 14px;
      text-align: center;
      box-sizing: border-box;
      pointer-events: none;
    }
    /* Generic popup menu (used by new-chat dropdown). */
    .popup-menu {
      position: absolute;
      top: 100%; right: 0;
      margin-top: 4px;
      min-width: 180px;
      background: var(--vscode-editorHoverWidget-background, #1e1e1e);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      padding: 4px;
      z-index: 160;
    }
    .popup-item {
      display: block; width: 100%;
      text-align: left;
      padding: 5px 10px;
      background: transparent; border: none;
      color: var(--vscode-foreground);
      font-size: 11.5px; cursor: pointer;
      border-radius: 3px;
    }
    .popup-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
    .popup-divider { height: 1px; background: rgba(128,128,128,0.18); margin: 4px 0; }
    .popup-section-title {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
      padding: 4px 10px 2px; opacity: 0.7;
    }
    /* Tasks overlay rows */
    .task-row {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(128,128,128,0.12);
      font-size: 12px;
    }
    .task-row:last-child { border-bottom: none; }
    .task-row-head {
      display: flex; align-items: center; gap: 8px;
    }
    .task-status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex-shrink: 0;
    }
    .task-status-dot.running {
      background: var(--vscode-charts-green, #3fb950);
      box-shadow: 0 0 6px var(--vscode-charts-green, #3fb950);
      animation: task-pulse 1.4s ease-in-out infinite;
    }
    .task-status-dot.queued { background: var(--vscode-charts-yellow, #e5c07b); }
    .task-status-dot.succeeded { background: var(--vscode-charts-green, #3fb950); opacity: 0.6; }
    .task-status-dot.failed,
    .task-status-dot.timed_out,
    .task-status-dot.cancelled,
    .task-status-dot.lost {
      background: var(--vscode-charts-red, #f85149); opacity: 0.7;
    }
    @keyframes task-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .task-label {
      flex: 1; min-width: 0;
      font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .task-status-text {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .task-cmd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding-left: 16px;
    }
    .task-actions {
      display: flex; gap: 8px;
      padding-left: 16px;
      margin-top: 2px;
    }
    .task-action-btn {
      background: transparent;
      border: 1px solid rgba(128,128,128,0.3);
      color: var(--vscode-foreground);
      font-size: 10.5px;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      opacity: 0.85;
    }
    .task-action-btn:hover { opacity: 1; background: rgba(128,128,128,0.12); }
    .task-action-btn.danger:hover {
      border-color: var(--vscode-charts-red, #f85149);
      color: var(--vscode-charts-red, #f85149);
    }
    .task-log-pre {
      margin: 6px 0 0 16px;
      padding: 8px 10px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      color: var(--vscode-foreground);
      max-height: 240px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* Import candidate rows */
    .import-row {
      display: flex; flex-direction: column; gap: 3px;
      padding: 10px 12px;
      border-radius: 5px;
      cursor: pointer;
      border: 1px solid transparent;
      margin-bottom: 4px;
    }
    .import-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
      border-color: rgba(128,128,128,0.18);
    }
    .import-row-summary {
      font-size: 12px;
      color: var(--vscode-foreground);
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      line-height: 1.35;
    }
    .import-row-meta {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      display: flex; gap: 8px;
    }
    .import-row-meta .mono {
      font-family: var(--vscode-editor-font-family, monospace);
    }
    /* Toast stack */
    #toast-stack {
      position: fixed;
      bottom: 16px;
      right: 16px;
      display: flex; flex-direction: column; gap: 6px;
      z-index: 300;
      pointer-events: none;
      max-width: calc(100% - 32px);
    }
    .toast {
      background: var(--vscode-notifications-background, #1e1e1e);
      border: 1px solid var(--vscode-notifications-border, rgba(128,128,128,0.3));
      color: var(--vscode-notifications-foreground, var(--vscode-foreground));
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      border-radius: 5px;
      padding: 8px 12px;
      font-size: 11.5px;
      max-width: 320px;
      pointer-events: auto;
      animation: toast-slide 220ms cubic-bezier(0.2,0.8,0.2,1);
    }
    .toast.warning {
      border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    }
    .toast.info {
      border-left: 3px solid var(--vscode-charts-blue, #0078d4);
    }
    @keyframes toast-slide {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    /* Wallet QR popover (toggled from wallet status row) */
    .wallet-qr-wrap {
      margin-top: 8px;
      padding: 10px;
      border-radius: 6px;
      background: rgba(0,0,0,0.2);
      border: 1px solid rgba(128,128,128,0.18);
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .wallet-qr-wrap.open { display: flex; }
    .wallet-qr-svg-host {
      background: white;
      padding: 10px;
      border-radius: 4px;
      line-height: 0;
      width: 200px;
      height: 200px;
      box-sizing: content-box;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* The qrcode lib emits an SVG with viewBox but no explicit width/height,
       so the browser renders it at the spec-default 300×150 — squashed and
       overflowing the host. Force the inner SVG to fill the host box so the
       QR is square and crisp at 200×200. */
    .wallet-qr-svg-host svg {
      width: 100%;
      height: 100%;
      display: block;
      shape-rendering: crispEdges;
    }
    .wallet-qr-caption {
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      max-width: 220px;
      line-height: 1.35;
    }
    /* Doctor check rows */
    .check-row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(128,128,128,0.1);
      font-size: 12px;
    }
    .check-row:last-child { border-bottom: none; }
    .check-icon { font-size: 13px; flex-shrink: 0; margin-top: 1px; }
    .check-name { font-weight: 600; color: var(--vscode-foreground); min-width: 110px; }
    .check-detail { color: var(--vscode-descriptionForeground); flex: 1; }
    .check-remedy {
      font-size: 10px; color: var(--vscode-inputValidation-warningForeground, #cca700);
      margin-top: 2px;
    }
    /* Insights cards */
    .insight-summary {
      display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap;
    }
    .insight-card {
      flex: 1; min-width: 70px;
      background: rgba(128,128,128,0.08);
      border: 1px solid rgba(128,128,128,0.15);
      border-radius: 6px;
      padding: 8px 10px;
    }
    .insight-card-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    .insight-card-val { font-size: 16px; font-weight: 700; color: var(--vscode-foreground); margin-top: 2px; }
    .insight-section-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground); font-weight: 600;
      margin: 10px 0 6px;
    }
    .insight-model-row {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 0; font-size: 11px;
      border-bottom: 1px solid rgba(128,128,128,0.08);
    }
    .insight-model-row:last-child { border-bottom: none; }
    .insight-model-name { flex: 1; color: var(--vscode-foreground); font-weight: 500; }
    .insight-model-cost { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
    .insight-model-pct { font-size: 10px; color: var(--vscode-descriptionForeground); min-width: 36px; text-align: right; }
    .insight-bar-wrap { width: 60px; height: 5px; background: rgba(128,128,128,0.15); border-radius: 3px; flex-shrink: 0; }
    .insight-bar { height: 100%; background: var(--vscode-focusBorder, #007fd4); border-radius: 3px; }
    /* Resume banner */
    .resume-banner {
      display: flex; align-items: center; gap: 8px;
      margin: 6px 0 10px;
      padding: 8px 12px;
      background: rgba(0,127,212,0.1);
      border: 1px solid rgba(0,127,212,0.3);
      border-radius: 6px;
      font-size: 12px;
    }
    .resume-banner-text { flex: 1; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .resume-banner-sub { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .resume-btn {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; padding: 3px 10px;
      font-size: 11px; cursor: pointer; flex-shrink: 0; white-space: nowrap;
    }
    .resume-btn:hover { opacity: 0.9; }
    .resume-dismiss {
      background: none; border: none; cursor: pointer; padding: 2px;
      border-radius: 4px; color: var(--vscode-descriptionForeground);
      display: flex; align-items: center; flex-shrink: 0;
    }
    .resume-dismiss:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.15); }
    #wallet-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.3));
      color: var(--vscode-editorHoverWidget-foreground, #ccc);
      font-size: 11px;
      white-space: nowrap;
      padding: 4px 8px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 100;
    }
    #wallet-btn:hover #wallet-tooltip { display: block; }
    #trading-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.3));
      color: var(--vscode-editorHoverWidget-foreground, #ccc);
      font-size: 11px;
      white-space: nowrap;
      padding: 4px 8px;
      border-radius: 4px;
      pointer-events: none;
      z-index: 100;
    }
    #trading-btn:hover #trading-tooltip { display: block; }
    #context-ring { width: 26px; height: 26px; position: relative; cursor: default; }
    #context-ring svg { display: block; }
    .composer-btn {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: opacity 0.15s, background 0.15s;
    }
    .composer-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    #send { background: rgba(160,160,160,0.4); color: var(--vscode-editor-background, #1e1e1e); }
    #send:hover:not(:disabled) { background: rgba(160,160,160,0.55); }
    #stop { background: rgba(160,160,160,0.4); color: var(--vscode-editor-background, #1e1e1e); border: none; }
    #stop:hover:not(:disabled) { background: rgba(160,160,160,0.55); }
    #stop.hidden-btn { display: none; }
    /* Attach (paperclip) is secondary — quieter than Send so it visually
       fades into the toolbar instead of competing with the primary action.
       Matches the muted descriptionForeground tone of other left-side
       toolbar icons (model picker, wallet, trading). */
    #attach {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    #attach:hover:not(:disabled) {
      background: rgba(160,160,160,0.18);
      opacity: 1;
    }
    /* Activity row (inline in log) */
    .activity {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 1px 0;
      margin-top: 6px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-descriptionForeground);
    }
    .activity.thinking {
      color: var(--vscode-charts-purple, #b48ead);
    }
    .activity.tool {
      color: var(--vscode-symbolIcon-functionForeground, #cca700);
    }
    .activity .dots {
      display: inline-flex;
      gap: 2px;
      align-items: center;
      height: 11px;
      flex-shrink: 0;
    }
    .activity .dots span {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.4;
      animation: fk-dot 1.05s ease-in-out infinite;
    }
    .activity .dots span:nth-child(1) {
      animation-delay: 0s;
    }
    .activity .dots span:nth-child(2) {
      animation-delay: 0.18s;
    }
    .activity .dots span:nth-child(3) {
      animation-delay: 0.36s;
    }
    @keyframes fk-dot {
      0%,
      100% {
        opacity: 0.3;
        transform: translateY(0);
      }
      50% {
        opacity: 1;
        transform: translateY(-3px);
      }
    }
    .activity-text {
      flex: 1;
      min-width: 0;
    }
    /* ── Workflow timeline ── */
    .wf-turn { margin-top: 12px; }
    /* ── Workflow timeline (line + dots) ──
     * Design: a continuous vertical track with dots threaded onto it.
     *   - Track is a 1.5px line that runs the full height of the turn.
     *   - Dots sit on top of the track (z-index) so the track appears to
     *     terminate at the dot edge, not under it.
     *   - Filled dots use a slightly stronger color than the line for hierarchy.
     *   - Hollow "thinking" dots have an editor-bg fill so the track is
     *     visually broken (rosary effect — circle on string), not seen
     *     through the circle.
     */
    .wf-step {
      display: flex;
      align-items: flex-start;
      position: relative;
      padding-left: 22px;
      padding-bottom: 8px;
      min-height: 18px;
    }
    .wf-dot {
      position: absolute;
      left: 0;
      top: 4px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: rgba(155,155,155,0.7);
      flex-shrink: 0;
      z-index: 1;
    }
    .wf-step.thinking .wf-dot {
      /* Hollow ring, but filled with editor bg so the track behind it is
       * cleanly hidden inside the circle (rosary-bead look). */
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1.5px solid rgba(155,155,155,0.55);
      width: 8px; height: 8px;
      box-sizing: border-box;
    }
    .wf-step.tool-active .wf-dot {
      background: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 0 0 3px rgba(0,127,212,0.18);
      animation: wf-pulse 1.4s ease-in-out infinite;
    }
    @keyframes wf-pulse {
      0%,100% { box-shadow: 0 0 0 3px rgba(0,127,212,0.18); }
      50%     { box-shadow: 0 0 0 5px rgba(0,127,212,0.30); }
    }
    .wf-turn .wf-step:not(:last-child)::after {
      /* Track: a single thin line spanning each step's full vertical
       * extent. Dots sit on top via z-index so the line appears to end
       * cleanly at each dot's edge.
       * Centered on the dot horizontally (dot left=0 width=9 → center=4.5)
       * but kept at 4px for crisp 1px rendering on standard DPI. */
      content: '';
      position: absolute;
      left: 4px;
      top: 0;
      bottom: -8px;
      width: 1.5px;
      background: linear-gradient(
        to bottom,
        rgba(155,155,155,0.30) 0%,
        rgba(155,155,155,0.45) 100%
      );
      z-index: 0;
    }
    .wf-body { flex: 1; min-width: 0; }
    /* Thinking collapsible */
    .wf-thinking-header {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      user-select: none;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 1px 0;
      transition: color 0.15s;
    }
    .wf-thinking-header:hover { color: var(--vscode-foreground); }
    .wf-arrow {
      font-size: 9px;
      opacity: 0.7;
      transition: transform 0.15s;
      display: inline-block;
      line-height: 1;
      margin-top: 1px;
    }
    .wf-step.open .wf-arrow { transform: rotate(90deg); }
    .wf-thinking-detail {
      overflow: hidden;
      max-height: 0;
      transition: max-height 0.25s ease, padding 0.25s ease, margin-top 0.25s ease;
    }
    .wf-step.open .wf-thinking-detail {
      max-height: 260px;
      overflow-y: auto;
      margin-top: 5px;
      padding: 6px 10px;
      background: rgba(128,128,128,0.06);
      border-left: 2px solid rgba(128,128,128,0.18);
      border-radius: 0 4px 4px 0;
    }
    .wf-thinking-text {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
      word-break: break-word;
    }
    /* Animated dots while thinking is live */
    .wf-think-dots { display: inline-flex; gap: 2px; align-items: center; margin-left: 2px; }
    .wf-think-dots span {
      width: 3px; height: 3px; border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      opacity: 0.4;
      animation: fk-dot 1.05s ease-in-out infinite;
    }
    .wf-think-dots span:nth-child(2) { animation-delay: 0.18s; }
    .wf-think-dots span:nth-child(3) { animation-delay: 0.36s; }
    .wf-think-dots.done { display: none; }
    /* Tool step */
    .wf-tool-line {
      display: flex;
      align-items: baseline;
      gap: 5px;
      font-size: 12px;
      flex-wrap: wrap;
    }
    .wf-tool-name { font-weight: 600; color: var(--vscode-foreground); }
    .wf-tool-file {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
    }
    .wf-tool-result {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 1px;
      opacity: 0.75;
    }
    /* Tool grouping */
    .wf-group-header {
      cursor: pointer; user-select: none;
      display: flex; align-items: baseline; gap: 5px;
      font-size: 12px;
    }
    .wf-group-count {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: normal;
    }
    .wf-group-list {
      display: none;
      margin-top: 4px;
      padding-left: 10px;
      border-left: 1px solid rgba(128,128,128,0.2);
    }
    .wf-step.open .wf-group-list { display: block; }
    .wf-group-item {
      display: flex; align-items: baseline; gap: 5px;
      padding: 2px 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .wf-group-item .wf-tool-file { max-width: 180px; }
    .wf-group-item .wf-tool-result { margin-top: 0; font-size: 10px; }
    /* Text step */
    .wf-step.text { padding-bottom: 8px; }
    .wf-text-body { font-size: 13px; line-height: 1.55; }
    /* Streaming caret — visible only while text is being streamed in. */
    .msg-content.streaming::after {
      content: '▍';
      display: inline-block;
      margin-left: 2px;
      color: var(--vscode-focusBorder, #007fd4);
      animation: fk-caret-blink 1s steps(1, end) infinite;
      vertical-align: text-top;
    }
    @keyframes fk-caret-blink { 50% { opacity: 0; } }
    .wf-body .assistant { margin-top: 0; }
    /* ── Views: chat (default) / history overlay ── */
    #view-chat { display: flex; flex-direction: column; height: 100vh; position: relative; }
    #view-history {
      display: none;
      flex-direction: column;
      position: absolute;
      top: 41px;
      right: 0;
      width: 72%;
      max-height: 60vh;
      background: var(--vscode-dropdown-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 0 0 8px 8px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.45);
      z-index: 50;
      overflow: hidden;
    }
    #view-history.open { display: flex; }
    #history-search {
      width: 100%;
      padding: 5px 8px;
      background: rgba(128,128,128,0.1);
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      color: var(--vscode-foreground);
      font-size: 11px;
      outline: none;
      box-sizing: border-box;
    }
    #history-search::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
    #history-search:focus { border-color: var(--vscode-focusBorder, #007fd4); }

    /* ── Empty-state brand ──
     * Was absolutely-positioned + vertically centered, which pushed the
     * pixel portrait off-screen once we added the example-prompts block,
     * and the pointer-events:none kludge also broke clicks. Now it's a
     * normal flex column anchored to the top. */
    #empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 14px;
      padding: 40px 20px 24px;
    }
    /* Fade-in when the empty state first appears (e.g. after New Chat). */
    @keyframes fk-fade-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #empty-state.fk-fade-in { animation: fk-fade-in 0.28s ease-out; }
    #empty-state .pixel-portrait {
      width: 280px;
      height: 280px;
      max-width: 90%;
      object-fit: contain;
      /* The PNG itself has its frame flood-filled to alpha=0, so it
       * composites directly onto whatever theme background is behind
       * the panel — light, dark, or high-contrast all look the same. */
      filter: drop-shadow(0 8px 24px rgba(0,0,0,0.45));
    }
    #empty-state .brand-name {
      font-size: 40px;
      font-weight: 900;
      color: #f5c842;
      letter-spacing: 0.01em;
      line-height: 1;
    }
    #empty-state .brand-slogan {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      letter-spacing: 0.02em;
    }
    #empty-state .brand-slogan .accent { color: #3fb950; font-weight: 500; }
    body.has-messages #empty-state { display: none; }
    /* ── Example prompts (empty state) ── */
    #example-prompts {
      margin-top: 18px; width: 100%; max-width: 320px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .example-prompts-title {
      font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase; padding-left: 2px; margin-bottom: 2px;
    }
    .example-prompt {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 8px 10px; cursor: pointer;
      background: var(--vscode-input-background, rgba(128,128,128,0.06));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 6px; color: var(--vscode-foreground);
      font-size: 12px; text-align: left;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .example-prompt:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
      background: rgba(128,128,128,0.12);
    }
    .example-prompt-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
    .example-prompt-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── History list ── */
    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px 8px;
      flex-shrink: 0;
    }
    .history-header h3 {
      margin: 0;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-foreground);
    }
    .history-header .history-actions {
      display: flex;
      gap: 6px;
    }
    .history-header button {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    .history-header button:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.15); }
    #history-list {
      flex: 1;
      overflow-y: auto;
      padding: 0 4px;
    }
    .history-item {
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 2px;
      position: relative;
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
    .history-item .hi-title {
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding-right: 44px; /* leave room for action buttons */
    }
    .history-item .hi-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    /* Per-row action buttons (rename / delete) — shown on hover only so
       the resting state stays clean. Absolute-positioned inside the row
       so they don't push the title around. */
    .history-item .hi-actions {
      position: absolute;
      top: 6px;
      right: 6px;
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 120ms;
    }
    .history-item:hover .hi-actions { opacity: 1; }
    .hi-action-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .hi-action-btn:hover {
      background: rgba(128,128,128,0.18);
      color: var(--vscode-foreground);
    }
    .hi-action-btn.danger:hover {
      color: var(--vscode-charts-red, #f85149);
      background: rgba(248,81,73,0.12);
    }
    /* Inline rename input replaces the title row in-place. Same font / size
       as the static title so the row doesn't jump on edit. */
    .history-item .hi-title-input {
      width: 100%;
      box-sizing: border-box;
      padding: 2px 4px;
      font-size: 12px;
      font-family: inherit;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background, rgba(0,0,0,0.2));
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 3px;
      outline: none;
    }
    /* Delete confirmation inline pill — replaces actions row briefly. */
    .history-item .hi-confirm {
      position: absolute;
      top: 6px;
      right: 6px;
      display: flex;
      gap: 2px;
      align-items: center;
      font-size: 10px;
      color: var(--vscode-charts-red, #f85149);
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-charts-red, #f85149);
      border-radius: 3px;
      padding: 1px 4px;
    }
    .history-item .hi-confirm button {
      background: transparent; border: none; cursor: pointer;
      color: inherit; font-size: 10px; padding: 0 4px;
    }
    .history-item .hi-confirm button:hover { text-decoration: underline; }
    .history-empty {
      padding: 20px 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    #new-chat-btn {
      margin: 8px 12px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, #444);
      background: rgba(128,128,128,0.08);
      color: var(--vscode-foreground);
      font-size: 12px;
      cursor: pointer;
      text-align: center;
      flex-shrink: 0;
    }
    #new-chat-btn:hover { background: rgba(128,128,128,0.2); }

    /* ── Chat nav header ── */
    #nav-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border, #444);
      flex-shrink: 0;
    }
    #nav-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .nav-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-left: auto;
    }
    .nav-actions button {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .nav-actions button:hover {
      color: var(--vscode-foreground);
      background: rgba(128,128,128,0.18);
    }
  </style>
</head>
<body>
  <!-- ── Doctor overlay ── -->
  <div id="doctor-overlay" class="overlay-panel hidden">
    <div class="overlay-box">
      <div class="overlay-header">
        <h3>System Health</h3>
        <button class="overlay-close" id="doctor-close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="overlay-body" id="doctor-body">
        <div class="check-row"><span class="check-detail">Running checks…</span></div>
      </div>
    </div>
  </div>

  <!-- ── Insights overlay ── -->
  <div id="insights-overlay" class="overlay-panel hidden">
    <div class="overlay-box">
      <div class="overlay-header">
        <h3>Usage Insights · 30 days</h3>
        <button class="overlay-close" id="insights-close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="overlay-body" id="insights-body">
        <div class="check-row"><span class="check-detail">Loading…</span></div>
      </div>
    </div>
  </div>

  <!-- ── Tasks overlay (background tasks spawned via Detach tool) ── -->
  <div id="tasks-overlay" class="overlay-panel hidden">
    <div class="overlay-box">
      <div class="overlay-header">
        <h3>Background Tasks</h3>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="overlay-close" id="tasks-prune" title="Delete all completed tasks older than 24h">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2h6v2M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="overlay-close" id="tasks-refresh" title="Refresh">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.3-3.5M13.5 2v2.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="overlay-close" id="tasks-close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="overlay-body" id="tasks-body">
        <div class="check-row"><span class="check-detail">Loading…</span></div>
      </div>
    </div>
  </div>

  <!-- ── GPU sandboxes overlay (Modal sandbox lifecycle) ── -->
  <div id="sandboxes-overlay" class="overlay-panel hidden">
    <div class="overlay-box">
      <div class="overlay-header">
        <h3>GPU Sandboxes</h3>
        <div style="display:flex;align-items:center;gap:6px;">
          <button class="overlay-close" id="sandboxes-cleanup" title="Terminate ALL active sandboxes" style="color:var(--vscode-charts-red,#f85149);">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2h6v2M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="overlay-close" id="sandboxes-refresh" title="Refresh">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.3-3.5M13.5 2v2.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="overlay-close" id="sandboxes-close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="overlay-body" id="sandboxes-body">
        <div class="check-row"><span class="check-detail">Loading…</span></div>
      </div>
    </div>
  </div>

  <!-- ── Import session overlay ── -->
  <div id="import-overlay" class="overlay-panel hidden">
    <div class="overlay-box">
      <div class="overlay-header">
        <h3 id="import-title">Import session</h3>
        <button class="overlay-close" id="import-close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="overlay-body" id="import-body">
        <div class="check-row"><span class="check-detail">Scanning…</span></div>
      </div>
    </div>
  </div>

  <!-- ── Toast notifications (rate-limit, etc.) ── -->
  <div id="toast-stack" aria-live="polite"></div>

  <!-- Image lightbox — opens when user clicks an inline media thumbnail.
       Hidden by default; toggled via class. -->
  <div id="media-lightbox" role="dialog" aria-label="Image preview">
    <button type="button" id="media-lightbox-close">Close (Esc)</button>
    <img id="media-lightbox-img" alt="" />
  </div>

  <!-- ── Wallet popover (address + QR + copy) ── -->
  <div id="wallet-popover">
    <div class="wallet-pop-title">Wallet</div>
    <div class="wallet-pop-row">
      <span class="wallet-pop-row-label">Chain</span>
      <span id="wallet-pop-chain" style="font-size:11px;text-transform:capitalize;">—</span>
    </div>
    <div class="wallet-pop-row">
      <span class="wallet-pop-row-label">Balance</span>
      <span id="wallet-pop-balance" style="font-size:11px;color:var(--vscode-charts-green,#3fb950);">—</span>
    </div>
    <div class="wallet-pop-row" style="align-items:flex-start;">
      <span class="wallet-pop-row-label" style="padding-top:3px;">Address</span>
      <span id="wallet-pop-addr" class="wallet-pop-addr" title="Click to copy">—</span>
      <button type="button" class="wallet-pop-copy" id="wallet-pop-copy">Copy</button>
    </div>
    <div id="wallet-qr-host" class="wallet-qr-wrap">
      <div id="wallet-qr-svg" class="wallet-qr-svg-host"></div>
      <div id="wallet-qr-caption" class="wallet-qr-caption">Scan with a USDC-capable wallet to send funds.</div>
    </div>
  </div>

  <!-- ── Chat view ── -->
  <div id="view-chat">
    <div id="nav-header">
      <span id="nav-title">Untitled</span>
      <div class="nav-actions">
        <button id="btn-tasks" title="Background tasks" style="position:relative;">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="2.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="6.75" width="12" height="2.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="10.5" width="12" height="2.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/></svg>
          <span id="tasks-badge" class="nav-badge" style="display:none;">0</span>
        </button>
        <button id="btn-sandboxes" title="Active GPU sandboxes" style="position:relative;">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l5 2.5v4.5c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 8l1.5 1.5L11 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span id="sandboxes-badge" class="nav-badge" style="display:none;">0</span>
        </button>
        <button id="btn-doctor" title="System Health">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2a5 5 0 1 0 0 10A5 5 0 0 0 8 2z" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3l2 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.5 13.5c.8.3 1.6.5 2.5.5s1.7-.2 2.5-.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button id="btn-insights" title="Usage Insights">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="9" width="3" height="5" rx="0.8" stroke="currentColor" stroke-width="1.3"/><rect x="6.5" y="5" width="3" height="9" rx="0.8" stroke="currentColor" stroke-width="1.3"/><rect x="11" y="2" width="3" height="12" rx="0.8" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
        <button id="btn-history" title="History">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <div id="new-chat-wrap" style="position:relative;display:inline-flex;align-items:center;">
          <button id="btn-new" title="New chat" style="padding-right:2px;">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          </button>
          <button id="btn-new-menu" title="More options" style="padding:4px 3px;opacity:0.6;">
            <svg width="8" height="8" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div id="new-chat-menu" class="popup-menu" style="display:none;">
            <button type="button" class="popup-item" data-action="new">New chat</button>
            <div class="popup-divider"></div>
            <div class="popup-section-title">Import session from</div>
            <button type="button" class="popup-item" data-action="import-claude">Claude Code…</button>
            <button type="button" class="popup-item" data-action="import-codex">Codex…</button>
          </div>
        </div>
      </div>
    </div>
    <!-- ── History dropdown ── -->
    <div id="view-history">
      <div style="display:flex;align-items:center;gap:6px;padding:8px 10px 7px;border-bottom:1px solid var(--vscode-widget-border,#444);flex-shrink:0;">
        <input id="history-search" type="text" placeholder="Search history…" autocomplete="off" />
        <button id="history-refresh" title="Refresh" style="background:none;border:none;cursor:pointer;padding:2px;border-radius:3px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;flex-shrink:0;">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.3-3.5M13.5 2v2.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button id="history-close" title="Close" style="background:none;border:none;cursor:pointer;padding:2px;border-radius:3px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;flex-shrink:0;">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div id="history-list" style="overflow-y:auto;flex:1;padding:4px;"></div>
    </div>
    <div id="log">
      <div id="empty-state">
        <!-- mascot — see media/franklin-mascot.png; original pixel-art SVG kept in git history -->
        <img class="pixel-portrait" src="${mascotUri}" alt="Franklin mascot" />
        <div class="brand-slogan">The AI agent with a <span class="accent">wallet</span>.</div>
        <div id="loading-step" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:8px;opacity:0.7;">Initializing…</div>
        <div id="example-prompts">
          <div class="example-prompts-title">Try</div>
          <button type="button" class="example-prompt" data-prompt="Explain the code in this file and point out anything that could be simplified.">
            <span class="example-prompt-icon">📝</span>
            <span class="example-prompt-text">Explain the code in this file</span>
          </button>
          <button type="button" class="example-prompt" data-prompt="Generate an image of ">
            <span class="example-prompt-icon">🎨</span>
            <span class="example-prompt-text">Generate an image of…</span>
          </button>
          <button type="button" class="example-prompt" data-prompt="What is BTC looking like today? Give me a signal with RSI, MACD, and support levels.">
            <span class="example-prompt-icon">📈</span>
            <span class="example-prompt-text">What's BTC looking like today?</span>
          </button>
        </div>
      </div>
    </div>
  <div id="input-area">
    <div id="slash-menu"></div>
    <div id="prefetch-indicator" style="display:none;"></div>
    <div class="meta" id="status"></div>
  <div id="composer">
    <div id="image-strip" style="display:none;"></div>
    <input type="file" id="file-input" accept="image/png,image/jpeg,image/jpg,image/gif,image/webp" multiple style="display:none;" />
    <textarea id="in" rows="1" placeholder="Plan, @ for context, / for commands. Paste / drop images. Enter to send, Shift+Enter for newline." autocomplete="off"></textarea>
    <div id="composer-toolbar">
      <div style="position:relative;display:flex;align-items:center;gap:2px;">
        <button type="button" id="model-picker-btn">
          <span id="modelPickerLabel">Model</span>
          <span class="chevron">&#9662;</span>
        </button>
        <div id="model-dropdown"></div>
        <button type="button" id="wallet-btn">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="4" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/>
            <path d="M1 7h14" stroke="currentColor" stroke-width="1.3"/>
            <circle cx="11.5" cy="10.5" r="1" fill="currentColor"/>
            <path d="M4 4V3a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.3"/>
          </svg>
          <span id="wallet-tooltip">loading…</span>
        </button>
        <button type="button" id="trading-btn">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 12l3.5-4 3 2.5L12 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 5h2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span id="trading-tooltip">Trading Dashboard</span>
        </button>
        <div id="settings-wrap">
          <button type="button" id="settings-btn" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          <div id="settings-panel">
            <div class="settings-header">
              <span class="settings-title">Settings</span>
            </div>
            <div class="settings-body">
              <div class="settings-section">
                <div class="settings-section-title">Wallet</div>
                <div class="settings-row">
                  <label class="settings-label">Payment chain</label>
                  <div class="settings-chain-toggle">
                    <button type="button" class="settings-chain-opt" data-chain="base">Base</button>
                    <button type="button" class="settings-chain-opt" data-chain="solana">Solana</button>
                  </div>
                </div>
              </div>

              <div class="settings-section">
                <div class="settings-section-title">Media</div>
                <div class="settings-row">
                  <label class="settings-label" for="settings-img">Default image model</label>
                  <select id="settings-img" class="settings-select"><option value="__unset__">Ask each time</option></select>
                </div>
                <div class="settings-row">
                  <label class="settings-label" for="settings-vid">Default video model</label>
                  <select id="settings-vid" class="settings-select"><option value="__unset__">Ask each time</option></select>
                </div>
              </div>

              <!-- Spending-limits section was removed in v3.11.0 sync —
                   core no longer enforces a per-turn cap (wallet balance
                   is the only ceiling). Re-add here if a future feature
                   reintroduces a tunable spend limit. -->
            </div>
            <div class="settings-actions">
              <span id="settings-status"></span>
              <button type="button" id="settings-save" class="settings-save">Save</button>
            </div>
          </div>
        </div>
      </div>
      <div class="composer-right">
        <div id="context-ring" title="Context usage">
          <svg width="26" height="26" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="11" fill="none" stroke="rgba(128,128,128,0.18)" stroke-width="2"></circle>
            <circle id="contextArc" cx="13" cy="13" r="11" fill="none" stroke="var(--vscode-focusBorder, #007fd4)" stroke-width="2" stroke-dasharray="69.12" stroke-dashoffset="69.12" stroke-linecap="round" transform="rotate(-90 13 13)"></circle>
            <text id="contextPct" x="13" y="13" text-anchor="middle" dominant-baseline="central" fill="var(--vscode-descriptionForeground)" font-size="7" font-family="var(--vscode-font-family)">0%</text>
          </svg>
        </div>
        <button type="button" id="attach" class="composer-btn" title="Attach image (or paste / drop)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>
        </button>
        <button type="button" id="stop" class="composer-btn hidden-btn" title="Stop generation">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"></rect></svg>
        </button>
        <button type="button" id="send" class="composer-btn" title="Send message">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M8 4L4.5 7.5M8 4l3.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        </button>
      </div>
    </div>
  </div>
  </div><!-- /input-area -->
  </div><!-- /view-chat -->

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const historyList = document.getElementById('history-list');
    const log = document.getElementById('log');
    const input = document.getElementById('in');
    const status = document.getElementById('status');
    const navTitle = document.getElementById('nav-title');
    var inlineActivity = null; // activity element inside log
    let assistantBuf = '';
    var assistantEl = null;
    var agentBusy = false;
    var activityMode = 'waiting';
    var toolNameStr = '';
    var streamingModelName = '';
    // Session generation guard — incremented by extension when "+" is clicked.
    // Events tagged with older gen are discarded so an aborted loop can't
    // paint old content into a freshly-cleared chat.
    var currentSessionGen = 0;
    // Tracks which routing-chip identities have already been rendered with
    // the bouncy entrance animation in the current chat. Reset on chat
    // reset and on each new assistant turn so the FIRST paint of a chip
    // bounces, but subsequent re-renders during the streaming text update
    // come in static. Without this the chip pops every text_delta.
    var routeChipSeen = {};
    // ── Workflow state ──
    var thinkingBuf = '';
    var thinkStartTime = 0;
    var currentTurnWf = null;
    var currentThinkingStep = null;
    var toolStepMap = {};
    var wfTextStep = null;
    var currentToolGroup = null; // { name, groupStepEl, countEl, subListEl, items }


    var currentChatTitle = 'Untitled';
    var isLiveChat = true; // true = current live session, false = viewing old history

    function refreshHasMessages() {
      var has = false;
      var kids = log.children;
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.id === 'empty-state') continue;
        if ((k.textContent || '').trim().length > 0) { has = true; break; }
      }
      document.body.classList.toggle('has-messages', has);
    }
    function resetChatLog() {
      dismissResumeBanner();
      // Remove messages but keep empty-state node intact
      var kids = Array.from(log.children);
      kids.forEach(function(k) { if (k.id !== 'empty-state') log.removeChild(k); });
      assistantBuf = '';
      assistantEl = null;
      thinkingBuf = '';
      thinkStartTime = 0;
      currentTurnWf = null;
      currentThinkingStep = null;
      toolStepMap = {};
      wfTextStep = null;
      currentToolGroup = null;
      // Reset context-usage ring — without this, the indicator carries the
      // accumulated token count from the prior session, so a fresh chat
      // can show "100%" before the user has even typed anything.
      totalInputTokens = 0;
      updateContextRing();
      // Reset routing-chip animation memory so the next assistant turn's
      // first chip render bounces in fresh.
      routeChipSeen = {};
      refreshHasMessages();
    }
    var historyDropdown = document.getElementById('view-history');
    function showChat(title) {
      if (title) currentChatTitle = title;
      historyDropdown.classList.remove('open');
      navTitle.textContent = currentChatTitle;
    }
    var historySearchEl = document.getElementById('history-search');
    var allHistoryItems = [];

    function filterHistory(q) {
      var lower = q.toLowerCase().trim();
      var filtered = lower ? allHistoryItems.filter(function(i) {
        return i.title.toLowerCase().indexOf(lower) !== -1 || i.model.toLowerCase().indexOf(lower) !== -1;
      }) : allHistoryItems;
      renderHistoryList(filtered, true);
    }

    historySearchEl.addEventListener('input', function() {
      filterHistory(historySearchEl.value);
    });

    function showHistory() {
      historyDropdown.classList.toggle('open');
      if (historyDropdown.classList.contains('open')) {
        historySearchEl.value = '';
        vscode.postMessage({ type: 'requestHistory' });
        setTimeout(function() { try { historySearchEl.focus(); } catch(e){} }, 50);
      }
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!historyDropdown.classList.contains('open')) return;
      var navHeader = document.getElementById('nav-header');
      if (!historyDropdown.contains(e.target) && !navHeader.contains(e.target)) {
        historyDropdown.classList.remove('open');
      }
    });

    // Top-right nav buttons
    document.getElementById('btn-history').addEventListener('click', function(e) {
      e.stopPropagation();
      showHistory();
    });
    function newChat() {
      // Clear the visible UI immediately for responsiveness.
      resetChatLog();
      isLiveChat = true;
      showChat('Untitled');
      // Tell the extension host to actually start a fresh agent loop.
      // Without this, "+ new chat" only clears the webview but the
      // underlying agent keeps the same session — so prior tool guards
      // (e.g. "ImageGen disabled, open a new conversation") and resumed
      // history bleed into what looks like a new chat to the user.
      vscode.postMessage({ type: 'newSession' });
      // Brief fade-in so the empty state doesn't just pop in abruptly.
      var es = document.getElementById('empty-state');
      if (es) {
        es.classList.remove('fk-fade-in');
        // Force reflow so the animation restarts even on repeat clicks.
        void es.offsetWidth;
        es.classList.add('fk-fade-in');
      }
    }
    document.getElementById('btn-new').addEventListener('click', newChat);
    document.getElementById('history-refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'requestHistory' });
    });
    document.getElementById('history-close').addEventListener('click', function() {
      showChat();
    });

    // ── Doctor overlay ──
    var doctorOverlay = document.getElementById('doctor-overlay');
    var doctorBody = document.getElementById('doctor-body');
    document.getElementById('btn-doctor').addEventListener('click', function() {
      doctorBody.innerHTML = '<div class="check-row"><span class="check-detail">Running checks…</span></div>';
      doctorOverlay.classList.remove('hidden');
      vscode.postMessage({ type: 'runDoctor' });
    });
    document.getElementById('doctor-close').addEventListener('click', function() {
      doctorOverlay.classList.add('hidden');
    });
    doctorOverlay.addEventListener('click', function(e) {
      if (e.target === doctorOverlay) doctorOverlay.classList.add('hidden');
    });
    function renderDoctorResults(checks, error) {
      doctorBody.innerHTML = '';
      if (error) {
        doctorBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Error: ' + error + '</span></div>';
        return;
      }
      checks.forEach(function(c) {
        var row = document.createElement('div');
        row.className = 'check-row';
        var icon = document.createElement('span');
        icon.className = 'check-icon';
        icon.textContent = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
        icon.style.color = c.status === 'ok' ? 'var(--vscode-terminal-ansiGreen,#3fb950)' : c.status === 'warn' ? 'var(--vscode-editorWarning-foreground,#cca700)' : 'var(--vscode-inputValidation-errorBorder,#f44)';
        var info = document.createElement('div');
        info.style.flex = '1';
        var nameSpan = document.createElement('div');
        nameSpan.style.display = 'flex'; nameSpan.style.gap = '8px'; nameSpan.style.alignItems = 'baseline';
        var n = document.createElement('span'); n.className = 'check-name'; n.textContent = c.name;
        var d = document.createElement('span'); d.className = 'check-detail'; d.textContent = c.detail;
        nameSpan.appendChild(n); nameSpan.appendChild(d);
        info.appendChild(nameSpan);
        if (c.remedy) {
          var r = document.createElement('div'); r.className = 'check-remedy'; r.textContent = c.remedy;
          info.appendChild(r);
        }
        row.appendChild(icon);
        row.appendChild(info);
        doctorBody.appendChild(row);
      });
    }

    // ── Insights overlay ──
    var insightsOverlay = document.getElementById('insights-overlay');
    var insightsBody = document.getElementById('insights-body');
    document.getElementById('btn-insights').addEventListener('click', function() {
      insightsBody.innerHTML = '<div class="check-row"><span class="check-detail">Loading…</span></div>';
      insightsOverlay.classList.remove('hidden');
      vscode.postMessage({ type: 'loadInsights' });
    });
    document.getElementById('insights-close').addEventListener('click', function() {
      insightsOverlay.classList.add('hidden');
    });
    insightsOverlay.addEventListener('click', function(e) {
      if (e.target === insightsOverlay) insightsOverlay.classList.add('hidden');
    });
    function renderInsights(data, error) {
      insightsBody.innerHTML = '';
      if (error) {
        insightsBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Error: ' + error + '</span></div>';
        return;
      }
      // Summary cards
      var summary = document.createElement('div'); summary.className = 'insight-summary';
      function card(label, val) {
        var c = document.createElement('div'); c.className = 'insight-card';
        var l = document.createElement('div'); l.className = 'insight-card-label'; l.textContent = label;
        var v = document.createElement('div'); v.className = 'insight-card-val'; v.textContent = val;
        c.appendChild(l); c.appendChild(v); summary.appendChild(c);
      }
      card('Total Cost', '$' + (data.totalCostUsd || 0).toFixed(3));
      card('Requests', String(data.windowRecords || 0));
      card('Proj/mo', '$' + ((data.projections && data.projections.projectedMonthlyUsd) || 0).toFixed(2));
      card('Saved vs Opus', '$' + (data.savedVsOpusUsd || 0).toFixed(3));
      insightsBody.appendChild(summary);

      // ── Cost breakdown by capability category (chat / media / sandbox) ──
      // Pulls byCategory from generateInsights (added 2026-05-02 to surface
      // Modal sandbox spend explicitly, since per-call cost is small enough
      // to get hidden in the Top Models bar list otherwise).
      var cat = data.byCategory;
      if (cat && (cat.chatCostUsd > 0 || cat.mediaCostUsd > 0 || cat.sandboxCostUsd > 0)) {
        var catTitle = document.createElement('div');
        catTitle.className = 'insight-section-title';
        catTitle.textContent = 'By Category';
        insightsBody.appendChild(catTitle);

        var catSummary = document.createElement('div');
        catSummary.className = 'insight-summary';
        function catCard(label, val, sub) {
          var c = document.createElement('div'); c.className = 'insight-card';
          var l = document.createElement('div'); l.className = 'insight-card-label'; l.textContent = label;
          var v = document.createElement('div'); v.className = 'insight-card-val'; v.textContent = val;
          c.appendChild(l); c.appendChild(v);
          if (sub) {
            var s = document.createElement('div');
            s.style.cssText = 'font-size:9.5px;color:var(--vscode-descriptionForeground);margin-top:2px;opacity:0.85;';
            s.textContent = sub;
            c.appendChild(s);
          }
          catSummary.appendChild(c);
        }
        catCard('Chat', '$' + (cat.chatCostUsd || 0).toFixed(3), 'LLM token spend');
        catCard('Media', '$' + (cat.mediaCostUsd || 0).toFixed(3), 'image/video/music');
        catCard(
          'Sandbox',
          '$' + (cat.sandboxCostUsd || 0).toFixed(3),
          (cat.sandboxRequests || 0) + ' Modal calls'
        );
        insightsBody.appendChild(catSummary);
      }

      // Top models
      var models = (data.byModel || []).slice(0, 5);
      if (models.length > 0) {
        var t = document.createElement('div'); t.className = 'insight-section-title'; t.textContent = 'Top Models';
        insightsBody.appendChild(t);
        var maxCost = models[0].costUsd || 0.0001;
        models.forEach(function(m) {
          var row = document.createElement('div'); row.className = 'insight-model-row';
          var name = document.createElement('span'); name.className = 'insight-model-name';
          // Prettify Modal entries — modal/T4 → "Modal T4 GPU",
          // modal/exec → "Modal exec". Other models keep the
          // last path segment to stay consistent with previous UX.
          var displayName;
          if (m.model.indexOf('modal/') === 0) {
            var tier = m.model.slice('modal/'.length);
            if (tier === 'cpu') displayName = '🖥 Modal CPU';
            else if (tier === 'exec' || tier === 'status' || tier === 'terminate') {
              displayName = '🖥 Modal ' + tier;
            } else {
              displayName = '🖥 Modal ' + tier + ' GPU';
            }
          } else {
            displayName = m.model.split('/').pop() || m.model;
          }
          name.textContent = displayName;
          var barWrap = document.createElement('div'); barWrap.className = 'insight-bar-wrap';
          var bar = document.createElement('div'); bar.className = 'insight-bar';
          bar.style.width = Math.round((m.costUsd / maxCost) * 100) + '%';
          barWrap.appendChild(bar);
          var cost = document.createElement('span'); cost.className = 'insight-model-cost';
          cost.textContent = '$' + (m.costUsd || 0).toFixed(4);
          var pct = document.createElement('span'); pct.className = 'insight-model-pct';
          pct.textContent = Math.round(m.percentOfTotal || 0) + '%';
          row.appendChild(name); row.appendChild(barWrap); row.appendChild(cost); row.appendChild(pct);
          insightsBody.appendChild(row);
        });
      }
    }

    // ── Tasks overlay ──
    var tasksOverlay = document.getElementById('tasks-overlay');
    var tasksBody = document.getElementById('tasks-body');
    var tasksBadge = document.getElementById('tasks-badge');
    var tasksAutoRefresh = null;
    var openTaskLogId = null;
    document.getElementById('btn-tasks').addEventListener('click', function() {
      tasksBody.innerHTML = '<div class="check-row"><span class="check-detail">Loading…</span></div>';
      tasksOverlay.classList.remove('hidden');
      vscode.postMessage({ type: 'loadTasks' });
      // Auto-refresh while overlay is open so running tasks tick.
      if (tasksAutoRefresh) clearInterval(tasksAutoRefresh);
      tasksAutoRefresh = setInterval(function() {
        if (!tasksOverlay.classList.contains('hidden')) {
          vscode.postMessage({ type: 'loadTasks' });
          if (openTaskLogId) vscode.postMessage({ type: 'tailTaskLog', text: openTaskLogId });
        }
      }, 3000);
    });
    function closeTasks() {
      tasksOverlay.classList.add('hidden');
      openTaskLogId = null;
      if (tasksAutoRefresh) { clearInterval(tasksAutoRefresh); tasksAutoRefresh = null; }
    }
    document.getElementById('tasks-close').addEventListener('click', closeTasks);
    document.getElementById('tasks-refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'loadTasks' });
      if (openTaskLogId) vscode.postMessage({ type: 'tailTaskLog', text: openTaskLogId });
    });
    document.getElementById('tasks-prune').addEventListener('click', function() {
      // Bulk-delete every terminal task older than 24 hours. Running /
      // queued tasks are protected by the core deleteTask validation.
      if (!window.confirm('Delete all completed background tasks older than 24 hours?')) return;
      vscode.postMessage({ type: 'pruneOldTasks' });
    });
    tasksOverlay.addEventListener('click', function(e) {
      if (e.target === tasksOverlay) closeTasks();
    });
    function fmtTaskTime(ms) {
      if (!ms) return '—';
      var d = new Date(ms);
      var now = Date.now();
      var diff = now - ms;
      if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return d.toLocaleDateString();
    }
    function renderTasks(tasks, error) {
      tasksBody.innerHTML = '';
      if (error) {
        tasksBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Error: ' + error + '</span></div>';
        return;
      }
      var activeCount = 0;
      tasks.forEach(function(t) {
        if (t.status === 'running' || t.status === 'queued') activeCount++;
      });
      if (tasksBadge) {
        if (activeCount > 0) {
          tasksBadge.textContent = String(activeCount);
          tasksBadge.style.display = '';
        } else {
          tasksBadge.style.display = 'none';
        }
      }
      if (tasks.length === 0) {
        tasksBody.innerHTML = '<div class="check-row"><span class="check-detail">No tasks yet. Detached jobs spawned by the agent appear here.</span></div>';
        return;
      }
      tasks.forEach(function(t) {
        var row = document.createElement('div');
        row.className = 'task-row';
        var head = document.createElement('div'); head.className = 'task-row-head';
        var dot = document.createElement('span'); dot.className = 'task-status-dot ' + t.status;
        var label = document.createElement('span'); label.className = 'task-label';
        label.textContent = t.label || t.runId.slice(0, 12);
        var status = document.createElement('span'); status.className = 'task-status-text';
        var when = t.endedAt ? fmtTaskTime(t.endedAt) : t.startedAt ? fmtTaskTime(t.startedAt) : fmtTaskTime(t.createdAt);
        status.textContent = t.status + ' · ' + when;
        head.appendChild(dot); head.appendChild(label); head.appendChild(status);
        row.appendChild(head);

        if (t.command) {
          var cmd = document.createElement('div'); cmd.className = 'task-cmd';
          cmd.textContent = '$ ' + t.command;
          row.appendChild(cmd);
        }
        if (t.terminalSummary || t.progressSummary || t.error) {
          var sum = document.createElement('div'); sum.className = 'task-cmd';
          sum.style.opacity = '1';
          sum.textContent = t.error ? '✗ ' + t.error : (t.terminalSummary || t.progressSummary);
          row.appendChild(sum);
        }

        var actions = document.createElement('div'); actions.className = 'task-actions';
        var tailBtn = document.createElement('button'); tailBtn.className = 'task-action-btn';
        tailBtn.textContent = openTaskLogId === t.runId ? 'Hide log' : 'View log';
        tailBtn.addEventListener('click', function() {
          if (openTaskLogId === t.runId) {
            openTaskLogId = null;
            vscode.postMessage({ type: 'loadTasks' });
          } else {
            openTaskLogId = t.runId;
            vscode.postMessage({ type: 'tailTaskLog', text: t.runId });
          }
        });
        actions.appendChild(tailBtn);
        if (t.status === 'running' || t.status === 'queued') {
          // Live tasks: only Cancel makes sense (delete is blocked
          // server-side anyway). Cancel sends SIGTERM, the runner will
          // flip status to terminal and a future delete is then allowed.
          var cancelBtn = document.createElement('button');
          cancelBtn.className = 'task-action-btn danger';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'cancelTask', text: t.runId });
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling…';
          });
          actions.appendChild(cancelBtn);
        } else {
          // Terminal tasks: Delete permanently removes the per-task dir
          // (meta + events + log). With confirm because logs may be the
          // only record of what the agent actually did in there.
          var deleteBtn = document.createElement('button');
          deleteBtn.className = 'task-action-btn danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.title = 'Permanently delete this task and its logs';
          deleteBtn.addEventListener('click', function() {
            if (!window.confirm('Delete this task permanently? Its log and event history will be gone.')) return;
            vscode.postMessage({ type: 'deleteTask', text: t.runId });
            deleteBtn.disabled = true;
            deleteBtn.textContent = 'Deleting…';
          });
          actions.appendChild(deleteBtn);
        }
        row.appendChild(actions);

        if (openTaskLogId === t.runId) {
          var logHost = document.createElement('pre');
          logHost.className = 'task-log-pre';
          logHost.id = 'task-log-' + t.runId;
          logHost.textContent = '(loading…)';
          row.appendChild(logHost);
        }

        tasksBody.appendChild(row);
      });
    }
    function renderTaskLog(runId, log) {
      if (openTaskLogId !== runId) return;
      var host = document.getElementById('task-log-' + runId);
      if (host) host.textContent = log || '(no output yet)';
    }

    // ── GPU Sandboxes overlay ──
    var sandboxesOverlay = document.getElementById('sandboxes-overlay');
    var sandboxesBody = document.getElementById('sandboxes-body');
    var sandboxesBadge = document.getElementById('sandboxes-badge');
    var sandboxesAutoRefresh = null;
    document.getElementById('btn-sandboxes').addEventListener('click', function() {
      sandboxesBody.innerHTML = '<div class="check-row"><span class="check-detail">Loading…</span></div>';
      sandboxesOverlay.classList.remove('hidden');
      vscode.postMessage({ type: 'loadSandboxes' });
      if (sandboxesAutoRefresh) clearInterval(sandboxesAutoRefresh);
      sandboxesAutoRefresh = setInterval(function() {
        if (!sandboxesOverlay.classList.contains('hidden')) {
          vscode.postMessage({ type: 'loadSandboxes' });
        }
      }, 5000);
    });
    function closeSandboxes() {
      sandboxesOverlay.classList.add('hidden');
      if (sandboxesAutoRefresh) { clearInterval(sandboxesAutoRefresh); sandboxesAutoRefresh = null; }
    }
    document.getElementById('sandboxes-close').addEventListener('click', closeSandboxes);
    document.getElementById('sandboxes-refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'loadSandboxes' });
    });
    document.getElementById('sandboxes-cleanup').addEventListener('click', function() {
      // Confirm — terminating everything is destructive (and costs $0.001 each).
      var n = sandboxesBody.querySelectorAll('.sandbox-row').length;
      if (n === 0) return;
      if (!window.confirm('Terminate all ' + n + ' sandboxes? Each terminate costs $0.001.')) return;
      vscode.postMessage({ type: 'cleanupSandboxes' });
      sandboxesBody.innerHTML = '<div class="check-row"><span class="check-detail">Terminating…</span></div>';
    });
    sandboxesOverlay.addEventListener('click', function(e) {
      if (e.target === sandboxesOverlay) closeSandboxes();
    });
    function fmtSandboxAge(createdMs) {
      var diff = Date.now() - createdMs;
      if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      return Math.floor(diff / 3600000) + 'h ago';
    }
    function gpuLabel(tier) {
      if (tier === 'cpu') return 'CPU only';
      return 'GPU ' + tier;
    }
    function renderSandboxes(items, error) {
      sandboxesBody.innerHTML = '';
      if (error) {
        sandboxesBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Error: ' + error + '</span></div>';
        return;
      }
      if (sandboxesBadge) {
        if (items.length > 0) {
          sandboxesBadge.textContent = String(items.length);
          sandboxesBadge.style.display = '';
        } else {
          sandboxesBadge.style.display = 'none';
        }
      }
      if (items.length === 0) {
        sandboxesBody.innerHTML = '<div class="check-row"><span class="check-detail">No active sandboxes. Created via ModalCreate appear here.</span></div>';
        return;
      }
      items.forEach(function(s) {
        var row = document.createElement('div');
        row.className = 'task-row sandbox-row';
        var head = document.createElement('div'); head.className = 'task-row-head';
        var dot = document.createElement('span'); dot.className = 'task-status-dot running';
        var label = document.createElement('span'); label.className = 'task-label';
        label.textContent = s.id;
        label.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
        label.style.fontSize = '11px';
        var status = document.createElement('span'); status.className = 'task-status-text';
        status.textContent = gpuLabel(s.gpu) + ' · ' + fmtSandboxAge(s.createdAt);
        head.appendChild(dot); head.appendChild(label); head.appendChild(status);
        row.appendChild(head);
        if (s.timeoutSeconds) {
          var meta = document.createElement('div'); meta.className = 'task-cmd';
          var ageS = Math.floor((Date.now() - s.createdAt) / 1000);
          var remaining = Math.max(0, s.timeoutSeconds - ageS);
          meta.textContent = 'auto-terminates in ' + Math.floor(remaining / 60) + 'm ' + (remaining % 60) + 's';
          row.appendChild(meta);
        }
        sandboxesBody.appendChild(row);
      });
    }

    // ── Import session overlay ──
    var importOverlay = document.getElementById('import-overlay');
    var importBody = document.getElementById('import-body');
    var importTitle = document.getElementById('import-title');
    function openImport(source) {
      importTitle.textContent = source === 'codex' ? 'Import from Codex' : 'Import from Claude Code';
      importBody.innerHTML = '<div class="check-row"><span class="check-detail">Scanning…</span></div>';
      importOverlay.classList.remove('hidden');
      vscode.postMessage({ type: 'listImportCandidates', text: source });
    }
    document.getElementById('import-close').addEventListener('click', function() {
      importOverlay.classList.add('hidden');
    });
    importOverlay.addEventListener('click', function(e) {
      if (e.target === importOverlay) importOverlay.classList.add('hidden');
    });
    function renderImportCandidates(source, candidates, error) {
      importBody.innerHTML = '';
      if (error) {
        importBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Error: ' + error + '</span></div>';
        return;
      }
      if (!candidates || candidates.length === 0) {
        var label = source === 'codex' ? 'Codex' : 'Claude Code';
        importBody.innerHTML =
          '<div class="check-row"><span class="check-detail">No ' + label + ' sessions found. ' +
          (source === 'codex' ? 'Looked in ~/.codex/sessions and ~/.codex/archived_sessions.' : 'Looked in ~/.claude/projects.') +
          '</span></div>';
        return;
      }
      candidates.forEach(function(c) {
        var row = document.createElement('div'); row.className = 'import-row';
        var s = document.createElement('div'); s.className = 'import-row-summary';
        s.textContent = c.summary || '(no summary)';
        var meta = document.createElement('div'); meta.className = 'import-row-meta';
        var idSpan = document.createElement('span'); idSpan.className = 'mono';
        idSpan.textContent = (c.id || '').slice(0, 8);
        var when = document.createElement('span');
        when.textContent = fmtTaskTime(c.updatedAt);
        var cwd = document.createElement('span');
        if (c.cwd) {
          cwd.textContent = '· ' + c.cwd.split('/').slice(-2).join('/');
          cwd.style.opacity = '0.7';
        }
        meta.appendChild(idSpan); meta.appendChild(when);
        if (c.cwd) meta.appendChild(cwd);
        row.appendChild(s); row.appendChild(meta);
        row.addEventListener('click', function() {
          importBody.innerHTML = '<div class="check-row"><span class="check-detail">Importing…</span></div>';
          vscode.postMessage({
            type: 'importSession',
            settings: { source: source, id: c.id },
          });
        });
        importBody.appendChild(row);
      });
    }

    // ── New chat dropdown menu ──
    var newChatMenu = document.getElementById('new-chat-menu');
    var btnNewMenu = document.getElementById('btn-new-menu');
    if (btnNewMenu && newChatMenu) {
      btnNewMenu.addEventListener('click', function(e) {
        e.stopPropagation();
        newChatMenu.style.display = newChatMenu.style.display === 'none' ? 'block' : 'none';
      });
      newChatMenu.addEventListener('click', function(e) {
        var btn = e.target.closest && e.target.closest('.popup-item');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        newChatMenu.style.display = 'none';
        if (action === 'new') newChat();
        else if (action === 'import-claude') openImport('claude');
        else if (action === 'import-codex') openImport('codex');
      });
      document.addEventListener('click', function(e) {
        if (newChatMenu.style.display === 'none') return;
        var wrap = document.getElementById('new-chat-wrap');
        if (wrap && !wrap.contains(e.target)) newChatMenu.style.display = 'none';
      });
    }

    // ── Toast stack (rate-limit + import notifications) ──
    var toastStack = document.getElementById('toast-stack');
    function showToast(text, kind, durationMs) {
      if (!toastStack) return;
      var t = document.createElement('div');
      t.className = 'toast ' + (kind || 'info');
      t.textContent = text;
      toastStack.appendChild(t);
      setTimeout(function() {
        t.style.transition = 'opacity 240ms';
        t.style.opacity = '0';
        setTimeout(function() { try { toastStack.removeChild(t); } catch(e){} }, 260);
      }, durationMs || 4500);
    }
    // Rate-limit detection: when we see a stream error event whose message
    // looks like 429 / "rate limit", surface as a friendly toast instead
    // of the raw red stack trace inline.
    var lastRateLimitToastAt = 0;
    function maybeShowRateLimitToast(errorText) {
      if (!errorText) return false;
      var msg = String(errorText).toLowerCase();
      var isRateLimit =
        /\brate.?limit/.test(msg) ||
        msg.indexOf('429') !== -1 ||
        msg.indexOf('too many requests') !== -1 ||
        msg.indexOf('quota exceeded') !== -1;
      if (!isRateLimit) return false;
      // Throttle to 1 per 6s so a flurry doesn't stack up.
      var now = Date.now();
      if (now - lastRateLimitToastAt < 6000) return true;
      lastRateLimitToastAt = now;
      showToast('⏳ Gateway rate-limited — auto-retrying in a few seconds…', 'warning', 5000);
      return true;
    }

    // ── Image lightbox (click-to-zoom for inline media thumbnails) ──
    var lightboxEl = document.getElementById('media-lightbox');
    var lightboxImg = document.getElementById('media-lightbox-img');
    var lightboxClose = document.getElementById('media-lightbox-close');
    function openLightbox(src, alt) {
      if (!lightboxEl || !lightboxImg) return;
      lightboxImg.src = src;
      lightboxImg.alt = alt || 'image';
      lightboxEl.classList.add('open');
    }
    function closeLightbox() {
      if (!lightboxEl || !lightboxImg) return;
      lightboxEl.classList.remove('open');
      // Drop the src to release the decoded bitmap from memory after fade.
      setTimeout(function() {
        if (!lightboxEl.classList.contains('open')) lightboxImg.src = '';
      }, 200);
    }
    if (lightboxEl) {
      // Click anywhere outside the image (including the dim backdrop) closes.
      // The image itself stops propagation so clicks on it don't dismiss.
      lightboxEl.addEventListener('click', function(e) {
        if (e.target === lightboxImg) return;
        closeLightbox();
      });
    }
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && lightboxEl && lightboxEl.classList.contains('open')) {
        closeLightbox();
      }
    });

    // ── Wallet popover (chain-aware QR + copy) ──
    var walletPopover = document.getElementById('wallet-popover');
    var walletPopBtn = document.getElementById('wallet-btn');
    var walletQrHost = document.getElementById('wallet-qr-host');
    var walletQrSvg = document.getElementById('wallet-qr-svg');
    var walletQrCaption = document.getElementById('wallet-qr-caption');
    var walletPopAddr = document.getElementById('wallet-pop-addr');
    var walletPopChain = document.getElementById('wallet-pop-chain');
    var walletPopBalance = document.getElementById('wallet-pop-balance');
    var walletPopCopyBtn = document.getElementById('wallet-pop-copy');
    var walletQrLoaded = false;

    function copyToClipboard(text) {
      try {
        navigator.clipboard.writeText(text);
        showToast('Copied to clipboard', 'info', 1500);
      } catch (e) { showToast('Copy failed', 'warning', 2500); }
    }
    if (walletPopAddr) {
      walletPopAddr.addEventListener('click', function() {
        var t = walletPopAddr.textContent || '';
        if (t && t !== '—') copyToClipboard(t);
      });
    }
    if (walletPopCopyBtn) {
      walletPopCopyBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var t = walletPopAddr.textContent || '';
        if (t && t !== '—') copyToClipboard(t);
      });
    }

    if (walletPopBtn && walletPopover) {
      walletPopBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var isOpen = walletPopover.classList.contains('open');
        if (isOpen) {
          walletPopover.classList.remove('open');
        } else {
          walletPopover.classList.add('open');
          // Lazy-load QR on first open; subsequent opens reuse cached SVG.
          if (!walletQrLoaded) {
            walletQrSvg.innerHTML = '<div style="font-size:10px;color:var(--vscode-descriptionForeground);">Loading QR…</div>';
            walletQrHost.classList.add('open');
            vscode.postMessage({ type: 'loadWalletQr' });
          }
        }
      });
      document.addEventListener('click', function(e) {
        if (!walletPopover.classList.contains('open')) return;
        if (walletPopBtn.contains(e.target) || walletPopover.contains(e.target)) return;
        walletPopover.classList.remove('open');
      });
    }

    // ── Trading dashboard button ──
    document.getElementById('trading-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'openTrading' });
    });

    // ── Settings popover ──
    var settingsWrap = document.getElementById('settings-wrap');
    var settingsPanel = document.getElementById('settings-panel');
    var settingsImgSel = document.getElementById('settings-img');
    var settingsVidSel = document.getElementById('settings-vid');
    // settings-spend-cap input was removed when core dropped max-turn-spend-usd
    // in v3.11.0 — keep var as null so any leftover code referencing it
    // short-circuits cleanly instead of throwing.
    var settingsSpendCap = null;
    // settings-batch-concurrency removed — parallel media gen is on the
    // feature/parallel-media-gen branch, not in this stable build.
    var settingsBatchConcurrency = null;
    var settingsStatusEl = document.getElementById('settings-status');
    var pendingChain = 'base';

    function updateChainPill(_chain) { /* pill removed — chain is visible inside the panel */ }

    function setChainToggleActive(chain) {
      pendingChain = chain;
      var opts = settingsPanel.querySelectorAll('.settings-chain-opt');
      Array.prototype.forEach.call(opts, function(el) {
        if (el.getAttribute('data-chain') === chain) el.classList.add('active');
        else el.classList.remove('active');
      });
    }

    function populateModelSelect(sel, options, current) {
      // keep the first "Ask each time" option, clear the rest
      while (sel.options.length > 1) sel.remove(1);
      (options || []).forEach(function(o) {
        var opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.label;
        if (o.id === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (!current) sel.value = '__unset__';
    }

    document.getElementById('settings-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = settingsPanel.classList.contains('open');
      if (isOpen) {
        settingsPanel.classList.remove('open');
      } else {
        settingsPanel.classList.add('open');
        if (settingsStatusEl) settingsStatusEl.textContent = '';
        vscode.postMessage({ type: 'loadSettings' });
      }
    });
    document.addEventListener('click', function(e) {
      if (!settingsPanel.classList.contains('open')) return;
      if (settingsWrap && !settingsWrap.contains(e.target)) {
        settingsPanel.classList.remove('open');
      }
    });
    Array.prototype.forEach.call(
      settingsPanel.querySelectorAll('.settings-chain-opt'),
      function(el) {
        el.addEventListener('click', function() {
          setChainToggleActive(el.getAttribute('data-chain'));
        });
      }
    );
    document.getElementById('settings-save').addEventListener('click', function() {
      vscode.postMessage({
        type: 'saveSettings',
        settings: {
          chain: pendingChain,
          'default-image-model': settingsImgSel.value,
          'default-video-model': settingsVidSel.value,
        },
      });
      // Close the popover — dismissing itself is the save confirmation.
      settingsPanel.classList.remove('open');
    });

    // ── Resume banner ──
    var resumeBannerEl = null;
    var resumeSessionId = null;
    function showResumeBanner(session) {
      if (resumeBannerEl) return; // already shown
      resumeSessionId = session.id;
      resumeBannerEl = document.createElement('div');
      resumeBannerEl.className = 'resume-banner';
      var textWrap = document.createElement('div');
      var titleDiv = document.createElement('div'); titleDiv.className = 'resume-banner-text'; titleDiv.textContent = session.title;
      var subDiv = document.createElement('div'); subDiv.className = 'resume-banner-sub'; subDiv.textContent = session.ago + ' · ' + session.model;
      textWrap.appendChild(titleDiv); textWrap.appendChild(subDiv);
      var continueBtn = document.createElement('button'); continueBtn.className = 'resume-btn'; continueBtn.textContent = 'Continue';
      continueBtn.addEventListener('click', function() {
        dismissResumeBanner();
        isLiveChat = false;
        vscode.postMessage({ type: 'loadSession', text: session.id });
      });
      var dismissBtn = document.createElement('button'); dismissBtn.className = 'resume-dismiss'; dismissBtn.title = 'Dismiss';
      dismissBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      dismissBtn.addEventListener('click', dismissResumeBanner);
      resumeBannerEl.appendChild(textWrap);
      resumeBannerEl.appendChild(continueBtn);
      resumeBannerEl.appendChild(dismissBtn);
      // Place the resume card ABOVE the pixel portrait by inserting it as
      // the first child of #empty-state. Previously it was inserted after
      // empty-state, which put it below everything — easy to miss.
      var emptyState = document.getElementById('empty-state');
      if (emptyState) {
        emptyState.insertBefore(resumeBannerEl, emptyState.firstChild);
      } else {
        log.insertBefore(resumeBannerEl, log.firstChild);
      }
    }
    function dismissResumeBanner() {
      if (resumeBannerEl && resumeBannerEl.parentNode) {
        resumeBannerEl.parentNode.removeChild(resumeBannerEl);
      }
      resumeBannerEl = null;
    }

    function hasLogMessages() {
      return !!log.querySelector('.user, .assistant, .wf-turn');
    }
    function renderHistoryList(items, isFiltered) {
      historyList.textContent = '';
      if (!isFiltered) allHistoryItems = items || [];
      // "Current Chat" entry to resume live session
      if (!isFiltered && isLiveChat && hasLogMessages()) {
        var cur = document.createElement('div');
        cur.className = 'history-item';
        cur.style.borderBottom = '1px solid var(--vscode-widget-border, #333)';
        cur.style.marginBottom = '4px';
        var curTitle = document.createElement('div');
        curTitle.className = 'hi-title';
        curTitle.textContent = currentChatTitle;
        cur.appendChild(curTitle);
        var curMeta = document.createElement('div');
        curMeta.className = 'hi-meta';
        curMeta.textContent = 'Current session';
        cur.appendChild(curMeta);
        cur.addEventListener('click', function() { showChat(); });
        historyList.appendChild(cur);
      }
      if (!items || items.length === 0) {
        if (!isLiveChat || !hasLogMessages()) {
          var empty = document.createElement('div');
          empty.className = 'history-empty';
          empty.textContent = 'No conversations yet. Start a new chat!';
          historyList.appendChild(empty);
        }
        return;
      }
      items.forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'history-item';
        el.dataset.sessionId = item.id;

        var title = document.createElement('div');
        title.className = 'hi-title';
        title.textContent = item.title;
        el.appendChild(title);

        var meta = document.createElement('div');
        meta.className = 'hi-meta';
        meta.textContent = item.ago;
        el.appendChild(meta);

        // ── Per-row actions: rename + delete ──
        var actions = document.createElement('div');
        actions.className = 'hi-actions';

        var renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'hi-action-btn';
        renameBtn.title = 'Rename';
        renameBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5l2 2L5 13l-3 .5.5-3 9-8z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        renameBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          beginRename(el, item);
        });
        actions.appendChild(renameBtn);

        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'hi-action-btn danger';
        deleteBtn.title = 'Delete';
        deleteBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        deleteBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          beginDeleteConfirm(el, item);
        });
        actions.appendChild(deleteBtn);

        el.appendChild(actions);

        el.addEventListener('click', function() {
          // Skip if user is editing or confirming on this row
          if (el.querySelector('.hi-title-input')) return;
          if (el.querySelector('.hi-confirm')) return;
          isLiveChat = false;
          historyDropdown.classList.remove('open');
          vscode.postMessage({ type: 'loadSession', text: item.id });
        });
        historyList.appendChild(el);
      });
    }

    function beginRename(rowEl, item) {
      var titleEl = rowEl.querySelector('.hi-title');
      var actionsEl = rowEl.querySelector('.hi-actions');
      if (!titleEl || titleEl.querySelector('input')) return;
      if (actionsEl) actionsEl.style.display = 'none';
      var oldText = titleEl.textContent;
      titleEl.textContent = '';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'hi-title-input';
      input.value = oldText;
      input.maxLength = 200;
      titleEl.appendChild(input);
      try { input.focus(); input.select(); } catch (e) {}

      var done = false;
      function commit(save) {
        if (done) return;
        done = true;
        var newTitle = input.value.trim();
        titleEl.textContent = save && newTitle ? newTitle : oldText;
        if (actionsEl) actionsEl.style.display = '';
        if (save && newTitle && newTitle !== oldText) {
          vscode.postMessage({
            type: 'renameSession',
            settings: { id: item.id, title: newTitle },
          });
        }
      }
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', function() { commit(true); });
    }

    function beginDeleteConfirm(rowEl, item) {
      var actionsEl = rowEl.querySelector('.hi-actions');
      if (rowEl.querySelector('.hi-confirm')) return;
      if (actionsEl) actionsEl.style.display = 'none';
      var confirm = document.createElement('div');
      confirm.className = 'hi-confirm';
      var label = document.createElement('span');
      label.textContent = 'Delete?';
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = 'Yes';
      var no = document.createElement('button');
      no.type = 'button';
      no.textContent = 'No';
      confirm.appendChild(label);
      confirm.appendChild(yes);
      confirm.appendChild(no);
      rowEl.appendChild(confirm);

      yes.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', text: item.id });
        // Optimistic removal — host will push fresh historyList anyway.
        rowEl.style.opacity = '0.5';
        rowEl.style.pointerEvents = 'none';
      });
      no.addEventListener('click', function(e) {
        e.stopPropagation();
        rowEl.removeChild(confirm);
        if (actionsEl) actionsEl.style.display = '';
      });
    }

    // Start directly on the chat view (empty state shows brand)
    refreshHasMessages();

    // Live balance tracking
    var baseBalance = null;
    var sessionCost = 0;
    var costAtLastFetch = 0;

    function parseBalanceNum(s) {
      var m = s.match(/[$]([\\.\\.\\d]+)/);
      return m ? parseFloat(m[1]) : null;
    }
    function syncBaseBalance(balStr) {
      var num = parseBalanceNum(balStr);
      if (num !== null) {
        baseBalance = num;
        costAtLastFetch = sessionCost;
      }
      var tip = document.getElementById('wallet-tooltip');
      if (tip && balStr) tip.textContent = balStr;
    }
    function computeLiveBalance() {
      if (baseBalance === null) return null;
      return '$' + Math.max(0, baseBalance - (sessionCost - costAtLastFetch)).toFixed(2) + ' USDC';
    }

    // ── Model dropdown ──
    // Synced with CLI: Franklin/src/ui/model-picker.ts (PICKER_CATEGORIES).
    // When the CLI picker changes, mirror here AND in
    // franklin-desktop/src/renderer/index.html. Retired entries dropped
    // from picker; shortcuts still resolve via MODEL_SHORTCUTS.
    var MODEL_LIST = [
      {group: 'Promo ($0.001/call)', items: [
        {label: 'GLM-5.1', shortcut: 'glm', price: '$0.001/call', desc: 'Zhipu flagship. Strong multilingual and reasoning.', ctx: '128k'},
        {label: 'GLM-5 Turbo', shortcut: 'glm-turbo', price: '$0.001/call', desc: 'Fast Zhipu variant.', ctx: '128k'}
      ]},
      {group: 'Smart Routing', items: [
        {label: 'Auto', shortcut: 'auto', price: 'routed', desc: 'Auto-pick the best model per task. Cheap on simple work, frontier on hard.', ctx: 'varies'}
      ]},
      {group: 'Premium Frontier', items: [
        {label: 'Claude Opus 4.7', shortcut: 'opus', price: '$5/$25', desc: 'Anthropic most capable. 1M context, 128k output. Best for complex reasoning.', ctx: '1M', isNew: true},
        {label: 'Claude Sonnet 4.6', shortcut: 'sonnet', price: '$3/$15', desc: 'Anthropic best-value. Great for everyday coding tasks.', ctx: '200k'},
        {label: 'GPT-5.5', shortcut: 'gpt', price: '$5/$30', desc: 'OpenAI latest flagship. Best general capability.', ctx: '272k', isNew: true},
        {label: 'Gemini 3.1 Pro', shortcut: 'gemini-3', price: '$2/$12', desc: 'Google next-gen flagship. Improved reasoning.', ctx: '1M'},
        {label: 'Gemini 2.5 Pro', shortcut: 'gemini', price: '$1.25/$10', desc: 'Google flagship. Strong at code and multimodal.', ctx: '1M'},
        {label: 'Grok 4', shortcut: 'grok-4', price: '$0.2/$1.5', desc: 'xAI latest. Strong general reasoning.', ctx: '128k'}
      ]},
      {group: 'Reasoning', items: [
        {label: 'O3', shortcut: 'o3', price: '$2/$8', desc: 'OpenAI reasoning model. Strong at math and logic.', ctx: '200k'},
        {label: 'GPT-5.3 Codex', shortcut: 'codex', price: '$1.75/$14', desc: 'OpenAI code-specialized model.', ctx: '272k'},
        {label: 'DeepSeek V4 Pro', shortcut: 'v4-pro', price: '$0.5/$1 (promo)', desc: '1.6T MoE, 1M context. Punches up to GPT-5.5/Opus on hard tasks at <1/10 the price. Launch promo through 2026-05-31.', ctx: '1M', isNew: true},
        {label: 'DeepSeek V4 Flash R.', shortcut: 'r1', price: '$0.2/$0.4', desc: 'DeepSeek reasoning. Chain-of-thought for hard problems.', ctx: '128k'},
        {label: 'Grok 4.1 Fast R.', shortcut: 'grok-fast', price: '$0.2/$0.5', desc: 'xAI fast reasoning model.', ctx: '128k'}
      ]},
      {group: 'Budget', items: [
        {label: 'Claude Haiku 4.5', shortcut: 'haiku', price: '$1/$5', desc: 'Anthropic fastest. Quick responses at low cost.', ctx: '200k'},
        {label: 'GPT-5 Mini', shortcut: 'mini', price: '$0.25/$2', desc: 'Compact and fast. Good for simpler tasks.', ctx: '1M'},
        {label: 'Gemini 2.5 Flash', shortcut: 'flash', price: '$0.3/$2.5', desc: 'Google fast model. Low cost with solid quality.', ctx: '1M'},
        {label: 'DeepSeek V4 Flash Chat', shortcut: 'deepseek', price: '$0.2/$0.4', desc: 'DeepSeek V4 Flash, paid. 1M context, excellent code generation.', ctx: '1M', isNew: true},
        {label: 'Kimi K2.6', shortcut: 'kimi', price: '$0.95/$4', desc: 'Moonshot flagship. 256k context, vision + reasoning.', ctx: '256k'}
      ]},
      {group: 'Free (no USDC needed)', items: [
        {label: 'DeepSeek V4 Flash', shortcut: 'deepseek-v4', price: '', desc: 'DeepSeek V4 Flash via NVIDIA. Newest free model, fast and general-purpose.', ctx: '128k', isNew: true},
        {label: 'Qwen3 Coder 480B', shortcut: 'free', price: '', desc: 'Alibaba coding model. Free, specialized for code.', ctx: '256k'},
        {label: 'Llama 4 Maverick', shortcut: 'maverick', price: '', desc: 'Meta Llama 4. Free, strong multilingual.', ctx: '128k'}
      ]}
    ];

    var MODEL_LOOKUP = [];
    MODEL_LIST.forEach(function(grp) { grp.items.forEach(function(item) { MODEL_LOOKUP.push(item); }); });
    MODEL_LOOKUP.sort(function(a, b) { return b.shortcut.length - a.shortcut.length; });

    // Fallback keyword → label map for models whose shortcut doesn't appear in the full ID
    var MODEL_ID_KEYWORDS = [
      ['glm-4.7', 'GLM-4.7'],
      ['qwen3-coder', 'Qwen3 Coder 480B'],
      ['maverick', 'Llama 4 Maverick'],
      ['qwen3-next', 'Qwen3 Next 80B Thinking'],
      ['nemotron', 'Nemotron Ultra'],
    ];
    function shortModelName(raw) {
      var lower = raw.toLowerCase();
      var stripped = lower.replace(/^[a-z0-9]+[/]/, '');
      for (var i = 0; i < MODEL_LOOKUP.length; i++) {
        var sc = MODEL_LOOKUP[i].shortcut;
        if (lower.indexOf(sc) !== -1 || stripped.indexOf(sc) !== -1) return MODEL_LOOKUP[i].label;
      }
      for (var j = 0; j < MODEL_ID_KEYWORDS.length; j++) {
        if (lower.indexOf(MODEL_ID_KEYWORDS[j][0]) !== -1) return MODEL_ID_KEYWORDS[j][1];
      }
      return stripped || raw;
    }

    var modelDropdown = document.getElementById('model-dropdown');
    var modelPickerBtn = document.getElementById('model-picker-btn');
    var modelPickerLabel = document.getElementById('modelPickerLabel');
    var dropdownOpen = false;

    // Track the 3 most recently selected models for a "Recent" section at
    // the top of the dropdown. Persists across webview reloads via getState.
    var MODEL_RECENT_KEY = 'franklin-recent-models';
    function getRecentModels() {
      try {
        var s = (vscode.getState && vscode.getState()) || {};
        return Array.isArray(s[MODEL_RECENT_KEY]) ? s[MODEL_RECENT_KEY] : [];
      } catch(e) { return []; }
    }
    function rememberModel(shortcut) {
      try {
        var s = (vscode.getState && vscode.getState()) || {};
        var list = Array.isArray(s[MODEL_RECENT_KEY]) ? s[MODEL_RECENT_KEY] : [];
        list = [shortcut].concat(list.filter(function(x) { return x !== shortcut; })).slice(0, 3);
        s[MODEL_RECENT_KEY] = list;
        vscode.setState && vscode.setState(s);
      } catch(e) {}
    }

    // Build a flat index: {shortcut, group, item} for fuzzy filtering.
    function flatModelIndex() {
      var flat = [];
      MODEL_LIST.forEach(function(grp) {
        grp.items.forEach(function(item) { flat.push({ group: grp.group, item: item }); });
      });
      return flat;
    }
    // Very small fuzzy matcher — substring on label+shortcut, case-insensitive.
    function matchesQuery(item, q) {
      if (!q) return true;
      q = q.toLowerCase();
      return (item.label || '').toLowerCase().indexOf(q) !== -1
          || (item.shortcut || '').toLowerCase().indexOf(q) !== -1
          || (item.desc || '').toLowerCase().indexOf(q) !== -1;
    }

    function renderModelRow(item, currentModel) {
      var row = document.createElement('div');
      row.className = 'md-item';
      if (currentModel.indexOf(item.shortcut) !== -1) row.classList.add('active');
      var name = document.createElement('span');
      name.textContent = item.label;
      row.appendChild(name);
      if (item.isNew) {
        var nw = document.createElement('span');
        nw.className = 'md-new';
        nw.textContent = 'NEW';
        row.appendChild(nw);
      }
      if (item.price) {
        var pr = document.createElement('span');
        pr.className = 'md-price';
        pr.textContent = item.price;
        row.appendChild(pr);
      } else {
        var fr = document.createElement('span');
        fr.className = 'md-free';
        fr.textContent = 'FREE';
        row.appendChild(fr);
      }
      var tip = document.createElement('div');
      tip.className = 'md-tooltip';
      var tn = document.createElement('div'); tn.className = 'md-tt-name'; tn.textContent = item.label; tip.appendChild(tn);
      var td = document.createElement('div'); td.className = 'md-tt-desc'; td.textContent = item.desc || ''; tip.appendChild(td);
      var tc = document.createElement('div'); tc.className = 'md-tt-ctx'; tc.textContent = (item.ctx || '?') + ' context window'; tip.appendChild(tc);
      row.appendChild(tip);
      row.addEventListener('mouseenter', function() {
        var rect = row.getBoundingClientRect();
        tip.style.left = (rect.right + 6) + 'px';
        tip.style.top = rect.top + 'px';
      });
      row.addEventListener('click', function() {
        closeDropdown();
        rememberModel(item.shortcut);
        vscode.postMessage({ type: 'switchModel', text: item.shortcut });
      });
      return row;
    }

    // When the active model is a routing profile (Auto / Eco / Premium)
    // the picker defaults to a single "profile active + toggle" card; the
    // user has to click the toggle to reveal the full model list and
    // actually switch to a specific model. This prevents accidental
    // fat-finger exits from routing mode. Reset to the card view every
    // time the dropdown closes, so next time they reopen they see it again.
    var ROUTING_PROFILES = {
      auto:    { label: 'Auto',    desc: 'Balanced quality and speed, recommended for most tasks.' },
      eco:     { label: 'Eco',     desc: 'Route to the cheapest capable model.' },
      premium: { label: 'Premium', desc: 'Route to the highest-quality model regardless of cost.' },
    };
    function currentRoutingProfile() {
      var label = (modelPickerLabel.textContent || '').trim().toLowerCase();
      return ROUTING_PROFILES[label] ? label : null;
    }
    var exitRoutingUI = false;

    function buildModelDropdown(query) {
      modelDropdown.textContent = '';
      var currentModel = (modelPickerLabel.textContent || '').toLowerCase();

      // ── Routing profile card (shown when current model is Auto/Eco/Premium) ──
      var profile = currentRoutingProfile();
      if (profile && !exitRoutingUI && !(query && query.trim())) {
        var card = document.createElement('div');
        card.className = 'md-profile-card';
        var hd = document.createElement('div'); hd.className = 'md-profile-hd';
        var nm = document.createElement('span'); nm.className = 'md-profile-name'; nm.textContent = ROUTING_PROFILES[profile].label;
        var tog = document.createElement('button'); tog.type = 'button'; tog.className = 'md-profile-toggle on';
        tog.setAttribute('aria-label', 'Exit ' + ROUTING_PROFILES[profile].label + ' mode');
        tog.innerHTML = '<span class="md-toggle-thumb"></span>';
        hd.appendChild(nm); hd.appendChild(tog);
        var desc = document.createElement('div'); desc.className = 'md-profile-desc';
        desc.textContent = ROUTING_PROFILES[profile].desc;
        card.appendChild(hd); card.appendChild(desc);
        tog.addEventListener('click', function(e) {
          e.stopPropagation();
          // Two-phase transition so the toggle actually animates before the
          // card disappears. Otherwise we'd rebuild the dropdown instantly
          // and the switch would just vanish (no slide, no fade).
          tog.classList.remove('on');          // thumb slides from right→left
          card.classList.add('dismissing');    // card fades + shrinks
          setTimeout(function() {
            exitRoutingUI = true;
            buildModelDropdown('');
            setTimeout(function() {
              var s = modelDropdown.querySelector('.md-search');
              if (s) try { s.focus(); } catch(err) {}
            }, 20);
          }, 220);
        });
        modelDropdown.appendChild(card);
        return; // skip search + lists while in profile-locked view
      }

      // Search bar pinned at top.
      var searchWrap = document.createElement('div');
      searchWrap.className = 'md-search-wrap';
      var searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'md-search';
      searchInput.placeholder = 'Search models…';
      searchInput.value = query || '';
      searchInput.addEventListener('input', function() {
        // Rebuild results in-place; keep focus on the input.
        buildModelDropdown(searchInput.value);
        var fresh = modelDropdown.querySelector('.md-search');
        if (fresh) { fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length); }
      });
      searchWrap.appendChild(searchInput);
      modelDropdown.appendChild(searchWrap);

      var q = (query || '').trim();

      // Recent section — only when NOT searching, and only if we have history.
      if (!q) {
        var recentIds = getRecentModels();
        var flat = flatModelIndex();
        var recentItems = recentIds
          .map(function(id) { return (flat.find(function(e) { return e.item.shortcut === id; }) || {}).item; })
          .filter(Boolean);
        if (recentItems.length > 0) {
          var rg = document.createElement('div'); rg.className = 'md-group'; rg.textContent = 'Recent';
          modelDropdown.appendChild(rg);
          recentItems.forEach(function(it) { modelDropdown.appendChild(renderModelRow(it, currentModel)); });
        }
      }

      // Groups — filtered to matching items when searching.
      var anyShown = false;
      MODEL_LIST.forEach(function(grp) {
        var matched = grp.items.filter(function(it) { return matchesQuery(it, q); });
        if (matched.length === 0) return;
        anyShown = true;
        var g = document.createElement('div');
        g.className = 'md-group';
        g.textContent = grp.group;
        modelDropdown.appendChild(g);
        matched.forEach(function(it) { modelDropdown.appendChild(renderModelRow(it, currentModel)); });
      });
      if (!anyShown && q) {
        var none = document.createElement('div');
        none.className = 'md-empty';
        none.textContent = 'No models match "' + q + '".';
        modelDropdown.appendChild(none);
      }
    }
    function openDropdown() {
      buildModelDropdown('');
      modelDropdown.classList.add('open');
      dropdownOpen = true;
      // Auto-focus the search box so the user can start typing immediately.
      setTimeout(function() {
        var s = modelDropdown.querySelector('.md-search');
        if (s) try { s.focus(); } catch(e) {}
      }, 30);
    }
    function closeDropdown() {
      modelDropdown.classList.remove('open');
      dropdownOpen = false;
      exitRoutingUI = false; // next open of picker shows the profile card again
    }
    modelPickerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (dropdownOpen) { closeDropdown(); } else { openDropdown(); }
    });
    document.addEventListener('click', function() { if (dropdownOpen) closeDropdown(); });
    modelDropdown.addEventListener('click', function(e) { e.stopPropagation(); });

    // ── Context ring ──
    var CIRC = 69.12;
    var totalInputTokens = 0;
    // Per-model context window. Keys are franklin model-id prefixes;
    // first match wins. When adding a new model to MODEL_LIST drop its
    // window here too or the ring will fall back to the 200k default.
    var MODEL_CONTEXT = [
      ['anthropic/claude-opus-4.7', 1000000],
      ['anthropic/claude-opus', 200000],
      ['anthropic/claude-sonnet', 200000],
      ['anthropic/claude-haiku', 200000],
      ['anthropic/', 200000],
      ['openai/gpt-5.4', 272000],
      ['openai/gpt-5.3', 272000],
      ['openai/gpt-5', 272000],
      ['openai/o1', 200000],
      ['openai/o3', 200000],
      ['openai/o4', 200000],
      ['openai/', 128000],
      ['google/gemini-3', 1000000],
      ['google/gemini-2.5', 1000000],
      ['google/', 1000000],
      ['xai/grok-4', 128000],
      ['xai/grok-3', 128000],
      ['xai/', 128000],
      ['deepseek/', 128000],
      ['moonshot/kimi', 200000],
      ['moonshot/', 128000],
      ['minimax/', 200000],
      ['zai/glm', 128000],
      ['nvidia/', 128000],
      ['blockrun/', 200000],
    ];
    function contextWindowFor(model) {
      if (!model) return 200000;
      for (var i = 0; i < MODEL_CONTEXT.length; i++) {
        if (model.indexOf(MODEL_CONTEXT[i][0]) === 0) return MODEL_CONTEXT[i][1];
      }
      return 200000;
    }
    var maxContext = 200000;
    var contextArc = document.getElementById('contextArc');
    var contextPctText = document.getElementById('contextPct');
    var contextRingEl = document.getElementById('context-ring');

    function updateContextRing() {
      var pct = Math.min(1, totalInputTokens / maxContext);
      contextArc.setAttribute('stroke-dashoffset', String(CIRC * (1 - pct)));
      var pctInt = Math.round(pct * 100);
      contextPctText.textContent = pctInt + '%';
      var kTokens = (totalInputTokens / 1000).toFixed(0);
      contextRingEl.title = 'Context: ' + pctInt + '% (' + kTokens + 'k / ' + (maxContext/1000) + 'k tokens)';
      if (pct > 0.85) {
        contextArc.setAttribute('stroke', 'var(--vscode-inputValidation-errorBorder, #f44)');
      } else if (pct > 0.6) {
        contextArc.setAttribute('stroke', 'var(--vscode-editorWarning-foreground, #cca700)');
      } else {
        contextArc.setAttribute('stroke', 'var(--vscode-focusBorder, #007fd4)');
      }
    }
    updateContextRing();

    function syncChromeState() {
      document.body.classList.toggle('session-busy', agentBusy);
      var stopBtn = document.getElementById('stop');
      var sendBtn = document.getElementById('send');
      var inp = document.getElementById('in');
      if (agentBusy) {
        stopBtn.classList.remove('hidden-btn');
        sendBtn.style.display = 'none';
      } else {
        stopBtn.classList.add('hidden-btn');
        sendBtn.style.display = '';
      }
      sendBtn.disabled = agentBusy;
      inp.disabled = agentBusy;
      inp.placeholder = agentBusy ? 'Generating...' : 'Plan, @ for context, / for commands';
      if (!agentBusy) {
        try { inp.focus(); } catch (e) {}
      }
    }

    function ensureInlineActivity() {
      if (!inlineActivity) {
        inlineActivity = document.createElement('div');
        inlineActivity.className = 'activity';
        inlineActivity.innerHTML = '<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="activity-text"></span>';
        log.appendChild(inlineActivity);
      }
      return inlineActivity;
    }

    function removeInlineActivity() {
      if (inlineActivity && inlineActivity.parentNode) {
        inlineActivity.parentNode.removeChild(inlineActivity);
      }
      inlineActivity = null;
    }

    function updateActivityRow() {
      // Thinking, tool, and generating states are shown inline in the workflow — only show activity row while waiting
      if (!agentBusy || activityMode !== 'waiting') {
        removeInlineActivity();
        syncChromeState();
        return;
      }
      var el = ensureInlineActivity();
      el.classList.remove('thinking', 'tool', 'generating');
      var txt = el.querySelector('.activity-text');
      var model = modelPickerLabel.textContent || 'model';
      txt.textContent = 'Waiting for ' + model + '\\u2026';
      log.scrollTop = log.scrollHeight;
      syncChromeState();
    }

    var currentModelId = '';
    function applyStatus(p) {
      if (p.model != null) {
        currentModelId = p.model;
        var short = shortModelName(p.model);
        modelPickerLabel.textContent = short;
      }
    }

    function renderWelcome(info, errMsg, hasWorkspace) {
      if (!info) return;
      syncBaseBalance(info.balance);
      applyStatus({ model: info.model });
      if (info.chain) updateChainPill(info.chain);
    }

    var BT = String.fromCharCode(96); // backtick
    var BT3 = BT+BT+BT;
    var codeBlockIdx = 0;
    function renderMarkdown(text) {
      // Routing chip: *Auto → provider/model* (or Eco / Premium variants).
      // First render uses the bouncy entrance animation; subsequent renders
      // (the same chip re-painted on every streaming text delta) get the
      // -static variant so they don't keep popping each time the textarea
      // refreshes. routeChipSeen is reset per assistant turn (see
      // resetChatLog / new-step paths).
      var routeChipRe = /\\*\\s*(Auto|Eco|Premium|Free)\\s*[→\\-]+\\s*([A-Za-z0-9._\\/-]+)\\*/g;
      text = text.replace(routeChipRe, function(_, tier, model) {
        var shortModel = String(model).replace(/^[^/]+\\//, '');
        var providerHost = String(model).split('/')[0] || '';
        var key = tier + ':' + model;
        var freshClass = routeChipSeen[key] ? ' route-chip-static' : '';
        routeChipSeen[key] = true;
        return '<span class="route-chip route-tier-' + tier.toLowerCase() + freshClass + '">' +
          '<span class="route-spark"></span>' +
          '<span class="route-tier">' + tier + '</span>' +
          '<svg class="route-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>' +
          '<span class="route-model" title="' + escHtml(model) + '"><span class="route-provider">' + escHtml(providerHost) + '</span>' + (shortModel !== model ? '<span class="route-slash">/</span><span class="route-modelname">' + escHtml(shortModel) + '</span>' : '') + '</span>' +
        '</span>';
      });
      // Code blocks → wrapped in .code-block with header + copy button
      var codeBlockRe = new RegExp(BT3+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT3, 'g');
      text = text.replace(codeBlockRe, function(_, lang, code) {
        var id = 'cb-' + (codeBlockIdx++);
        var langLabel = lang || 'code';
        return '<div class="code-block"><div class="code-header"><span class="code-lang">' + langLabel + '</span><button class="code-copy" data-code-id="' + id + '"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" stroke="currentColor" stroke-width="1.5"/></svg> Copy</button></div><pre><code id="' + id + '">' + code + '</code></pre></div>';
      });
      // Inline code
      var inlineRe = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
      text = text.replace(inlineRe, '<code>$1</code>');
      // Bold
      text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      // Bullet lists: lines starting with - or *
      text = text.replace(/(?:^|\\n)[\\-\\*] (.+)/g, '<br>\\u2022 $1');
      // Line breaks (but not inside pre — handled by pre's white-space)
      text = text.replace(/\\n/g, '<br>');
      return text;
    }
    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Delegate click for code-copy buttons
    document.addEventListener('click', function(e) {
      var btn = (e.target && e.target.closest) ? e.target.closest('.code-copy') : null;
      if (!btn) return;
      var codeId = btn.getAttribute('data-code-id');
      var codeEl = codeId ? document.getElementById(codeId) : null;
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent || '');
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!';
        setTimeout(function() {
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" stroke="currentColor" stroke-width="1.5"/></svg> Copy';
        }, 1500);
      }
    });

    function appendLine(className, text, modelName) {
      const d = document.createElement('div');
      d.className = className;
      if (className === 'user') {
        var bubble = document.createElement('span');
        bubble.className = 'bubble';
        bubble.textContent = text;
        d.appendChild(bubble);
      } else if (className === 'assistant') {
        var content = document.createElement('div');
        content.className = 'msg-content';
        try {
          content.innerHTML = renderMarkdown(escHtml(text));
        } catch(err) {
          content.textContent = text;
        }
        d.appendChild(content);
        d.appendChild(createMsgActions(text, modelName || ''));
      } else {
        d.textContent = text;
      }
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      refreshHasMessages();
    }

    function renderAskUser(question, options) {
      var card = document.createElement('div');
      card.className = 'ask-user-card';
      var q = document.createElement('div');
      q.className = 'ask-user-question';
      q.textContent = question;
      card.appendChild(q);
      var replied = false;
      function reply(answer) {
        if (replied) return;
        replied = true;
        vscode.postMessage({ type: 'askUserReply', text: answer });
        card.style.opacity = '0.5';
        Array.prototype.forEach.call(card.querySelectorAll('button,input'), function(el) { el.disabled = true; });
        var ans = document.createElement('div');
        ans.style.fontSize = '11px';
        ans.style.marginTop = '6px';
        ans.style.color = 'var(--vscode-descriptionForeground)';
        ans.textContent = 'You: ' + (answer || '(dismissed)');
        card.appendChild(ans);
      }
      if (options && options.length > 0) {
        var row = document.createElement('div');
        row.className = 'ask-user-options';
        options.forEach(function(opt, i) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ask-user-btn' + (i === 0 ? '' : ' secondary');
          btn.textContent = opt;
          btn.addEventListener('click', function() { reply(opt); });
          row.appendChild(btn);
        });
        card.appendChild(row);
      } else {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'ask-user-input';
        inp.placeholder = 'Type answer and press Enter…';
        inp.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); reply(inp.value.trim()); }
        });
        card.appendChild(inp);
        setTimeout(function() { try { inp.focus(); } catch(e) {} }, 50);
      }
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
      refreshHasMessages();
    }

    function renderMediaPreview(kind, src, filePath) {
      var wrap = document.createElement('div');
      wrap.className = 'media-preview';
      var el;
      if (kind === 'video') {
        // Videos render full-size — autoplay is off so memory cost is low,
        // and a thumb would be misleading (user usually wants to play).
        el = document.createElement('video');
        el.controls = true;
        // Explicitly ensure unmuted — some VS Code webview sandboxes start
        // <video> at muted=true by default which silently swallows audio.
        el.muted = false;
        el.volume = 1.0;
        el.preload = 'metadata';
        el.src = src;
      } else {
        // Images render as a constrained thumbnail (max 240×200) to avoid
        // webview jank from inline-decoding multi-MB PNGs. Click to open
        // a fullscreen lightbox at native resolution.
        el = document.createElement('img');
        el.className = 'media-thumb';
        el.src = src;
        el.alt = filePath || 'generated image';
        el.title = 'Click to enlarge';
        el.addEventListener('click', function() { openLightbox(src, filePath); });
      }
      wrap.appendChild(el);
      if (filePath) {
        var footer = document.createElement('div');
        footer.className = 'media-preview-footer';
        var pathEl = document.createElement('div');
        pathEl.className = 'media-preview-path';
        pathEl.textContent = filePath;
        footer.appendChild(pathEl);
        // Open externally — VS Code webviews sometimes route audio through
        // a sandbox that drops it (most reproducible with .mp4 from
        // remote URIs). Opening in the OS default player is the reliable
        // fallback and also lets users save / share the file.
        var openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'media-preview-open';
        openBtn.textContent = 'Open externally';
        openBtn.title = 'Open in the system default player';
        openBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'openExternal', text: filePath });
        });
        footer.appendChild(openBtn);
        wrap.appendChild(footer);
      }
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      refreshHasMessages();
    }

    function renderEditDiff(file, oldLines, newLines, count) {
      oldLines = oldLines || []; newLines = newLines || [];
      var card = document.createElement('div');
      card.className = 'edit-diff-card';
      card.setAttribute('data-file', file || '');

      // Header — file basename + change count + action buttons.
      var hd = document.createElement('div');
      hd.className = 'edit-diff-hd';
      var titleWrap = document.createElement('div');
      titleWrap.className = 'edit-diff-title';
      var pencil = document.createElement('span');
      pencil.className = 'edit-diff-icon';
      pencil.textContent = '✎';
      var nameEl = document.createElement('span');
      nameEl.className = 'edit-diff-name';
      var basename = (file || '').split('/').pop() || file || 'file';
      nameEl.textContent = basename;
      var countEl = document.createElement('span');
      countEl.className = 'edit-diff-count';
      countEl.textContent = (count > 0 ? '+' : '') + count + ' line' + (Math.abs(count) === 1 ? '' : 's');
      titleWrap.appendChild(pencil); titleWrap.appendChild(nameEl); titleWrap.appendChild(countEl);
      var btnWrap = document.createElement('div');
      btnWrap.className = 'edit-diff-actions';
      var openBtn = document.createElement('button');
      openBtn.type = 'button'; openBtn.className = 'edit-diff-open';
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'openFile', text: file });
      });
      var revertBtn = document.createElement('button');
      revertBtn.type = 'button'; revertBtn.className = 'edit-diff-revert';
      revertBtn.textContent = 'Revert';
      revertBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'revertEdit', text: file });
      });
      btnWrap.appendChild(openBtn); btnWrap.appendChild(revertBtn);
      hd.appendChild(titleWrap); hd.appendChild(btnWrap);
      card.appendChild(hd);

      // Body — unified diff view. Simple: show all removed lines then all
      // added lines. No hunk alignment (we don't have line numbers), which
      // matches how the ink UI displays it too.
      var body = document.createElement('pre');
      body.className = 'edit-diff-body';
      oldLines.forEach(function(line) {
        var row = document.createElement('div');
        row.className = 'edit-diff-line edit-diff-del';
        row.textContent = '- ' + line;
        body.appendChild(row);
      });
      newLines.forEach(function(line) {
        var row = document.createElement('div');
        row.className = 'edit-diff-line edit-diff-add';
        row.textContent = '+ ' + line;
        body.appendChild(row);
      });
      card.appendChild(body);

      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
      refreshHasMessages();
    }

    function createMsgActions(text, modelName) {
      var bar = document.createElement('div');
      bar.className = 'msg-actions';
      // Copy
      var copyBtn = document.createElement('button');
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" stroke="currentColor" stroke-width="1.5"/></svg>';
      copyBtn.addEventListener('click', function() {
        navigator.clipboard.writeText(text);
        copyBtn.classList.add('active');
        setTimeout(function() { copyBtn.classList.remove('active'); }, 1500);
      });
      bar.appendChild(copyBtn);
      // Thumbs up
      var upBtn = document.createElement('button');
      upBtn.title = 'Good response';
      upBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M5 14H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2m0 7V7m0 7h6.3a2 2 0 0 0 2-1.7l.7-4.3a1 1 0 0 0-1-1.2H10V3.5A1.5 1.5 0 0 0 8.5 2L5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      upBtn.addEventListener('click', function() { upBtn.classList.toggle('active'); });
      bar.appendChild(upBtn);
      // Thumbs down
      var downBtn = document.createElement('button');
      downBtn.title = 'Bad response';
      downBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11 2h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2m0-7v7m0-7H4.7a2 2 0 0 0-2 1.7L2 8.3a1 1 0 0 0 1 1.2H6v3.2a1.5 1.5 0 0 0 1.5 1.5L11 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      downBtn.addEventListener('click', function() { downBtn.classList.toggle('active'); });
      bar.appendChild(downBtn);
      // Model name
      var modelSpan = document.createElement('span');
      modelSpan.className = 'msg-model';
      modelSpan.textContent = modelName !== undefined ? modelName : (modelPickerLabel.textContent || '');
      bar.appendChild(modelSpan);
      return bar;
    }

    // ── Workflow helpers ──
    function startOrGetTurnWf() {
      if (!currentTurnWf) {
        currentTurnWf = document.createElement('div');
        currentTurnWf.className = 'wf-turn';
        log.appendChild(currentTurnWf);
        refreshHasMessages();
      }
      return currentTurnWf;
    }
    function addWfStep(type) {
      var turn = startOrGetTurnWf();
      var step = document.createElement('div');
      step.className = 'wf-step ' + type;
      var dot = document.createElement('div');
      dot.className = 'wf-dot';
      step.appendChild(dot);
      var body = document.createElement('div');
      body.className = 'wf-body';
      step.appendChild(body);
      turn.appendChild(step);
      return { step: step, body: body };
    }
    function commitThinking() {
      if (currentThinkingStep) {
        var tText = currentThinkingStep.querySelector('.wf-thinking-text');
        if (tText && thinkingBuf.trim()) tText.innerHTML = renderMarkdown(escHtml(thinkingBuf.trim()));
        // Update header: hide dots, show elapsed time
        var dots = currentThinkingStep.querySelector('.wf-think-dots');
        if (dots) dots.classList.add('done');
        var label = currentThinkingStep.querySelector('.wf-thinking-label');
        if (label && thinkStartTime) {
          var elapsed = ((Date.now() - thinkStartTime) / 1000).toFixed(1);
          label.textContent = 'Thought for ' + elapsed + 's';
        }
        currentThinkingStep = null;
      }
      thinkingBuf = '';
      thinkStartTime = 0;
      currentToolGroup = null; // thinking interrupts consecutive tool groups
    }
    function makeGroupItem(preview) {
      var item = document.createElement('div');
      item.className = 'wf-group-item';
      if (preview) {
        var f = document.createElement('span');
        f.className = 'wf-tool-file';
        f.textContent = preview;
        item.appendChild(f);
      }
      var r = document.createElement('div');
      r.className = 'wf-tool-result';
      item.appendChild(r);
      return { itemEl: item, resultEl: r };
    }

    function addToolStepWf(id, name, preview) {
      commitThinking();

      // ── Case B: same tool name — group it ──
      if (currentToolGroup && currentToolGroup.name === name) {
        var grp = currentToolGroup;
        grp.items.push(id);

        // On the 2nd call: upgrade single step → group UI
        if (grp.items.length === 2) {
          // Build group header (replaces the inline tool line)
          var oldLine = grp.groupStepEl.querySelector('.wf-tool-line');
          if (oldLine) {
            var gh = document.createElement('div');
            gh.className = 'wf-group-header';
            var gArrow = document.createElement('span');
            gArrow.className = 'wf-arrow';
            gArrow.innerHTML = '&#8250;';
            var gName = document.createElement('span');
            gName.className = 'wf-tool-name';
            gName.textContent = name;
            var gCount = document.createElement('span');
            gCount.className = 'wf-group-count';
            gCount.textContent = '(2)';
            gh.appendChild(gArrow);
            gh.appendChild(gName);
            gh.appendChild(gCount);
            grp.countEl = gCount;
            // Create sub-list and move original item into it
            var gList = document.createElement('div');
            gList.className = 'wf-group-list';
            var firstItem = makeGroupItem(oldLine.querySelector('.wf-tool-file') ? oldLine.querySelector('.wf-tool-file').textContent : '');
            // reroute existing toolStepMap entry to the new resultEl
            var firstId = grp.items[0];
            if (toolStepMap[firstId]) toolStepMap[firstId].resultEl = firstItem.resultEl;
            gList.appendChild(firstItem.itemEl);
            grp.subListEl = gList;
            // Replace old line with group header + list
            grp.groupStepEl.querySelector('.wf-body').replaceChild(gh, oldLine);
            // Remove old resultDiv (was after oldLine)
            var oldResult = grp.groupStepEl.querySelector('.wf-tool-result');
            if (oldResult) oldResult.parentNode.removeChild(oldResult);
            grp.groupStepEl.querySelector('.wf-body').appendChild(gList);
            // Toggle on click
            (function(stepEl) {
              gh.addEventListener('click', function() { stepEl.classList.toggle('open'); });
            })(grp.groupStepEl);
          }
        } else {
          // 3rd+ item: just update count
          if (grp.countEl) grp.countEl.textContent = '(' + grp.items.length + ')';
        }

        // Add new item to the sub-list
        var newItem = makeGroupItem(preview);
        grp.subListEl.appendChild(newItem.itemEl);
        toolStepMap[id] = { step: grp.groupStepEl, resultEl: newItem.resultEl };
        // Keep group step active while tools still running
        grp.groupStepEl.classList.add('tool-active');
        log.scrollTop = log.scrollHeight;
        return;
      }

      // ── Case A: new tool or different name ──
      currentToolGroup = null;
      var els = addWfStep('tool tool-active');
      var line = document.createElement('div');
      line.className = 'wf-tool-line';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'wf-tool-name';
      nameSpan.textContent = name;
      line.appendChild(nameSpan);
      if (preview) {
        var fileSpan = document.createElement('span');
        fileSpan.className = 'wf-tool-file';
        fileSpan.textContent = preview;
        line.appendChild(fileSpan);
      }
      els.body.appendChild(line);
      var resultDiv = document.createElement('div');
      resultDiv.className = 'wf-tool-result';
      els.body.appendChild(resultDiv);
      toolStepMap[id] = { step: els.step, resultEl: resultDiv };
      currentToolGroup = { name: name, groupStepEl: els.step, countEl: null, subListEl: null, items: [id] };
      log.scrollTop = log.scrollHeight;
    }
    function finishToolStepWf(id, success, result) {
      var entry = toolStepMap[id];
      if (!entry) return;
      if (result && entry.resultEl) entry.resultEl.textContent = result;
      if (!success) {
        var dot = entry.step.querySelector('.wf-dot');
        if (dot) dot.style.background = 'var(--vscode-inputValidation-errorBorder, #f44)';
      }
      delete toolStepMap[id];
      // Remove tool-active only when no more pending tools on this step
      var stillActive = Object.values(toolStepMap).some(function(e) { return e.step === entry.step; });
      if (!stillActive) entry.step.classList.remove('tool-active');
      log.scrollTop = log.scrollHeight;
    }
    function getOrCreateTextStepWf() {
      if (!wfTextStep) {
        commitThinking();
        var els = addWfStep('text');
        var contentDiv = document.createElement('div');
        contentDiv.className = 'wf-text-body assistant msg-content';
        els.body.appendChild(contentDiv);
        wfTextStep = { step: els.step, body: els.body, content: contentDiv };
        assistantEl = els.step; // keep legacy ref in sync
      }
      return wfTextStep;
    }
    function flushTextStepWf() {
      if (wfTextStep && assistantBuf) {
        var mc = wfTextStep.content;
        if (mc) {
          mc.innerHTML = renderMarkdown(escHtml(assistantBuf));
          mc.classList.remove('streaming'); // streaming done — stop the caret
        }
        if (!wfTextStep.step.querySelector('.msg-actions')) {
          wfTextStep.body.appendChild(createMsgActions(assistantBuf, streamingModelName));
        }
      }
      wfTextStep = null;
      assistantBuf = '';
      assistantEl = null;
    }

    function flushAssistant() {
      if (assistantEl && assistantBuf) {
        var mc = assistantEl.querySelector('.msg-content');
        if (mc) mc.innerHTML = renderMarkdown(escHtml(assistantBuf));
        // Add action bar on completion
        if (!assistantEl.querySelector('.msg-actions')) {
          assistantEl.appendChild(createMsgActions(assistantBuf, streamingModelName));
        }
      }
      assistantBuf = '';
      assistantEl = null;
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'historyList') {
        renderHistoryList(m.items);
        return;
      }
      if (m.type === 'lastSession' && m.session) {
        showResumeBanner(m.session);
        return;
      }
      if (m.type === 'doctorResults') {
        renderDoctorResults(m.checks || [], m.error);
        return;
      }
      if (m.type === 'insightsData') {
        renderInsights(m.data, m.error);
        return;
      }
      if (m.type === 'tasksData') {
        renderTasks(m.tasks || [], m.error);
        return;
      }
      if (m.type === 'taskLogData') {
        if (m.error) {
          showToast('Task log error: ' + m.error, 'warning');
        } else {
          renderTaskLog(m.runId, m.log);
        }
        return;
      }
      if (m.type === 'taskCancelResult') {
        if (m.ok) showToast('Cancel signal sent', 'info', 2500);
        else showToast('Cancel failed: ' + (m.reason || 'unknown'), 'warning');
        vscode.postMessage({ type: 'loadTasks' });
        return;
      }
      if (m.type === 'taskDeleteResult') {
        if (m.ok) showToast('Task deleted', 'info', 2000);
        else showToast('Delete failed: ' + (m.reason || 'unknown'), 'warning');
        return;
      }
      if (m.type === 'tasksPruneResult') {
        if (m.error) {
          showToast('Prune failed: ' + m.error, 'warning');
        } else {
          var msg = 'Deleted ' + (m.deleted || 0) + ' task' + ((m.deleted === 1) ? '' : 's');
          if (m.skipped) msg += ' (' + m.skipped + ' kept — too recent or still running)';
          showToast(msg, 'info', 3000);
        }
        return;
      }
      if (m.type === 'sandboxesData') {
        renderSandboxes(m.sandboxes || [], m.error);
        return;
      }
      if (m.type === 'sandboxesCleanup') {
        if (m.error) {
          showToast('Cleanup failed: ' + m.error, 'warning');
        } else {
          var msg = 'Terminated ' + (m.succeeded || 0) + '/' + (m.attempted || 0) + ' sandboxes';
          if (m.failed && m.failed.length) msg += ', ' + m.failed.length + ' failed';
          showToast(msg, m.failed && m.failed.length ? 'warning' : 'info');
        }
        return;
      }
      if (m.type === 'importCandidates') {
        renderImportCandidates(m.source, m.candidates || [], m.error);
        return;
      }
      if (m.type === 'importDone') {
        if (m.error) {
          importBody.innerHTML = '<div class="check-row"><span class="check-detail" style="color:var(--vscode-inputValidation-errorForeground,#f44)">Import failed: ' + m.error + '</span></div>';
          showToast('Import failed: ' + m.error, 'warning');
        } else {
          importOverlay.classList.add('hidden');
          showToast('Imported session — continuing the conversation', 'info');
        }
        return;
      }
      if (m.type === 'walletQrData') {
        if (m.error) {
          if (walletQrSvg) walletQrSvg.innerHTML = '';
          if (walletQrHost) walletQrHost.classList.remove('open');
          if (walletQrCaption) walletQrCaption.textContent = m.error;
        } else {
          if (walletQrSvg && m.svg) walletQrSvg.innerHTML = m.svg;
          if (walletQrHost) walletQrHost.classList.add('open');
          if (walletPopAddr && m.address) walletPopAddr.textContent = m.address;
          if (walletPopChain && m.chain) walletPopChain.textContent = m.chain;
          if (walletPopBalance) {
            var live = computeLiveBalance();
            walletPopBalance.textContent = live || '—';
          }
          if (walletQrCaption) {
            walletQrCaption.textContent = m.chain === 'solana'
              ? 'Scan with Phantom / Solflare to send USDC SPL.'
              : 'Scan with MetaMask / Coinbase to send USDC on Base.';
          }
          walletQrLoaded = true;
        }
        return;
      }
      if (m.type === 'loadHistory') {
        resetChatLog();
        showChat(m.title || 'History');
        (m.messages || []).forEach(function(msg) {
          if (msg.text) {
            appendLine(msg.role === 'user' ? 'user' : 'assistant', msg.text);
          }
          // Re-render any media generated during this turn so history
          // looks the same as the live session — preview cards inline,
          // not just text. mediaPaths comes pre-resolved with webview URIs.
          if (msg.mediaPaths && msg.mediaPaths.length > 0) {
            msg.mediaPaths.forEach(function(mp) {
              renderMediaPreview(mp.kind, mp.src, mp.path);
            });
          }
        });
        return;
      }
      if (m.type === 'loadingStep') {
        var ls = document.getElementById('loading-step');
        if (ls) ls.textContent = m.text;
        return;
      }
      if (m.type === 'welcome') {
        var ls2 = document.getElementById('loading-step');
        if (ls2) ls2.style.display = 'none';
        renderWelcome(m.info, null, m.hasWorkspace !== false);
        // Initial tasks check so the active-task badge renders if there
        // are leftover detached jobs from a prior session.
        vscode.postMessage({ type: 'loadTasks' });
        // Same for sandboxes — though tracker is in-memory and resets
        // on extension reload, so this is mostly a no-op until the
        // current agent session creates one.
        vscode.postMessage({ type: 'loadSandboxes' });
        return;
      }
      if (m.type === 'status' && m.partial) {
        if (m.partial.balance) syncBaseBalance(m.partial.balance);
        if (m.partial.chain) updateChainPill(m.partial.chain);
        // Wallet QR is chain-dependent — invalidate cache so the next
        // popover open re-fetches the right payload.
        if (m.partial.chain || m.partial.walletAddress) walletQrLoaded = false;
        applyStatus(m.partial);
        return;
      }
      if (m.type === 'settingsData') {
        updateChainPill(m.current.chain);
        setChainToggleActive(m.current.chain);
        populateModelSelect(settingsImgSel, m.imageModels, m.current['default-image-model']);
        populateModelSelect(settingsVidSel, m.videoModels, m.current['default-video-model']);
        return;
      }
      if (m.type === 'settingsSaved') {
        if (settingsStatusEl) {
          settingsStatusEl.textContent = 'Saved';
          setTimeout(function() { if (settingsStatusEl) settingsStatusEl.textContent = ''; }, 1500);
        }
        return;
      }
      if (m.type === 'welcomeError') {
        renderWelcome(null, m.message);
        return;
      }
      if (m.type === 'askUser') {
        renderAskUser(m.question || '', m.options || []);
        return;
      }
      if (m.type === 'mediaPreview') {
        renderMediaPreview(m.kind, m.src, m.path);
        return;
      }
      if (m.type === 'editDiff') {
        renderEditDiff(m.file, m.oldLines, m.newLines, m.count);
        return;
      }
      if (m.type === 'editReverted') {
        var cards = document.querySelectorAll('.edit-diff-card[data-file="' + (m.file || '').replace(/"/g, '&quot;') + '"]');
        Array.prototype.forEach.call(cards, function(card) {
          card.classList.add('reverted');
          var btn = card.querySelector('.edit-diff-revert');
          if (btn) { btn.disabled = true; btn.textContent = 'Reverted'; }
        });
        return;
      }
      if (m.type === 'stopAck') {
        appendLine(
          'meta',
          m.hadAbort
            ? 'Stop \\u2014 cancelling in-flight request\\u2026'
            : 'Stop \\u2014 nothing was running.'
        );
        return;
      }
      if (m.type === 'error') {
        agentBusy = false;
        updateActivityRow();
        appendLine('meta', 'Error: ' + m.message);
        return;
      }
      if (m.type === 'sessionEnded') {
        agentBusy = false;
        updateActivityRow();
        status.textContent = 'Session ended. Reopen the side bar to start again.';
        return;
      }
      if (m.type === 'sessionReset') {
        // Adopt the new generation; any further events tagged with an older
        // gen are discarded by the guard below. Belt-and-suspenders against
        // late-arriving events from an aborted loop bleeding into a freshly
        // cleared chat.
        if (typeof m.gen === 'number') currentSessionGen = m.gen;
        return;
      }
      if (m.type !== 'event' || !m.event) return;
      // Discard events from a stale (aborted) session generation. Without
      // this guard, in-flight LLM stream events from the old loop arrive
      // AFTER the user clicks "+", and paint old content into the new
      // empty chat.
      if (typeof m.gen === 'number' && m.gen < currentSessionGen) return;
      const ev = m.event;
      switch (ev.kind) {
        case 'text_delta':
          if (!wfTextStep) streamingModelName = modelPickerLabel.textContent || '';
          assistantBuf += ev.text;
          var ts = getOrCreateTextStepWf();
          if (ts.content) {
            ts.content.innerHTML = renderMarkdown(escHtml(assistantBuf));
            ts.content.classList.add('streaming'); // enables blinking caret
          }
          log.scrollTop = log.scrollHeight;
          activityMode = 'generating';
          updateActivityRow();
          refreshHasMessages();
          break;
        case 'thinking_delta':
          thinkingBuf += ev.text || '';
          if (!currentThinkingStep) {
            thinkStartTime = Date.now();
            var thinkEls = addWfStep('thinking');
            thinkEls.body.innerHTML =
              '<div class="wf-thinking-header">' +
                '<span class="wf-arrow">&#8250;</span>' +
                '<span class="wf-thinking-label">Thinking</span>' +
                '<span class="wf-think-dots"><span></span><span></span><span></span></span>' +
              '</div>' +
              '<div class="wf-thinking-detail"><div class="wf-thinking-text assistant"></div></div>';
            (function(stepEl) {
              stepEl.querySelector('.wf-thinking-header').addEventListener('click', function() {
                stepEl.classList.toggle('open');
              });
            })(thinkEls.step);
            currentThinkingStep = thinkEls.step;
          }
          var tTextEl = currentThinkingStep.querySelector('.wf-thinking-text');
          if (tTextEl) tTextEl.innerHTML = renderMarkdown(escHtml(thinkingBuf.trim()));
          activityMode = 'thinking';
          updateActivityRow();
          log.scrollTop = log.scrollHeight;
          break;
        case 'capability_start':
          flushTextStepWf();
          activityMode = 'tool';
          toolNameStr = ev.name;
          addToolStepWf(ev.id || ev.name, ev.name, ev.preview || '');
          updateActivityRow();
          break;
        case 'capability_progress':
          var activeKeys = Object.keys(toolStepMap);
          if (activeKeys.length > 0 && ev.text) {
            var activeEntry = toolStepMap[activeKeys[activeKeys.length - 1]];
            if (activeEntry && activeEntry.resultEl) {
              activeEntry.resultEl.textContent = String(ev.text).slice(0, 100);
            }
          }
          break;
        case 'capability_done':
          activityMode = 'waiting';
          // ev.result is a CapabilityResult OBJECT — { output, isError, ... }.
          // Stringifying the object yields "[object Object]"; we want the
          // .output text. Fall back to a status word if the field is missing.
          var doneOutput = ev.result && typeof ev.result === 'object'
            ? (typeof ev.result.output === 'string' ? ev.result.output : '')
            : (typeof ev.result === 'string' ? ev.result : '');
          var doneResult = doneOutput.slice(0, 120);
          var doneIsError = !!(ev.error || (ev.result && ev.result.isError));
          finishToolStepWf(ev.id || toolNameStr, !doneIsError, doneResult);
          updateActivityRow();
          break;
        case 'prefetch_start':
          var pfEl = document.getElementById('prefetch-indicator');
          if (pfEl) {
            pfEl.textContent = 'Fetching live ' + (ev.assetClass === 'stock' ? 'stock' : 'market') + ' data for ' + ev.symbol + '…';
            pfEl.style.display = 'flex';
          }
          break;
        case 'turn_done':
          var pfEl2 = document.getElementById('prefetch-indicator');
          if (pfEl2) pfEl2.style.display = 'none';
          flushTextStepWf();
          commitThinking();
          currentTurnWf = null;
          currentThinkingStep = null;
          currentToolGroup = null;
          agentBusy = false;
          updateActivityRow();
          if (ev.reason === 'aborted') {
            appendLine('meta', '\\u2014 Stopped.');
          } else if (ev.reason === 'error' && ev.error) {
            // Rate-limit / 429: show friendly toast instead of red error inline.
            // Other errors fall through to existing handling below.
            if (maybeShowRateLimitToast(ev.error)) {
              // Suppress the verbose stack-trace meta line — toast covers it.
              status.textContent = '';
              break;
            }
          }
          // Periodic refresh of task + sandbox badges — completed agent
          // turns are a natural moment to recheck for newly-spawned
          // background tasks AND newly-created Modal sandboxes.
          vscode.postMessage({ type: 'loadTasks' });
          vscode.postMessage({ type: 'loadSandboxes' });
          status.textContent = '';
          break;
        case 'status_update':
          applyStatus({ model: ev.model });
          break;
        case 'usage':
          if (typeof ev.cost === 'number') sessionCost += ev.cost;
          var liveBal = computeLiveBalance();
          // Preserve the user's explicit model choice — if they picked Auto
          // (or Eco / Premium), the picker label stays on that profile
          // instead of flipping to whichever model the router resolved for
          // this turn. Mirrors the v3.8.32 CLI fix.
          var labelNow = (modelPickerLabel.textContent || '').trim().toLowerCase();
          var userInRoutingMode = labelNow === 'auto' || labelNow === 'eco' || labelNow === 'premium';
          if (userInRoutingMode) {
            applyStatus({ balance: liveBal });
          } else {
            applyStatus({ model: ev.model, balance: liveBal });
          }
          // Update model name on the current assistant message's action bar
          if (ev.model && wfTextStep) {
            var mSpan = wfTextStep.step.querySelector('.msg-model');
            if (mSpan) mSpan.textContent = shortModelName(ev.model);
          }
          // Re-target the ring's denominator to whichever model just
          // reported usage — otherwise Opus 4.7 / Gemini sessions
          // (1M window) read as "always near full" against the 200k
          // default.
          if (ev.model) {
            var winNow = contextWindowFor(ev.model);
            if (winNow !== maxContext) maxContext = winNow;
          }
          if (typeof ev.contextPct === 'number') {
            // Trust the agent's anchored context calculation
            // (getAnchoredTokenCount(history) — already accounts for
            // prompt caching and history aging). The authoritative
            // "how full is the model's context now" measure.
            totalInputTokens = Math.round((ev.contextPct / 100) * maxContext);
            updateContextRing();
          } else if (typeof ev.inputTokens === 'number') {
            // Fallback for events without contextPct.
            // CRITICAL: assign, do NOT accumulate. input_tokens per turn
            // is the FULL prompt size that turn (= current context).
            // Accumulating across turns multi-counted the same history;
            // a 2-image chat could appear to use 170k tokens.
            totalInputTokens = ev.inputTokens;
            updateContextRing();
          }
          break;
        default:
          break;
      }
    });

    // ── Slash command menu ──
    // Synced with Franklin/src/agent/commands.ts. Curated for the chat
    // UI — slash commands that only make sense in the CLI terminal are
    // omitted, but everything a user would reasonably reach for in a
    // GUI session is here.
    var SLASH_CMDS = [
      // Session
      { cmd: '/clear',    desc: 'Clear the current chat log' },
      { cmd: '/new',      desc: 'Start a new conversation' },
      { cmd: '/history',  desc: 'Browse conversation history' },
      { cmd: '/sessions', desc: 'List saved sessions' },
      { cmd: '/resume',   desc: 'Resume a saved session by id' },
      { cmd: '/compact',  desc: 'Compact conversation to free context' },
      { cmd: '/context',  desc: 'Show context-window usage' },
      { cmd: '/tokens',   desc: 'Show detailed token breakdown' },
      { cmd: '/cost',     desc: 'Show session cost so far' },
      { cmd: '/status',   desc: 'Show session status + wallet' },
      // Model / mode
      { cmd: '/model',     desc: 'Switch the active model' },
      { cmd: '/plan',      desc: 'Enter plan mode (read-only tools)' },
      { cmd: '/execute',   desc: 'Exit plan mode, enable all tools' },
      { cmd: '/ultrathink',desc: 'Toggle extended-reasoning mode' },
      { cmd: '/retry',     desc: 'Retry the last turn with same input' },
      // Generation
      { cmd: '/image',    desc: 'Generate an image (agent picks model + cost)' },
      { cmd: '/video',    desc: 'Generate a video (agent picks model + cost)' },
      // Git / dev workflow
      { cmd: '/diff',     desc: 'Show current git diff' },
      { cmd: '/commit',   desc: 'Stage relevant changes and commit' },
      { cmd: '/push',     desc: 'Push current branch to remote' },
      { cmd: '/pr',       desc: 'Open a pull request for current branch' },
      { cmd: '/review',   desc: 'Code-review the current diff' },
      { cmd: '/test',     desc: 'Run the project test suite' },
      { cmd: '/fix',      desc: 'Investigate and fix the most recent error' },
      { cmd: '/debug',    desc: 'Diagnose the most recent error' },
      { cmd: '/init',     desc: 'Summarize project structure + entry points' },
      { cmd: '/todo',     desc: 'Find all TODO / FIXME / HACK comments' },
      { cmd: '/deps',     desc: 'List key project dependencies' },
      { cmd: '/lint',     desc: 'Check code quality + suggest improvements' },
      { cmd: '/optimize', desc: 'Find performance issues + recommendations' },
      { cmd: '/security', desc: 'Audit codebase for security issues' },
      { cmd: '/clean',    desc: 'Find + remove dead code' },
      { cmd: '/undo',     desc: 'Undo the last agent action' },
      // Tools / system
      { cmd: '/tasks',    desc: 'List background tasks' },
      { cmd: '/mcp',      desc: 'List connected MCP servers' },
      { cmd: '/doctor',   desc: 'Run system health check' },
      { cmd: '/failures', desc: 'Show recent provider failures' },
      { cmd: '/dump',     desc: 'Dump current system prompt' },
      { cmd: '/version',  desc: 'Show Franklin version' },
      { cmd: '/bug',      desc: 'Report a bug with session context' },
      { cmd: '/help',     desc: 'List all commands' },
      { cmd: '/stop',     desc: 'Stop the current generation' }
    ];
    var slashMenu = document.getElementById('slash-menu');
    var slashSelected = -1;
    var slashVisible = [];

    function openSlashMenu(filter) {
      var q = filter.toLowerCase();
      slashVisible = SLASH_CMDS.filter(function(c) { return c.cmd.indexOf(q) === 0; });
      if (slashVisible.length === 0) { closeSlashMenu(); return; }
      slashMenu.textContent = '';
      slashSelected = 0;
      slashVisible.forEach(function(c, i) {
        var row = document.createElement('div');
        row.className = 'slash-item' + (i === 0 ? ' selected' : '');
        var cmdSpan = document.createElement('span');
        cmdSpan.className = 'slash-cmd';
        cmdSpan.textContent = c.cmd;
        var descSpan = document.createElement('span');
        descSpan.className = 'slash-desc';
        descSpan.textContent = c.desc;
        row.appendChild(cmdSpan);
        row.appendChild(descSpan);
        row.addEventListener('mousedown', function(e) {
          e.preventDefault(); // don't blur input
          applySlashCmd(c.cmd);
        });
        row.addEventListener('mouseenter', function() {
          slashSelected = i;
          updateSlashSelection();
        });
        slashMenu.appendChild(row);
      });
      slashMenu.classList.add('open');
    }
    function closeSlashMenu() {
      slashMenu.classList.remove('open');
      slashMenu.textContent = '';
      slashSelected = -1;
      slashVisible = [];
    }
    function updateSlashSelection() {
      var rows = slashMenu.querySelectorAll('.slash-item');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.toggle('selected', i === slashSelected);
      }
    }
    function applySlashCmd(cmd) {
      if (cmd === '/image') {
        input.value = 'Generate an image of ';
      } else if (cmd === '/video') {
        input.value = 'Generate a video of ';
      } else {
        input.value = cmd + ' ';
      }
      closeSlashMenu();
      // Resize after programmatic value set (textarea won't auto-fire 'input').
      try { autoGrowInput(); } catch(e) {}
      try { input.focus(); } catch(e) {}
    }
    function handleSlashInput() {
      var val = input.value;
      if (val.charAt(0) === '/' && val.indexOf(' ') === -1) {
        openSlashMenu(val);
      } else {
        closeSlashMenu();
      }
    }

    input.addEventListener('input', handleSlashInput);

    // Example prompts in empty state — click fills the input.
    Array.prototype.forEach.call(
      document.querySelectorAll('.example-prompt'),
      function(btn) {
        btn.addEventListener('click', function() {
          var p = btn.getAttribute('data-prompt') || '';
          input.value = p;
          try { autoGrowInput(); } catch(e) {}
          try { input.focus(); } catch(e) {}
        });
      }
    );


    // Intercept arrow/enter/esc/tab for slash menu navigation
    var _origKeydown = null;
    input.addEventListener('keydown', function(e) {
      if (!slashMenu.classList.contains('open')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashSelected = Math.min(slashSelected + 1, slashVisible.length - 1);
        updateSlashSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashSelected = Math.max(slashSelected - 1, 0);
        updateSlashSelection();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (slashSelected >= 0 && slashSelected < slashVisible.length) {
          applySlashCmd(slashVisible[slashSelected].cmd);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashMenu();
      }
    }, true); // capture phase so this fires before the send keydown

    document.addEventListener('click', function(e) {
      if (!slashMenu.classList.contains('open')) return;
      if (!slashMenu.contains(e.target) && e.target !== input) {
        closeSlashMenu();
      }
    });

    // ─── Image attachment state ───
    // pendingImages buffers images the user has pasted / dropped / picked
    // before they hit Send. Each entry is { dataURL, name }. dataURL is the
    // base64 data: URL (already vetted by handleImageFile to be image/*).
    // The strip below the composer is the canonical view onto this array.
    var pendingImages = [];
    var IMG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image, matches Read tool cap
    var imageStrip = document.getElementById('image-strip');
    var fileInput = document.getElementById('file-input');
    var attachBtn = document.getElementById('attach');

    function renderImageStrip() {
      imageStrip.innerHTML = '';
      if (pendingImages.length === 0) { imageStrip.style.display = 'none'; return; }
      imageStrip.style.display = 'flex';
      pendingImages.forEach(function (img, idx) {
        var tile = document.createElement('div');
        tile.className = 'img-tile';
        tile.title = img.name || ('image-' + (idx + 1));
        var imgEl = document.createElement('img');
        imgEl.src = img.dataURL;
        imgEl.alt = tile.title;
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'rm';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function () {
          pendingImages.splice(idx, 1);
          renderImageStrip();
        });
        tile.appendChild(imgEl);
        tile.appendChild(rm);
        imageStrip.appendChild(tile);
      });
    }

    // ─── Image normalization ───
    // 1280 long edge is slightly tighter than Anthropic's recommended
    // 1568 — chosen because BlockRun gateway has been observed to
    // truncate base64 payloads above ~1.5–2 MB. Once the gateway lifts
    // that cap (tracked in Notion TODO 2026-05-09), we can move to 1568.
    // Skip the canvas roundtrip entirely when the source already fits
    // under MAX_LONG_EDGE — re-encoding via canvas.toBlob('png') uses an
    // unoptimized encoder and frequently INFLATES well-compressed PNGs,
    // which would defeat the whole point.
    var MAX_LONG_EDGE = 1280;
    var JPEG_QUALITY = 0.85;

    function fileToDataURL(blobOrFile) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (e) { resolve(e.target && e.target.result); };
        reader.onerror = function () { reject(new Error('FileReader error')); };
        reader.readAsDataURL(blobOrFile);
      });
    }

    // Anything bigger than this gets re-encoded even if dimensions are
    // already small. AI-generated PNGs at 1024x1024 routinely come in
    // at 1.5–2 MB, which fits dimensionally but still gets truncated by
    // the BlockRun gateway. JPEG q85 typically cuts these to ~10–20%
    // of the original PNG size with no perceptible quality loss.
    var SAFE_PAYLOAD_BYTES = 800 * 1024;
    var SKIP_BELOW_BYTES = 150 * 1024; // truly tiny files: don't touch

    async function normalizeImage(file) {
      var bitmap;
      try { bitmap = await createImageBitmap(file); }
      catch (err) {
        console.warn('[franklin-img] createImageBitmap failed, falling back to original:', err);
        return await fileToDataURL(file);
      }

      var w = bitmap.width;
      var h = bitmap.height;
      var longEdge = Math.max(w, h);
      var dimensionsOk = longEdge <= MAX_LONG_EDGE;
      var sizeOk = file.size <= SAFE_PAYLOAD_BYTES;
      var trulyTiny = file.size <= SKIP_BELOW_BYTES;

      // Truly tiny → skip everything (icons, sub-150KB clipart).
      if (trulyTiny && dimensionsOk) {
        console.log('[franklin-img] skip normalize (tiny): ' + bitmap.width + 'x' + bitmap.height + ', ' + file.size + ' B');
        return await fileToDataURL(file);
      }

      // If dimensions AND size both fit, AND it's already JPEG, leave alone.
      // PNGs of that size still benefit from JPEG re-encode (5-10x smaller).
      if (dimensionsOk && sizeOk && file.type === 'image/jpeg') {
        console.log('[franklin-img] skip normalize (JPEG within budget): ' + bitmap.width + 'x' + bitmap.height + ', ' + file.size + ' B');
        return await fileToDataURL(file);
      }

      // Need to re-encode (either resize or compress or both).
      if (!dimensionsOk) {
        var scale = MAX_LONG_EDGE / longEdge;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      var canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(w, h)
        : (function () { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);

      // Decide JPEG vs PNG by actually sampling alpha. Source MIME alone
      // is misleading: most PNGs in the wild (AI-generated images, photo
      // exports, screenshots) are fully opaque and would be 5-10x smaller
      // as JPEG. Sample a handful of pixels — full scan would be too slow
      // at large sizes but we don't need certainty, just a "probably opaque".
      var hasAlpha = false;
      if (file.type !== 'image/jpeg' && file.type !== 'image/jpg') {
        try {
          // Sample a 32x32 patch from each corner + center → 5 patches,
          // 5120 alpha checks total. Fast and catches alpha around logos /
          // floating objects which is where transparency usually lives.
          var sampleSize = 32;
          var patches = [
            [0, 0],
            [w - sampleSize, 0],
            [0, h - sampleSize],
            [w - sampleSize, h - sampleSize],
            [Math.floor((w - sampleSize) / 2), Math.floor((h - sampleSize) / 2)],
          ];
          outer: for (var pi = 0; pi < patches.length; pi++) {
            var px = Math.max(0, patches[pi][0]);
            var py = Math.max(0, patches[pi][1]);
            var data = ctx.getImageData(px, py, Math.min(sampleSize, w - px), Math.min(sampleSize, h - py)).data;
            for (var i = 3; i < data.length; i += 4) {
              if (data[i] < 255) { hasAlpha = true; break outer; }
            }
          }
        } catch (sampleErr) {
          // Tainted canvas / oddball error — be safe and keep PNG.
          console.warn('[franklin-img] alpha sample failed, keeping PNG:', sampleErr);
          hasAlpha = true;
        }
      }
      var outType = hasAlpha ? 'image/png' : 'image/jpeg';

      async function encodeAs(type, quality) {
        if (canvas.convertToBlob) {
          return await canvas.convertToBlob(
            type === 'image/jpeg' ? { type: type, quality: quality } : { type: type }
          );
        }
        return await new Promise(function (resolve) {
          canvas.toBlob(resolve, type, type === 'image/jpeg' ? quality : undefined);
        });
      }

      var blob = await encodeAs(outType, JPEG_QUALITY);

      // Fallback compression — if still over budget, drop JPEG quality.
      // Only applies to JPEG path; PNG can't be quality-reduced (would need
      // lossy palette quantization which canvas doesn't expose).
      if (blob.size > SAFE_PAYLOAD_BYTES && outType === 'image/jpeg') {
        var blob2 = await encodeAs('image/jpeg', 0.7);
        if (blob2.size < blob.size) {
          console.log('[franklin-img] retried at q=0.70: ' + blob.size + ' B → ' + blob2.size + ' B');
          blob = blob2;
        }
      }

      console.log('[franklin-img] normalized: ' + file.size + ' B → ' + blob.size + ' B, ' + bitmap.width + 'x' + bitmap.height + ' → ' + w + 'x' + h + ', ' + outType);
      return await fileToDataURL(blob);
    }

    async function handleImageFile(file) {
      console.log('[franklin-img] handleImageFile', file && { name: file.name, type: file.type, size: file.size });
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        console.log('[franklin-img] reject: not an image type');
        return;
      }
      if (file.size > IMG_MAX_BYTES) {
        appendLine('user', '[image rejected: ' + (file.name || 'untitled') + ' is larger than 10 MB — please resize first]');
        return;
      }
      try {
        var dataURL = await normalizeImage(file);
        if (typeof dataURL !== 'string') {
          console.error('[franklin-img] dataURL not a string after normalize');
          return;
        }
        console.log('[franklin-img] dataURL ready, length=' + dataURL.length + ', adding to pendingImages');
        pendingImages.push({ dataURL: dataURL, name: file.name || 'pasted-image' });
        renderImageStrip();
      } catch (err) {
        console.error('[franklin-img] handleImageFile error:', err);
        appendLine('user', '[image read failed: ' + (file.name || 'untitled') + ']');
      }
    }

    // Paste — bind on BOTH textarea and document. Screenshots taken with
    // Cmd+Shift+4 → pasted from clipboard sometimes deliver as kind:'file'
    // and sometimes as kind:'string' with image/* type depending on macOS
    // version, so we accept anything whose .type starts with image/.
    // document-level binding ensures the handler fires even when the user
    // is focused outside the textarea (e.g. clicked a chat message first).
    function onPaste(e) {
      console.log('[franklin-img] paste event fired', e.target && e.target.tagName);
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) { console.log('[franklin-img] no clipboardData.items'); return; }
      var hadImage = false;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        console.log('[franklin-img] item ' + i + ': kind=' + it.kind + ' type=' + it.type);
        if (it.type && it.type.indexOf('image/') === 0) {
          var f = it.getAsFile();
          if (f) {
            console.log('[franklin-img] pasting image file', f.name, f.type, f.size);
            hadImage = true;
            handleImageFile(f);
          }
        }
      }
      if (hadImage) e.preventDefault();
    }
    // Only document-level — paste events bubble up from textarea, so this
    // catches both "textarea focused" and "click-elsewhere-then-paste"
    // cases. Adding a textarea-specific listener too would double-fire the
    // handler (each pasted image getting added twice to pendingImages).
    document.addEventListener('paste', onPaste);

    // Drag & drop — VS Code's editor will INTERCEPT file drops at the host
    // level if we don't register at document with preventDefault on
    // dragover/drop. Bind on document for the early-cancel, then visually
    // highlight only when the cursor is over our composer.
    var composerEl = document.getElementById('composer');
    function stopDrag(e) { e.preventDefault(); e.stopPropagation(); }

    document.addEventListener('dragover', function (e) {
      // Must preventDefault here too, otherwise the browser default
      // "no-drop" cursor shows and the drop event never fires.
      stopDrag(e);
    });
    document.addEventListener('drop', function (e) {
      stopDrag(e);
      console.log('[franklin-img] document drop', e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length);
      composerEl.classList.remove('dragover');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        console.log('[franklin-img] dropped file', f.name, f.type, f.size);
        handleImageFile(f);
      }
    });

    // Composer-level highlight — only visual, the actual drop logic lives
    // at document level above so we never lose the event to VS Code's
    // editor handlers.
    composerEl.addEventListener('dragenter', function (e) { stopDrag(e); composerEl.classList.add('dragover'); });
    composerEl.addEventListener('dragover',  function (e) { stopDrag(e); composerEl.classList.add('dragover'); });
    composerEl.addEventListener('dragleave', function (e) {
      stopDrag(e);
      // Only clear when leaving the composer entirely, not when crossing a
      // child boundary (dragleave fires on the parent every child cross).
      if (!composerEl.contains(e.relatedTarget)) composerEl.classList.remove('dragover');
    });

    // Attach button → hidden file picker
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (e) {
      var files = e.target && e.target.files;
      if (!files) return;
      for (var i = 0; i < files.length; i++) handleImageFile(files[i]);
      // Reset so picking the same file twice in a row still fires 'change'.
      fileInput.value = '';
    });

    function send() {
      var t = input.value.trim();
      // Allow image-only sends — if user only attached images and hit Send,
      // we still post (no text required). Skip when both empty.
      if (!t && pendingImages.length === 0) return;
      isLiveChat = true;
      historyDropdown.classList.remove('open');
      // Build the visible chat line so user sees what they sent (text + image
      // count). Actual image bytes ride on the postMessage payload.
      var displayLine = t;
      if (pendingImages.length > 0) {
        var suffix = ' [' + pendingImages.length + ' image' + (pendingImages.length === 1 ? '' : 's') + ' attached]';
        displayLine = t ? (t + suffix) : suffix.trim();
      }
      if (!currentChatTitle || currentChatTitle === 'Untitled' || currentChatTitle === 'New Chat') {
        var titleSrc = t || 'image upload';
        currentChatTitle = titleSrc.length > 30 ? titleSrc.slice(0, 30) + '...' : titleSrc;
        navTitle.textContent = currentChatTitle;
      }
      appendLine('user', displayLine);
      assistantBuf = '';
      assistantEl = null;
      thinkingBuf = '';
      currentTurnWf = null;
      currentThinkingStep = null;
      toolStepMap = {};
      wfTextStep = null;
      currentToolGroup = null;
      agentBusy = true;
      activityMode = 'waiting';
      toolNameStr = '';
      status.textContent = '';
      updateActivityRow();
      // Pull images out before clearing so we send the snapshot.
      var imgsForSend = pendingImages.slice();
      pendingImages = [];
      renderImageStrip();
      vscode.postMessage({
        type: 'send',
        text: t,
        images: imgsForSend,
      });
      input.value = '';
      // Snap height back to single-row baseline after clearing.
      input.style.height = '';
    }

    document.getElementById('send').addEventListener('click', send);
    document.getElementById('stop').addEventListener('click', function () {
      if (!agentBusy) return;
      vscode.postMessage({ type: 'stop' });
    });
    // Auto-grow textarea: every keystroke / paste re-measures scrollHeight
    // and snaps the visible height to it (capped by CSS max-height; once
    // we hit the cap, native overflow-y:auto kicks in and scrolls).
    function autoGrowInput() {
      // Resetting to 'auto' first lets shrinking work — otherwise the
      // textarea would only ever grow.
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
    input.addEventListener('input', autoGrowInput);
    // Initial sizing in case the field is pre-populated by a slash command
    // or a programmatic value-set.
    setTimeout(autoGrowInput, 0);

    input.addEventListener('keydown', function (e) {
      // Shift+Enter inserts a literal newline (default textarea behavior).
      // Plain Enter sends, unless the slash menu is open (handled above
      // in capture phase), the user is composing IME (isComposing), or
      // a modifier other than Shift is held (Cmd/Ctrl/Alt+Enter all
      // pass through as newline-ish — VS Code-y).
      if (e.key !== 'Enter') return;
      if (slashMenu.classList.contains('open')) return;
      if (e.shiftKey || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      send();
    });
    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key === 'Escape' && agentBusy) {
          e.preventDefault();
          vscode.postMessage({ type: 'stop' });
        }
      },
      true
    );

    syncChromeState();
  </script>
</body>
</html>`;
}
