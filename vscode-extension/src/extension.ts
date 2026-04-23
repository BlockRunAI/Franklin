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
  generateInsights,
  runDoctorChecks,
  saveChain,
  loadChain,
  type StreamEvent,
  type SessionMeta,
  type Dialogue,
} from '@blockrun/franklin/vscode-session';

/** Resolve the working directory: workspace folder if available, else home dir */
function getWorkDir(): { dir: string; hasWorkspace: boolean } {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) return { dir: folder, hasWorkspace: true };
  return { dir: os.homedir(), hasWorkspace: false };
}

/** Inline model shortcuts — synced with src/ui/model-picker.ts MODEL_SHORTCUTS */
const MODEL_SHORTCUTS: Record<string, string> = {
  // Routing
  auto: 'blockrun/auto',
  eco: 'blockrun/eco',
  premium: 'blockrun/premium',
  // Anthropic
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.7',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI
  gpt: 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  codex: 'openai/gpt-5.3-codex',
  mini: 'openai/gpt-5-mini',
  nano: 'openai/gpt-5-nano',
  o3: 'openai/o3',
  o4: 'openai/o4-mini',
  o1: 'openai/o1',
  // Google
  gemini: 'google/gemini-2.5-pro',
  'gemini-3': 'google/gemini-3.1-pro',
  flash: 'google/gemini-2.5-flash',
  // xAI
  grok: 'xai/grok-3',
  'grok-4': 'xai/grok-4-0709',
  'grok-fast': 'xai/grok-4-1-fast-reasoning',
  // DeepSeek
  deepseek: 'deepseek/deepseek-chat',
  r1: 'deepseek/deepseek-reasoner',
  // Others
  kimi: 'moonshot/kimi-k2.6',
  'kimi-k2.5': 'moonshot/kimi-k2.5',
  minimax: 'minimax/minimax-m2.7',
  glm: 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5.1-turbo',
  // Free
  free: 'nvidia/glm-4.7',
  'glm-4.7': 'nvidia/glm-4.7',
  'qwen-coder': 'nvidia/qwen3-coder-480b',
  maverick: 'nvidia/llama-4-maverick',
  'qwen-think': 'nvidia/qwen3-next-80b-a3b-thinking',
};
function resolveModel(input: string): string {
  return MODEL_SHORTCUTS[input.trim().toLowerCase()] || input.trim();
}

let latestAbort: (() => void) | undefined;

export const log = vscode.window.createOutputChannel('Franklin');

