import * as vscode from 'vscode';
import * as os from 'node:os';
import { runVsCodeSession, getVsCodeWelcomeInfo, getVsCodeWalletStatus, estimateCost, listSessions, loadSessionHistory, } from '@blockrun/franklin/vscode-session';
/** Resolve the working directory: workspace folder if available, else home dir */
function getWorkDir() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder)
        return { dir: folder, hasWorkspace: true };
    return { dir: os.homedir(), hasWorkspace: false };
}
/** Inline model shortcuts — synced with src/ui/model-picker.ts MODEL_SHORTCUTS */
const MODEL_SHORTCUTS = {
    // Routing
    auto: 'blockrun/auto',
    eco: 'blockrun/eco',
    premium: 'blockrun/premium',
    // Anthropic
    sonnet: 'anthropic/claude-sonnet-4.6',
    claude: 'anthropic/claude-sonnet-4.6',
    opus: 'anthropic/claude-opus-4.6',
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
    kimi: 'moonshot/kimi-k2.5',
    minimax: 'minimax/minimax-m2.7',
    glm: 'zai/glm-5.1',
    'glm-turbo': 'zai/glm-5.1-turbo',
    // Free
    free: 'nvidia/nemotron-ultra-253b',
    devstral: 'nvidia/devstral-2-123b',
    'qwen-coder': 'nvidia/qwen3-coder-480b',
    maverick: 'nvidia/llama-4-maverick',
    'deepseek-free': 'nvidia/deepseek-v3.2',
};
function resolveModel(input) {
    return MODEL_SHORTCUTS[input.trim().toLowerCase()] || input.trim();
}
let latestAbort;
export function activate(context) {
    const provider = new FranklinChatProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(FranklinChatProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(vscode.commands.registerCommand('franklin.stopGeneration', () => {
        latestAbort?.();
    }));
    // ── Status Bar ──
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = '$(sparkle) Franklin';
    statusItem.tooltip = 'Open Franklin Chat';
    statusItem.command = 'franklin.chatPanel.focus';
    statusItem.show();
    context.subscriptions.push(statusItem);
    // ── Open in New Tab ──
    context.subscriptions.push(vscode.commands.registerCommand('franklin.openInNewTab', () => {
        const panel = vscode.window.createWebviewPanel('franklin.chatTab', 'Franklin Chat', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        const tabProvider = new FranklinChatProvider(context.extensionUri);
        tabProvider.resolveWebviewPanel(panel);
    }));
    // ── History ──
    context.subscriptions.push(vscode.commands.registerCommand('franklin.refreshHistory', () => {
        provider.sendHistoryList();
    }));
}
export function deactivate() {
    latestAbort = undefined;
}
function formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
function getSessionTitle(m) {
    // Try to get first user message as title
    try {
        const history = loadSessionHistory(m.id);
        for (const d of history) {
            if (d.role === 'user') {
                const text = typeof d.content === 'string'
                    ? d.content
                    : Array.isArray(d.content)
                        ? d.content
                            .filter((p) => p.type === 'text')
                            .map(p => p.text).join(' ')
                        : '';
                if (text)
                    return text.length > 40 ? text.slice(0, 40) + '...' : text;
            }
        }
    }
    catch { /* fall through */ }
    return m.workDir ? m.workDir.split('/').pop() || m.id.slice(0, 8) : m.id.slice(0, 8);
}
function getHistoryList() {
    try {
        const sessions = listSessions().filter(s => s.turnCount > 0 && s.messageCount > 0).slice(0, 20);
        const result = [];
        for (const m of sessions) {
            try {
                result.push({
                    id: m.id,
                    title: getSessionTitle(m),
                    ago: formatTimeAgo(m.updatedAt),
                    model: m.model.split('/').pop() || m.model,
                    turns: m.turnCount,
                });
            }
            catch {
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
    }
    catch {
        return [];
    }
}
class FranklinChatProvider {
    extensionUri;
    static viewType = 'franklin.chatPanel';
    webview;
    resolveInput;
    agentRunning = false;
    walletRefreshTimer;
    agentConfig;
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }
    /** Called when sidebar view is created */
    resolveWebviewView(webviewView) {
        this.initWebview(webviewView.webview);
        webviewView.onDidDispose(() => {
            this.cleanup();
        });
        void this.pushWelcome();
        this.sendHistoryList();
        void this.runAgentSession();
    }
    /** Called when opening in a new editor tab */
    resolveWebviewPanel(panel) {
        this.initWebview(panel.webview);
        panel.onDidDispose(() => {
            this.cleanup();
        });
        void this.pushWelcome();
        void this.runAgentSession();
    }
    /** Send the history list to the webview */
    sendHistoryList() {
        const items = getHistoryList();
        void this.webview?.postMessage({ type: 'historyList', items });
    }
    /** Load a historical session into the chat view */
    loadHistory(dialogues, title) {
        if (!this.webview)
            return;
        const messages = [];
        for (const d of dialogues) {
            let text = '';
            if (typeof d.content === 'string') {
                text = d.content;
            }
            else if (Array.isArray(d.content)) {
                text = d.content
                    .filter((p) => p.type === 'text')
                    .map(p => p.text)
                    .join('\n');
            }
            if (text)
                messages.push({ role: d.role, text });
        }
        void this.webview.postMessage({ type: 'loadHistory', messages, title: title || 'History' });
    }
    initWebview(webview) {
        this.webview = webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webview.html = getWebviewHtml();
        webview.onDidReceiveMessage((msg) => {
            void this.handleMessage(msg);
        });
    }
    cleanup() {
        if (this.walletRefreshTimer) {
            clearTimeout(this.walletRefreshTimer);
            this.walletRefreshTimer = undefined;
        }
        this.finishInput(null);
    }
    async pushWelcome() {
        const { dir, hasWorkspace } = getWorkDir();
        try {
            const info = await getVsCodeWelcomeInfo(dir);
            void this.webview?.postMessage({ type: 'welcome', info, hasWorkspace });
        }
        catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            void this.webview?.postMessage({ type: 'welcomeError', message: err });
        }
    }
    finishInput(value) {
        const r = this.resolveInput;
        this.resolveInput = undefined;
        r?.(value);
    }
    postEvent(ev) {
        void this.webview?.postMessage({ type: 'event', event: ev });
    }
    async refreshWalletStatus() {
        const { dir } = getWorkDir();
        if (!this.webview)
            return;
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
        }
        catch {
            /* ignore */
        }
    }
    scheduleWalletRefresh() {
        if (this.walletRefreshTimer) {
            clearTimeout(this.walletRefreshTimer);
        }
        this.walletRefreshTimer = setTimeout(() => {
            this.walletRefreshTimer = undefined;
            void this.refreshWalletStatus();
        }, 400);
    }
    async handleMessage(msg) {
        if (msg.type === 'send' && typeof msg.text === 'string') {
            const t = msg.text.trim();
            if (!t)
                return;
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
                void this.webview?.postMessage({
                    type: 'event',
                    event: { kind: 'status_update', model: newModel },
                });
            }
        }
        if (msg.type === 'requestHistory') {
            this.sendHistoryList();
        }
        if (msg.type === 'loadSession' && msg.text) {
            const history = loadSessionHistory(msg.text);
            if (history.length > 0) {
                // Find title from first user message
                let title = msg.text.slice(0, 8);
                for (const d of history) {
                    if (d.role === 'user') {
                        const text = typeof d.content === 'string' ? d.content : '';
                        if (text) {
                            title = text.length > 30 ? text.slice(0, 30) + '...' : text;
                            break;
                        }
                    }
                }
                this.loadHistory(history, title);
            }
        }
    }
    async runAgentSession() {
        if (this.agentRunning)
            return;
        this.agentRunning = true;
        const { dir, hasWorkspace } = getWorkDir();
        if (!hasWorkspace) {
            void this.webview?.postMessage({
                type: 'event',
                event: { kind: 'text_delta', text: '' },
            });
        }
        const getUserInput = () => new Promise((resolve) => {
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
                        event.cost = cost;
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
        }
        catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            void this.webview?.postMessage({ type: 'error', message: err });
            void vscode.window.showErrorMessage(`Franklin: ${err}`);
        }
        finally {
            void this.webview?.postMessage({ type: 'sessionEnded' });
            this.agentRunning = false;
        }
    }
}
function getWebviewHtml() {
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'"].join('; ');
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
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 8px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 200px;
      transition: background 0.2s ease;
    }
    body.session-busy {
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
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
    .composer-right { display: flex; align-items: center; gap: 6px; }
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
      gap: 8px;
      padding: 6px 0;
      margin-top: 8px;
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
      gap: 4px;
      align-items: center;
      height: 14px;
      flex-shrink: 0;
    }
    .activity .dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.35;
      animation: fk-dot 1.05s ease-in-out infinite;
    }
    #activity .dots span:nth-child(1) {
      animation-delay: 0s;
    }
    #activity .dots span:nth-child(2) {
      animation-delay: 0.15s;
    }
    #activity .dots span:nth-child(3) {
      animation-delay: 0.3s;
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
    /* ── Views: history list / chat ── */
    #view-history { display: flex; flex-direction: column; height: 100vh; }
    #view-chat { display: none; flex-direction: column; height: 100vh; }
    body.show-chat #view-history { display: none; }
    body.show-chat #view-chat { display: flex; }

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
    #nav-back {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    #nav-back:hover { background: rgba(128,128,128,0.2); }
    #nav-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
  </style>
