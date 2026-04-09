import * as vscode from 'vscode';
import {
  runVsCodeSession,
  getVsCodeWelcomeInfo,
  getVsCodeWalletStatus,
  estimateCost,
  type StreamEvent,
} from '@blockrun/runcode/vscode-session';

let latestAbort: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext) {
  const provider = new RuncodeChatProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RuncodeChatProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('runcode.stopGeneration', () => {
      latestAbort?.();
    })
  );
}

export function deactivate() {
  latestAbort = undefined;
}

class RuncodeChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'runcode.chatPanel';

  private view?: vscode.WebviewView;
  private resolveInput?: (value: string | null) => void;
  private agentRunning = false;
  private walletRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = getWebviewHtml();

    webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(msg);
    });

    webviewView.onDidDispose(() => {
      if (this.walletRefreshTimer) {
        clearTimeout(this.walletRefreshTimer);
        this.walletRefreshTimer = undefined;
      }
      this.finishInput(null);
    });

    void this.pushWelcome();
    void this.runAgentSession();
  }

  private async pushWelcome() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      void this.view?.webview.postMessage({ type: 'welcome', info: null });
      return;
    }
    try {
      const info = await getVsCodeWelcomeInfo(folder);
      void this.view?.webview.postMessage({ type: 'welcome', info });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      void this.view?.webview.postMessage({ type: 'welcomeError', message: err });
    }
  }

  private finishInput(value: string | null) {
    const r = this.resolveInput;
    this.resolveInput = undefined;
    r?.(value);
  }

  private postEvent(ev: StreamEvent) {
    void this.view?.webview.postMessage({ type: 'event', event: ev });
  }

  /**
   * Refresh balance / chain / wallet from RPC only — never sends model (session model comes from usage /status_update).
   */
  private async refreshWalletStatus() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !this.view) return;
    try {
      const w = await getVsCodeWalletStatus(folder);
      void this.view.webview.postMessage({
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

  /** Debounced: each API usage deducts USDC — poll balance shortly after (batches multi-chunk turns). */
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
      void this.view?.webview.postMessage({ type: 'stopAck', hadAbort });
    }
  }

  private async runAgentSession() {
    if (this.agentRunning) return;
    this.agentRunning = true;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      void vscode.window.showWarningMessage(
        'RunCode: Open a folder as a workspace first. Tools run in that folder.'
      );
      void this.view?.webview.postMessage({
        type: 'error',
        message: 'No workspace folder. Use File → Open Folder, then reopen this panel.',
      });
      this.agentRunning = false;
      return;
    }

    const getUserInput = () =>
      new Promise<string | null>((resolve) => {
        this.resolveInput = resolve;
      });

    try {
      await runVsCodeSession({
        workDir: folder,
        trust: true,
        debug: false,
        getUserInput,
        onEvent: (event) => {
          if (event.kind === 'usage') {
            // Attach cost so webview can compute live balance synchronously
            const cost = estimateCost(event.model, event.inputTokens, event.outputTokens, event.calls);
            (event as unknown as Record<string, unknown>).cost = cost;
          }
          this.postEvent(event);
          if (event.kind === 'turn_done' && event.reason === 'completed') {
            // Sync with on-chain balance at turn end
            this.scheduleWalletRefresh();
          }
        },
        onAbortReady: (abort) => {
          latestAbort = abort;
        },
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      void this.view?.webview.postMessage({ type: 'error', message: err });
      void vscode.window.showErrorMessage(`RunCode: ${err}`);
    } finally {
      void this.view?.webview.postMessage({ type: 'sessionEnded' });
      this.agentRunning = false;
    }
  }
}

function getWebviewHtml(): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'"].join(
    '; '
  );

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
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    body.session-busy #log {
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: inset 0 0 0 1px rgba(0, 127, 212, 0.22);
    }
    .user { color: var(--vscode-textLink-foreground); margin-top: 8px; }
    .assistant { color: var(--vscode-foreground); margin-top: 8px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .tool { color: var(--vscode-symbolIcon-functionForeground); font-size: 11px; }
    #composer {
      flex-shrink: 0;
      padding: 8px;
      margin: 0 -4px -4px -4px;
      border-radius: 6px;
      transition: background 0.2s ease;
    }
    body.session-busy #composer {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12));
      border: 1px solid rgba(0, 127, 212, 0.35);
    }
    #row { display: flex; gap: 6px; align-items: center; }
    #in {
      flex: 1;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
    }
    #in:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    button {
      padding: 6px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    button#stop:not(:disabled) {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #fff);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #welcome {
      flex-shrink: 0;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      padding: 10px 8px;
      margin-bottom: 8px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      max-height: 42vh;
      overflow: auto;
    }
    #welcome .banner-pre {
      margin: 0 0 8px 0;
      padding: 0;
      font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Monaco, Consolas, monospace;
      font-size: 8.5px;
      line-height: 1.12;
      letter-spacing: 0;
      tab-size: 8;
      color: var(--vscode-descriptionForeground);
      white-space: pre;
      overflow-x: auto;
      word-break: keep-all;
      overflow-wrap: normal;
    }
    #welcome .footer {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 6px 0 8px 0;
      line-height: 1.35;
    }
    #welcome dl {
      margin: 0;
      font-size: 11px;
      line-height: 1.5;
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 10px;
      row-gap: 4px;
      align-items: start;
    }
    #welcome dt {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    #welcome dd {
      margin: 0;
      word-break: break-all;
      color: var(--vscode-foreground);
    }
    #welcome .welcome-hint {
      margin-top: 8px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .status-strip {
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 6px 10px;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-size: 11px;
      line-height: 1.35;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    }
    .status-strip .st-label {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-right: 4px;
    }
    .status-strip code {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .status-strip .st-sep {
      color: var(--vscode-widget-border, #666);
      user-select: none;
    }
    .status-strip #stWallet {
      word-break: break-all;
      max-width: 100%;
    }
    /* Activity row — aligned with CLI Ink: waiting / thinking / tool spinners */
    #activity {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      margin-bottom: 8px;
      font-size: 12px;
      line-height: 1.4;
      border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, #444);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    #activity.hidden {
      display: none !important;
    }
    #activity.thinking {
      color: var(--vscode-charts-purple, #b48ead);
      border-color: var(--vscode-charts-purple, #6b4c7a);
    }
    #activity.tool {
      color: var(--vscode-symbolIcon-functionForeground, #cca700);
    }
    #activity.generating {
      color: var(--vscode-terminal-ansiGreen, #3fb950);
      border-color: rgba(63, 185, 80, 0.45);
    }
    /* Dots loader — works reliably in webview (no transform quirks on ring) */
    #activity .dots {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      height: 14px;
      flex-shrink: 0;
    }
    #activity .dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.35;
      animation: rc-dot 1.05s ease-in-out infinite;
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
    @keyframes rc-dot {
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
    #activityText {
      flex: 1;
      min-width: 0;
    }
  </style>