export function activate(context: vscode.ExtensionContext) {
  log.appendLine('[Franklin] Extension activating…');
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
  private agentRunning = false;
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
  private async runDoctor(): Promise<void> {
    try {
      const checks = await runDoctorChecks();
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

  /** Load a historical session into the chat view */
  loadHistory(dialogues: Dialogue[], title?: string): void {
    if (!this.webview) return;
    const messages: { role: string; text: string }[] = [];
    for (const d of dialogues) {
      let text = '';
      if (typeof d.content === 'string') {
        text = d.content;
      } else if (Array.isArray(d.content)) {
        text = d.content
          .filter((p): p is { type: 'text'; text: string } => (p as unknown as Record<string, unknown>).type === 'text')
          .map(p => p.text)
          .join('\n');
      }
      if (text) messages.push({ role: d.role, text });
    }
    void this.webview.postMessage({ type: 'loadHistory', messages, title: title || 'History' });
  }

  private initWebview(webview: vscode.Webview): void {
    this.webview = webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
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
    void this.webview?.postMessage({ type: 'event', event: ev });
  }

  private async handleSwitchChain() {
    const current = loadChain();
    const next = current === 'base' ? 'solana' : 'base';
    saveChain(next);
    void vscode.window.showInformationMessage(`Franklin: Switched to ${next}`);
    await this.refreshWalletStatus();
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

  private async handleMessage(msg: { type?: string; text?: string }) {
    if (msg.type === 'send' && typeof msg.text === 'string') {
      const t = msg.text.trim();
      if (!t) return;
      this.finishInput(t);
      return;
    }
    if (msg.type === 'stop') {
      const hadAbort = latestAbort != null;
      latestAbort?.();
      void this.webview?.postMessage({ type: 'stopAck', hadAbort });
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
    if (msg.type === 'requestHistory') {
      this.sendHistoryList();
    }
    if (msg.type === 'runDoctor') {
      void this.runDoctor();
    }
    if (msg.type === 'loadInsights') {
      this.sendInsights();
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
      }
    }
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

    const getUserInput = () =>
      new Promise<string | null>((resolve) => {
        this.resolveInput = resolve;
      });

    try {
      await runVsCodeSession({
        workDir: dir,
        trust: true,
        debug: false,
        getUserInput,
        onConfigReady: (config) => {
          this.agentConfig = config;
        },
        onEvent: (event) => {
          if (event.kind === 'usage') {
            const cost = estimateCost(event.model, event.inputTokens, event.outputTokens, event.calls);
            (event as unknown as Record<string, unknown>).cost = cost;
          }
          this.postEvent(event);
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
  const portraitUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'franklin-portrait.jpg')
  );
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
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
    .user {
      display: flex;
      justify-content: flex-end;
      margin-top: 10px;
    }
    .user .bubble {
      background: rgba(128,128,128,0.2);
      border-radius: 12px;
      padding: 8px 14px;
      max-width: 80%;
      font-size: 13px;
      line-height: 1.5;
      color: var(--vscode-foreground);
      word-break: break-word;
    }
    .assistant {
      color: var(--vscode-foreground);
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.55;
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
    #in {
      width: 100%;
      padding: 12px 14px 8px 14px;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      outline: none;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: none;
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
      padding: 4px 0;
      z-index: 100;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    #model-dropdown.open { display: block; }
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
    #wallet-btn { cursor: default; }
    #wallet-btn:hover, #trading-btn:hover { color: var(--vscode-foreground); background: rgba(128,128,128,0.15); }
    #chain-btn {
      display: inline-flex; align-items: center;
      background: none; border: 1px solid rgba(128,128,128,0.3); cursor: pointer;
      padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600;
      color: var(--vscode-descriptionForeground); letter-spacing: 0.04em;
    }
    #chain-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
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
    .wf-step {
      display: flex;
      align-items: flex-start;
      position: relative;
      padding-left: 20px;
      padding-bottom: 6px;
      min-height: 18px;
    }
    .wf-dot {
      position: absolute;
      left: 0;
      top: 5px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(128,128,128,0.45);
      flex-shrink: 0;
    }
    .wf-step.thinking .wf-dot {
      background: transparent;
      border: 1.5px solid rgba(128,128,128,0.35);
    }
    .wf-step.tool-active .wf-dot {
      background: rgba(128,128,128,0.55);
      animation: wf-pulse 1.2s ease-in-out infinite;
    }
    @keyframes wf-pulse {
      0%,100% { transform: scale(1); opacity: 0.7; }
      50% { transform: scale(1.4); opacity: 1; }
    }
    .wf-turn .wf-step:not(:last-child)::after {
      content: '';
      position: absolute;
      left: 3px;
      top: 15px;
      bottom: 0;
      width: 1px;
      background: rgba(128,128,128,0.22);
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

    /* ── Empty-state brand ── */
    #empty-state {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      pointer-events: none;
      padding: 20px;
    }
    #empty-state .pixel-portrait {
      width: 96px;
      height: 96px;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
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
    }
    .history-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
    .history-item .hi-title {
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-item .hi-meta {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
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

  <!-- ── Chat view ── -->
  <div id="view-chat">
    <div id="nav-header">
      <span id="nav-title">Untitled</span>
      <div class="nav-actions">
        <button id="btn-doctor" title="System Health">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2a5 5 0 1 0 0 10A5 5 0 0 0 8 2z" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3l2 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.5 13.5c.8.3 1.6.5 2.5.5s1.7-.2 2.5-.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button id="btn-insights" title="Usage Insights">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="9" width="3" height="5" rx="0.8" stroke="currentColor" stroke-width="1.3"/><rect x="6.5" y="5" width="3" height="9" rx="0.8" stroke="currentColor" stroke-width="1.3"/><rect x="11" y="2" width="3" height="12" rx="0.8" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
        <button id="btn-history" title="History">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5V8l2.2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button id="btn-new" title="New chat">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
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
        <svg class="pixel-portrait" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
          <!-- hair (gray, colonial side-wave) -->
          <g fill="#c9c9c9">
            <rect x="4"  y="1" width="8" height="1"/>
            <rect x="3"  y="2" width="10" height="1"/>
            <rect x="2"  y="3" width="2" height="1"/>
            <rect x="12" y="3" width="2" height="1"/>
            <rect x="2"  y="4" width="1" height="2"/>
            <rect x="13" y="4" width="1" height="2"/>
            <rect x="1"  y="6" width="2" height="3"/>
            <rect x="13" y="6" width="2" height="3"/>
            <rect x="2"  y="9" width="1" height="1"/>
            <rect x="13" y="9" width="1" height="1"/>
          </g>
          <!-- hair highlight -->
          <g fill="#e8e8e8">
            <rect x="5" y="2" width="2" height="1"/>
            <rect x="9" y="2" width="2" height="1"/>
          </g>
          <!-- face skin -->
          <g fill="#e0b080">
            <rect x="4"  y="3" width="8" height="1"/>
            <rect x="3"  y="4" width="10" height="1"/>
            <rect x="3"  y="5" width="10" height="1"/>
            <rect x="3"  y="6" width="10" height="1"/>
            <rect x="3"  y="7" width="10" height="1"/>
            <rect x="4"  y="8" width="8" height="1"/>
            <rect x="4"  y="9" width="8" height="1"/>
            <rect x="5"  y="10" width="6" height="1"/>
          </g>
          <!-- cheek blush -->
          <g fill="#d98f6a">
            <rect x="3"  y="7" width="1" height="1"/>
            <rect x="12" y="7" width="1" height="1"/>
          </g>
          <!-- glasses frames -->
          <g fill="#2a2018">
            <rect x="4" y="5" width="3" height="1"/>
            <rect x="4" y="7" width="3" height="1"/>
            <rect x="4" y="6" width="1" height="1"/>
            <rect x="6" y="6" width="1" height="1"/>
            <rect x="9"  y="5" width="3" height="1"/>
            <rect x="9"  y="7" width="3" height="1"/>
            <rect x="9"  y="6" width="1" height="1"/>
            <rect x="11" y="6" width="1" height="1"/>
            <rect x="7" y="6" width="2" height="1"/>
          </g>
          <!-- eyes -->
          <g fill="#1a1a1a">
            <rect x="5"  y="6" width="1" height="1"/>
            <rect x="10" y="6" width="1" height="1"/>
          </g>
          <!-- mouth -->
          <g fill="#8a3a20">
            <rect x="7" y="9" width="2" height="1"/>
          </g>
          <!-- white shirt / cravat -->
          <g fill="#f0e8d0">
            <rect x="5"  y="11" width="6" height="1"/>
            <rect x="6"  y="12" width="4" height="1"/>
            <rect x="7"  y="13" width="2" height="2"/>
          </g>
          <!-- coat (brown) -->
          <g fill="#5a3820">
            <rect x="1" y="11" width="4" height="5"/>
            <rect x="11" y="11" width="4" height="5"/>
            <rect x="5"  y="12" width="1" height="4"/>
            <rect x="10" y="12" width="1" height="4"/>
            <rect x="6"  y="13" width="1" height="3"/>
            <rect x="9"  y="13" width="1" height="3"/>
            <rect x="7"  y="15" width="2" height="1"/>
          </g>
          <!-- coat buttons (gold) -->
          <g fill="#caa45a">
            <rect x="5" y="14" width="1" height="1"/>
            <rect x="10" y="14" width="1" height="1"/>
          </g>
        </svg>
        <div class="brand-name">Franklin</div>
        <div class="brand-slogan">The AI agent with a <span class="accent">wallet</span>.</div>
        <div id="loading-step" style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:8px;opacity:0.7;">Initializing…</div>
      </div>
    </div>
  <div id="input-area">
    <div id="slash-menu"></div>
    <div id="prefetch-indicator" style="display:none;"></div>
    <div class="meta" id="status"></div>
  <div id="composer">
    <input type="text" id="in" placeholder="Plan, @ for context, / for commands" autocomplete="off" />
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
        <button type="button" id="chain-btn" title="Switch chain (Base ↔ Solana)">
          <span id="chain-label">—</span>
        </button>
        <button type="button" id="trading-btn">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 12l3.5-4 3 2.5L12 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 5h2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span id="trading-tooltip">Trading Dashboard</span>
        </button>
      </div>
      <div class="composer-right">
        <div id="context-ring" title="Context usage">
          <svg width="26" height="26" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="11" fill="none" stroke="rgba(128,128,128,0.18)" stroke-width="2"></circle>
            <circle id="contextArc" cx="13" cy="13" r="11" fill="none" stroke="var(--vscode-focusBorder, #007fd4)" stroke-width="2" stroke-dasharray="69.12" stroke-dashoffset="69.12" stroke-linecap="round" transform="rotate(-90 13 13)"></circle>
            <text id="contextPct" x="13" y="13" text-anchor="middle" dominant-baseline="central" fill="var(--vscode-descriptionForeground)" font-size="7" font-family="var(--vscode-font-family)">0%</text>
          </svg>
        </div>
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
      resetChatLog();
      isLiveChat = true;
      showChat('Untitled');
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
      // Top models
      var models = (data.byModel || []).slice(0, 5);
      if (models.length > 0) {
        var t = document.createElement('div'); t.className = 'insight-section-title'; t.textContent = 'Top Models';
        insightsBody.appendChild(t);
        var maxCost = models[0].costUsd || 0.0001;
        models.forEach(function(m) {
          var row = document.createElement('div'); row.className = 'insight-model-row';
          var name = document.createElement('span'); name.className = 'insight-model-name';
          name.textContent = m.model.split('/').pop() || m.model;
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

    // ── Trading dashboard button ──
    document.getElementById('trading-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'openTrading' });
    });
    document.getElementById('chain-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'switchChain' });
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
      // Insert before empty-state
      var emptyState = document.getElementById('empty-state');
      log.insertBefore(resumeBannerEl, emptyState ? emptyState.nextSibling : null);
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
        var title = document.createElement('div');
        title.className = 'hi-title';
        title.textContent = item.title;
        el.appendChild(title);
        var meta = document.createElement('div');
        meta.className = 'hi-meta';
        meta.textContent = item.ago;
        el.appendChild(meta);
        el.addEventListener('click', function() {
          isLiveChat = false;
          historyDropdown.classList.remove('open');
          vscode.postMessage({ type: 'loadSession', text: item.id });
        });
        historyList.appendChild(el);
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
    var MODEL_LIST = [
      {group: 'Promo ($0.001/call)', items: [
        {label: 'GLM-5.1', shortcut: 'glm', price: '$0.001/call', desc: 'Zhipu flagship model. Strong multilingual and reasoning.', ctx: '128k'},
        {label: 'GLM-5.1 Turbo', shortcut: 'glm-turbo', price: '$0.001/call', desc: 'Fast variant of GLM-5.1. Good balance of speed and quality.', ctx: '128k'}
      ]},
      {group: 'Smart Routing', items: [
        {label: 'Auto', shortcut: 'auto', price: 'routed', desc: 'Auto-pick the best model for each task.', ctx: 'varies'},
        {label: 'Eco', shortcut: 'eco', price: 'cheapest', desc: 'Route to cheapest capable model.', ctx: 'varies'},
        {label: 'Premium', shortcut: 'premium', price: 'best', desc: 'Route to the best available model.', ctx: 'varies'}
      ]},
      {group: 'Premium Frontier', items: [
        {label: 'Claude Sonnet 4.6', shortcut: 'sonnet', price: '$3/$15', desc: 'Anthropic best-value model. Great for everyday coding tasks.', ctx: '200k'},
        {label: 'Claude Opus 4.7', shortcut: 'opus', price: '$5/$25', desc: 'Anthropic most capable model. 1M context, 128k output. Best for complex reasoning.', ctx: '1M', isNew: true},
        {label: 'Claude Opus 4.6', shortcut: 'opus-4.6', price: '$5/$25', desc: 'Previous Opus generation.', ctx: '200k'},
        {label: 'GPT-5.4', shortcut: 'gpt', price: '$2.5/$15', desc: 'OpenAI latest flagship model. Great for complex tasks.', ctx: '272k'},
        {label: 'GPT-5.4 Pro', shortcut: 'gpt-5.4-pro', price: '$30/$180', desc: 'OpenAI most capable. Best for hardest problems.', ctx: '272k'},
        {label: 'Gemini 2.5 Pro', shortcut: 'gemini', price: '$1.25/$10', desc: 'Google flagship model. Strong at code and multimodal.', ctx: '1M'},
        {label: 'Gemini 3.1 Pro', shortcut: 'gemini-3', price: '$2/$12', desc: 'Google next-gen flagship. Improved reasoning.', ctx: '1M'},
        {label: 'Grok 4', shortcut: 'grok-4', price: '$0.2/$1.5', desc: 'xAI latest model. Strong general reasoning.', ctx: '128k'},
        {label: 'Grok 3', shortcut: 'grok', price: '$3/$15', desc: 'xAI flagship model. Capable general-purpose.', ctx: '128k'}
      ]},
      {group: 'Reasoning', items: [
        {label: 'O3', shortcut: 'o3', price: '$2/$8', desc: 'OpenAI reasoning model. Strong at math and logic.', ctx: '200k'},
        {label: 'O4 Mini', shortcut: 'o4', price: '$1.1/$4.4', desc: 'OpenAI compact reasoning. Good cost/performance.', ctx: '200k'},
        {label: 'O1', shortcut: 'o1', price: '$15/$60', desc: 'OpenAI advanced reasoning. Best for complex problems.', ctx: '200k'},
        {label: 'GPT-5.3 Codex', shortcut: 'codex', price: '$1.75/$14', desc: 'OpenAI code-specialized model.', ctx: '272k'},
        {label: 'DeepSeek R1', shortcut: 'r1', price: '$0.28/$0.42', desc: 'DeepSeek reasoning. Chain-of-thought for hard problems.', ctx: '128k'},
        {label: 'Grok 4.1 Fast R.', shortcut: 'grok-fast', price: '$0.2/$0.5', desc: 'xAI fast reasoning model.', ctx: '128k'}
      ]},
      {group: 'Budget', items: [
        {label: 'Claude Haiku 4.5', shortcut: 'haiku', price: '$1/$5', desc: 'Anthropic fastest model. Quick responses at low cost.', ctx: '200k'},
        {label: 'GPT-5 Mini', shortcut: 'mini', price: '$0.25/$2', desc: 'Compact and fast. Good for simpler tasks.', ctx: '1M'},
        {label: 'GPT-5 Nano', shortcut: 'nano', price: '$0.05/$0.4', desc: 'Smallest OpenAI. Ultra-low cost for basic tasks.', ctx: '1M'},
        {label: 'Gemini 2.5 Flash', shortcut: 'flash', price: '$0.3/$2.5', desc: 'Google fast model. Low cost with solid quality.', ctx: '1M'},
        {label: 'DeepSeek V3', shortcut: 'deepseek', price: '$0.28/$0.42', desc: 'DeepSeek latest. Excellent code generation.', ctx: '128k'},
        {label: 'Kimi K2.6', shortcut: 'kimi', price: '$0.95/$4', desc: 'Moonshot flagship. 256K context, vision + reasoning.', ctx: '256k', isNew: true},
        {label: 'Kimi K2.5', shortcut: 'kimi-k2.5', price: '$0.6/$3', desc: 'Kimi previous generation.', ctx: '128k'},
        {label: 'Minimax M2.7', shortcut: 'minimax', price: '$0.3/$1.2', desc: 'Minimax model. Good general-purpose budget option.', ctx: '128k'}
      ]},
      {group: 'Free (no USDC needed)', items: [
        {label: 'GLM-4.7', shortcut: 'free', price: '', desc: 'Zhipu GLM-4.7 via NVIDIA. Default free model.', ctx: '128k'},
        {label: 'Qwen3 Coder 480B', shortcut: 'qwen-coder', price: '', desc: 'Alibaba coding model. Free, specialized for code.', ctx: '256k'},
        {label: 'Llama 4 Maverick', shortcut: 'maverick', price: '', desc: 'Meta Llama 4. Free, strong multilingual.', ctx: '128k'},
        {label: 'Qwen3 Next 80B Thinking', shortcut: 'qwen-think', price: '', desc: 'Alibaba reasoning model. Free, extended thinking.', ctx: '128k', isNew: true}
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

    function buildModelDropdown() {
      modelDropdown.textContent = '';
      var currentModel = (modelPickerLabel.textContent || '').toLowerCase();
      MODEL_LIST.forEach(function(grp) {
        var g = document.createElement('div');
        g.className = 'md-group';
        g.textContent = grp.group;
        modelDropdown.appendChild(g);
        grp.items.forEach(function(item) {
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
            vscode.postMessage({ type: 'switchModel', text: item.shortcut });
          });
          modelDropdown.appendChild(row);
        });
      });
    }
    function openDropdown() { buildModelDropdown(); modelDropdown.classList.add('open'); dropdownOpen = true; }
    function closeDropdown() { modelDropdown.classList.remove('open'); dropdownOpen = false; }
    modelPickerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (dropdownOpen) { closeDropdown(); } else { openDropdown(); }
    });
    document.addEventListener('click', function() { if (dropdownOpen) closeDropdown(); });
    modelDropdown.addEventListener('click', function(e) { e.stopPropagation(); });

    // ── Context ring ──
    var CIRC = 69.12;
    var totalInputTokens = 0;
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
      var cl = document.getElementById('chain-label');
      if (cl && info.chain) cl.textContent = info.chain === 'solana' ? 'SOL' : 'BASE';
    }

    var BT = String.fromCharCode(96); // backtick
    var BT3 = BT+BT+BT;
    var codeBlockIdx = 0;
    function renderMarkdown(text) {
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
        if (mc) mc.innerHTML = renderMarkdown(escHtml(assistantBuf));
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
      if (m.type === 'loadHistory') {
        resetChatLog();
        showChat(m.title || 'History');
        (m.messages || []).forEach(function(msg) {
          if (msg.role === 'user') {
            appendLine('user', msg.text);
          } else {
            appendLine('assistant', msg.text);
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
        return;
      }
      if (m.type === 'status' && m.partial) {
        if (m.partial.balance) syncBaseBalance(m.partial.balance);
        if (m.partial.chain) {
          var cl = document.getElementById('chain-label');
          if (cl) cl.textContent = m.partial.chain === 'solana' ? 'SOL' : 'BASE';
        }
        applyStatus(m.partial);
        return;
      }
      if (m.type === 'welcomeError') {
        renderWelcome(null, m.message);
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
      if (m.type !== 'event' || !m.event) return;
      const ev = m.event;
      switch (ev.kind) {
        case 'text_delta':
          if (!wfTextStep) streamingModelName = modelPickerLabel.textContent || '';
          assistantBuf += ev.text;
          var ts = getOrCreateTextStepWf();
          if (ts.content) ts.content.innerHTML = renderMarkdown(escHtml(assistantBuf));
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
          var doneResult = ev.result ? String(ev.result).slice(0, 80) : '';
          finishToolStepWf(ev.id || toolNameStr, !ev.error, doneResult);
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
          }
          status.textContent = '';
          break;
        case 'status_update':
          applyStatus({ model: ev.model });
          break;
        case 'usage':
          if (typeof ev.cost === 'number') sessionCost += ev.cost;
          var liveBal = computeLiveBalance();
          applyStatus({ model: ev.model, balance: liveBal });
          // Update model name on the current assistant message's action bar
          if (ev.model && wfTextStep) {
            var mSpan = wfTextStep.step.querySelector('.msg-model');
            if (mSpan) mSpan.textContent = shortModelName(ev.model);
          }
          if (typeof ev.inputTokens === 'number') {
            totalInputTokens += ev.inputTokens;
            updateContextRing();
          }
          break;
        default:
          break;
      }
    });

    // ── Slash command menu ──
    var SLASH_CMDS = [
      { cmd: '/clear',   desc: 'Clear the current chat log' },
      { cmd: '/new',     desc: 'Start a new conversation' },
      { cmd: '/history', desc: 'Browse conversation history' },
      { cmd: '/model',   desc: 'Switch the active model' },
      { cmd: '/stop',    desc: 'Stop the current generation' },
      { cmd: '/compact', desc: 'Compact conversation context' },
      { cmd: '/cost',    desc: 'Show session cost so far' }
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
      input.value = cmd + ' ';
      closeSlashMenu();
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

    function send() {
      var t = input.value.trim();
      if (!t) return;
      isLiveChat = true;
      historyDropdown.classList.remove('open');
      if (!currentChatTitle || currentChatTitle === 'Untitled' || currentChatTitle === 'New Chat') {
        currentChatTitle = t.length > 30 ? t.slice(0, 30) + '...' : t;
        navTitle.textContent = currentChatTitle;
      }
      appendLine('user', t);
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
      vscode.postMessage({ type: 'send', text: t });
      input.value = '';
    }

    document.getElementById('send').addEventListener('click', send);
    document.getElementById('stop').addEventListener('click', function () {
      if (!agentBusy) return;
      vscode.postMessage({ type: 'stop' });
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !slashMenu.classList.contains('open')) send();
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