</head>
<body>
  <!-- ── History view ── -->
  <div id="view-history">
    <div class="history-header">
      <h3>History</h3>
      <div class="history-actions">
        <button id="history-refresh" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.3-3.5M13.5 2v2.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button id="history-new" title="New chat">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div id="history-list"></div>
  </div>

  <!-- ── Chat view ── -->
  <div id="view-chat">
    <div id="nav-header">
      <button id="nav-back" title="Back to history">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span id="nav-title">New Chat</span>
    </div>
    <div id="log"></div>
    <div class="meta" id="status">Ready \u2014 type a message and press Enter</div>
  <div id="composer">
    <input type="text" id="in" placeholder="Plan, @ for context, / for commands" autocomplete="off" />
    <div id="composer-toolbar">
      <div style="position:relative">
        <button type="button" id="model-picker-btn">
          <span id="modelPickerLabel">Model</span>
          <span class="chevron">&#9662;</span>
        </button>
        <div id="model-dropdown"></div>
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
  </div><!-- /view-chat -->
  <script>
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

    var currentChatTitle = 'New Chat';
    var isLiveChat = true; // true = current live session, false = viewing old history
    function showChat(title) {
      if (title) currentChatTitle = title;
      document.body.classList.add('show-chat');
      navTitle.textContent = currentChatTitle;
    }
    function showHistory() {
      document.body.classList.remove('show-chat');
      vscode.postMessage({ type: 'requestHistory' });
    }

    // Nav buttons — back just switches view, preserves chat DOM
    document.getElementById('nav-back').addEventListener('click', showHistory);
    document.getElementById('history-refresh').addEventListener('click', function() {
      vscode.postMessage({ type: 'requestHistory' });
    });
    document.getElementById('history-new').addEventListener('click', function() {
      log.textContent = '';
      assistantBuf = '';
      assistantEl = null;
      showChat('New Chat');
    });

    function renderHistoryList(items) {
      historyList.textContent = '';
      // "Current Chat" entry to resume live session
      if (isLiveChat && log.children.length > 0) {
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
        if (!isLiveChat || log.children.length === 0) {
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
          vscode.postMessage({ type: 'loadSession', text: item.id });
        });
        historyList.appendChild(el);
      });
    }

    // Start on history view
    vscode.postMessage({ type: 'requestHistory' });

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
        {label: 'Claude Opus 4.6', shortcut: 'opus', price: '$5/$25', desc: 'Anthropic most capable model. Best for complex reasoning.', ctx: '200k'},
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
        {label: 'Kimi K2.5', shortcut: 'kimi', price: '$0.6/$3', desc: 'Moonshot model. Strong multilingual support.', ctx: '128k'},
        {label: 'Minimax M2.7', shortcut: 'minimax', price: '$0.3/$1.2', desc: 'Minimax model. Good general-purpose budget option.', ctx: '128k'}
      ]},
      {group: 'Free (no USDC needed)', items: [
        {label: 'Nemotron Ultra 253B', shortcut: 'free', price: '', desc: 'NVIDIA large model. Free tier, no funding required.', ctx: '128k'},
        {label: 'Qwen3 Coder 480B', shortcut: 'qwen-coder', price: '', desc: 'Alibaba coding model. Free, specialized for code.', ctx: '256k'},
        {label: 'Devstral 2 123B', shortcut: 'devstral', price: '', desc: 'Mistral coding model. Free, strong at code tasks.', ctx: '128k'},
        {label: 'Llama 4 Maverick', shortcut: 'maverick', price: '', desc: 'Meta Llama 4. Free, strong multilingual.', ctx: '128k'},
        {label: 'DeepSeek V3.2', shortcut: 'deepseek-free', price: '', desc: 'DeepSeek free tier via NVIDIA.', ctx: '128k'}
      ]}
    ];

    var MODEL_LOOKUP = [];
    MODEL_LIST.forEach(function(grp) { grp.items.forEach(function(item) { MODEL_LOOKUP.push(item); }); });
    MODEL_LOOKUP.sort(function(a, b) { return b.shortcut.length - a.shortcut.length; });

    function shortModelName(raw) {
      var lower = raw.toLowerCase();
      for (var i = 0; i < MODEL_LOOKUP.length; i++) {
        if (lower.indexOf(MODEL_LOOKUP[i].shortcut) !== -1) return MODEL_LOOKUP[i].label;
      }
      return raw;
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
      if (!agentBusy) {
        removeInlineActivity();
        syncChromeState();
        return;
      }
      var el = ensureInlineActivity();
      el.classList.remove('thinking', 'tool', 'generating');
      if (activityMode === 'thinking') el.classList.add('thinking');
      if (activityMode === 'tool') el.classList.add('tool');
      if (activityMode === 'generating') el.classList.add('generating');
      var txt = el.querySelector('.activity-text');
      var model = modelPickerLabel.textContent || 'model';
      if (activityMode === 'waiting') {
        txt.textContent = 'Waiting for ' + model + '\\u2026';
      } else if (activityMode === 'thinking') {
        txt.textContent = 'Thinking\\u2026';
      } else if (activityMode === 'tool') {
        txt.textContent = 'Running tool: ' + toolNameStr + '\\u2026';
      } else if (activityMode === 'generating') {
        // Hide activity row once text starts streaming
        removeInlineActivity();
        syncChromeState();
        return;
      }
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
      if (m.type === 'loadHistory') {
        log.textContent = '';
        assistantBuf = '';
        assistantEl = null;
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
      if (m.type === 'welcome') {
        renderWelcome(m.info, null, m.hasWorkspace !== false);
        return;
      }
      if (m.type === 'status' && m.partial) {
        if (m.partial.balance) syncBaseBalance(m.partial.balance);
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
          assistantBuf += ev.text;
          if (!assistantEl) {
            streamingModelName = modelPickerLabel.textContent || '';
            assistantEl = document.createElement('div');
            assistantEl.className = 'assistant';
            var contentEl = document.createElement('div');
            contentEl.className = 'msg-content';
            assistantEl.appendChild(contentEl);
            log.appendChild(assistantEl);
          }
          var mc = assistantEl.querySelector('.msg-content');
          if (mc) mc.innerHTML = renderMarkdown(escHtml(assistantBuf));
          log.scrollTop = log.scrollHeight;
          activityMode = 'generating';
          updateActivityRow();
          break;
        case 'thinking_delta':
          activityMode = 'thinking';
          updateActivityRow();
          break;
        case 'capability_start':
          flushAssistant();
          activityMode = 'tool';
          toolNameStr = ev.name;
          updateActivityRow();
          appendLine('tool', '\\u23f3 Tool: ' + ev.name + (ev.preview ? ' \\u2014 ' + ev.preview : ''));
          break;
        case 'capability_progress':
          appendLine('tool', '\\u2026 ' + ev.text);
          break;
        case 'capability_done':
          activityMode = 'waiting';
          updateActivityRow();
          appendLine('meta', '\\u2713 Tool finished id=' + ev.id);
          break;
        case 'turn_done':
          flushAssistant();
          agentBusy = false;
          updateActivityRow();
          if (ev.reason === 'aborted') {
            status.textContent = 'Stopped \\u2014 generation interrupted.';
            appendLine('meta', '\\u2014 Stopped.');
          } else {
            status.textContent = 'Turn finished: ' + ev.reason;
          }
          break;
        case 'status_update':
          applyStatus({ model: ev.model });
          break;
        case 'usage':
          if (typeof ev.cost === 'number') sessionCost += ev.cost;
          var liveBal = computeLiveBalance();
          applyStatus({ model: ev.model, balance: liveBal });
          // Update model name on the current assistant message's action bar
          if (ev.model && assistantEl) {
            var mSpan = assistantEl.querySelector('.msg-model');
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

    function send() {
      const t = input.value.trim();
      if (!t) return;
      isLiveChat = true;
      if (!document.body.classList.contains('show-chat')) {
        showChat('New Chat');
      }
      if (!currentChatTitle || currentChatTitle === 'New Chat') {
        currentChatTitle = t.length > 30 ? t.slice(0, 30) + '...' : t;
        navTitle.textContent = currentChatTitle;
      }
      appendLine('user', t);
      assistantBuf = '';
      assistantEl = null;
      agentBusy = true;
      activityMode = 'waiting';
      toolNameStr = '';
      status.textContent = 'Running \\u2014 Stop or Esc to interrupt.';
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
      if (e.key === 'Enter') send();
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