</head>
<body>
  <div id="welcome"></div>
  <div id="statusStrip" class="status-strip" role="status">
    <span><span class="st-label">Model</span><code id="stModel">—</code></span>
    <span class="st-sep">·</span>
    <span><span class="st-label">Balance</span><code id="stBal">—</code></span>
    <span class="st-sep">·</span>
    <span><span class="st-label">Wallet</span><span id="stWallet">—</span></span>
    <span class="st-sep">·</span>
    <span><span class="st-label">Chain</span><span id="stChain">—</span></span>
    <span class="st-sep">·</span>
    <span><span class="st-label">Workspace</span><span id="stWs" title="">—</span></span>
  </div>
  <div id="activity" class="activity hidden" role="status" aria-live="polite">
    <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
    <span id="activityText"></span>
  </div>
  <div id="log"></div>
  <div class="meta" id="status">Ready — type a message and press Enter to send (/exit to end session)</div>
  <div id="composer">
    <div id="row">
      <input type="text" id="in" placeholder="Message…" />
      <button type="button" id="send">Send</button>
      <button type="button" id="stop" disabled title="Nothing running">Stop</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const welcome = document.getElementById('welcome');
    const log = document.getElementById('log');
    const input = document.getElementById('in');
    const status = document.getElementById('status');
    const activity = document.getElementById('activity');
    const activityText = document.getElementById('activityText');
    let assistantBuf = '';
    var agentBusy = false;
    var activityMode = 'waiting';
    var toolNameStr = '';

    // Live balance tracking (mirrors Ink UI approach)
    var baseBalance = null;     // last known balance as number
    var sessionCost = 0;        // cumulative session cost
    var costAtLastFetch = 0;    // sessionCost when baseBalance was last set

    function parseBalanceNum(s) {
      var m = s.match(/[$]([\\.\\d]+)/);
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

    function setActivityClass() {
      activity.classList.remove('thinking', 'tool', 'generating');
      if (activityMode === 'thinking') activity.classList.add('thinking');
      if (activityMode === 'tool') activity.classList.add('tool');
      if (activityMode === 'generating') activity.classList.add('generating');
    }

    function syncChromeState() {
      document.body.classList.toggle('session-busy', agentBusy);
      var stopBtn = document.getElementById('stop');
      var sendBtn = document.getElementById('send');
      var inp = document.getElementById('in');
      stopBtn.disabled = !agentBusy;
      stopBtn.title = agentBusy ? 'Stop generation (Esc)' : 'Nothing running';
      sendBtn.disabled = agentBusy;
      inp.disabled = agentBusy;
      inp.placeholder = agentBusy ? 'Wait for this turn to finish…' : 'Message…';
      if (!agentBusy) {
        try {
          inp.focus();
        } catch (e) {}
      }
    }

    function updateActivityRow() {
      if (!agentBusy) {
        activity.classList.add('hidden');
        syncChromeState();
        return;
      }
      activity.classList.remove('hidden');
      setActivityClass();
      var model = document.getElementById('stModel').textContent || 'model';
      if (activityMode === 'waiting') {
        activityText.textContent = 'Waiting for ' + model + '…';
      } else if (activityMode === 'thinking') {
        activityText.textContent = 'Thinking…';
      } else if (activityMode === 'tool') {
        activityText.textContent = 'Running tool: ' + toolNameStr + '…';
      } else if (activityMode === 'generating') {
        activityText.textContent = 'Generating response…';
      }
      syncChromeState();
    }

    function applyStatus(p) {
      if (p.model != null) document.getElementById('stModel').textContent = p.model;
      if (p.balance != null) document.getElementById('stBal').textContent = p.balance;
      if (p.walletAddress != null) document.getElementById('stWallet').textContent = p.walletAddress;
      if (p.chain != null) document.getElementById('stChain').textContent = p.chain;
      if (p.workDir != null) {
        var w = p.workDir;
        var el = document.getElementById('stWs');
        el.textContent = w.length > 40 ? '…' + w.slice(-38) : w;
        el.title = w;
      }
    }

    function renderWelcome(info, errMsg) {
      welcome.textContent = '';
      if (errMsg) {
        const p = document.createElement('p');
        p.className = 'meta';
        p.textContent = 'Could not load session info: ' + errMsg;
        welcome.appendChild(p);
        return;
      }
      if (!info) {
        const p = document.createElement('p');
        p.className = 'meta';
        p.textContent =
          'Open a folder (File -> Open Folder) to use RunCode. Tools run in that workspace.';
        welcome.appendChild(p);
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'banner-pre';
      // Two-tone banner: "Run" in gold, "Code" in cyan (matches CLI chalk output)
      var RUN_WIDTH = 29; // fixed width of RUN_ART columns
      info.bannerLines.forEach(function (line, i) {
        if (i > 0) pre.appendChild(document.createTextNode(String.fromCharCode(10)));
        var runPart = document.createElement('span');
        runPart.style.color = '#FFD700';
        runPart.textContent = line.slice(0, RUN_WIDTH);
        var codePart = document.createElement('span');
        codePart.style.color = '#00BCD4';
        codePart.textContent = line.slice(RUN_WIDTH);
        pre.appendChild(runPart);
        pre.appendChild(codePart);
      });
      welcome.appendChild(pre);
      const foot = document.createElement('div');
      foot.className = 'footer';
      info.footerLines.forEach(function (line) {
        const lineEl = document.createElement('div');
        // Color "RunCode" in footer to match banner
        var rc = line.indexOf('RunCode');
        if (rc !== -1) {
          lineEl.appendChild(document.createTextNode(line.slice(0, rc)));
          var runW = document.createElement('span');
          runW.style.color = '#FFD700';
          runW.style.fontWeight = 'bold';
          runW.textContent = 'Run';
          var codeW = document.createElement('span');
          codeW.style.color = '#00BCD4';
          codeW.style.fontWeight = 'bold';
          codeW.textContent = 'Code';
          lineEl.appendChild(runW);
          lineEl.appendChild(codeW);
          lineEl.appendChild(document.createTextNode(line.slice(rc + 7)));
        } else {
          lineEl.textContent = line;
        }
        foot.appendChild(lineEl);
      });
      welcome.appendChild(foot);
      syncBaseBalance(info.balance);
      applyStatus({
        model: info.model,
        balance: info.balance,
        walletAddress: info.walletAddress || '—',
        chain: info.chain,
        workDir: info.workDir
      });
      const hint = document.createElement('div');
      hint.className = 'welcome-hint';
      hint.textContent =
        'Tip: /model to switch models · /compact to save tokens · /help for commands';
      welcome.appendChild(hint);
    }

    function appendLine(className, text) {
      const d = document.createElement('div');
      d.className = className;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }

    function flushAssistant() {
      if (assistantBuf) {
        appendLine('assistant', assistantBuf);
        assistantBuf = '';
      }
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'welcome') {
        renderWelcome(m.info, null);
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
            ? 'Stop — cancelling in-flight request…'
            : 'Stop — nothing was running.'
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
          appendLine('tool', '⏳ Tool: ' + ev.name + (ev.preview ? ' — ' + ev.preview : ''));
          break;
        case 'capability_progress':
          appendLine('tool', '… ' + ev.text);
          break;
        case 'capability_done':
          activityMode = 'waiting';
          updateActivityRow();
          appendLine('meta', '✓ Tool finished id=' + ev.id);
          break;
        case 'turn_done':
          flushAssistant();
          agentBusy = false;
          updateActivityRow();
          if (ev.reason === 'aborted') {
            status.textContent = 'Stopped — generation interrupted.';
            appendLine('meta', '— Stopped.');
          } else {
            status.textContent = 'Turn finished: ' + ev.reason;
          }
          break;
        case 'status_update':
          applyStatus({ model: ev.model });
          break;
        case 'usage':
          // Accumulate cost and compute live balance — synchronous, same handler as model
          if (typeof ev.cost === 'number') sessionCost += ev.cost;
          var liveBal = computeLiveBalance();
          applyStatus({ model: ev.model, balance: liveBal });
          appendLine(
            'meta',
            'Tokens in=' + ev.inputTokens + ' out=' + ev.outputTokens + ' model=' + ev.model
          );
          break;
        default:
          break;
      }
    });

    function send() {
      const t = input.value.trim();
      if (!t) return;
      appendLine('user', '> ' + t);
      assistantBuf = '';
      agentBusy = true;
      activityMode = 'waiting';
      toolNameStr = '';
      status.textContent = 'Running — Stop or Esc to interrupt.';
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
