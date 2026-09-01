// Electron main process — wraps the franklin-webui React app in a native window.
//
// Same renderer as the browser build (so it's WYSIWYG with what you see at
// localhost:5173). The only difference is the agent connection:
//   - dev:  the window loads the running Vite server (http://localhost:5173),
//           which already proxies /agent → the backend on :3737.
//   - prod: the window loads the built dist/, the backend is spawned here, and
//           the preload injects ws://127.0.0.1:<port>/agent for the socket.
//
// Today the backend is the dev mock (dev-server/mock.mjs). Swap that for the
// real `franklin serve` agent server (or an in-process import of
// @blockrun/franklin) without touching the renderer.

const { app, BrowserWindow, shell, ipcMain, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  externalHttpUrl,
  loopbackHttpUrl,
  sameOriginUrl,
  trustedRendererUrl,
} = require("./security.cjs");

// Is something already listening on a local port? Used so we don't double-spawn
// Franklin Canvas (a second `npm start` would hit EADDRINUSE on :3100 and, per
// canvas's start.mjs, take its Vite down too — leaving :5173 dead).
function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
  });
}

const DEV_URL = process.env.FRANKLIN_DESKTOP_DEV_URL
  ? loopbackHttpUrl(process.env.FRANKLIN_DESKTOP_DEV_URL, "FRANKLIN_DESKTOP_DEV_URL")
  : null;
function configuredPort(value, fallback, label) {
  const parsed = Number(value === undefined || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${label} must be an integer from 0 to 65535`);
  return parsed;
}
const CONFIGURED_AGENT_PORT = configuredPort(process.env.FRANKLIN_AGENT_PORT, DEV_URL ? 3737 : 0, "FRANKLIN_AGENT_PORT");
const CONFIGURED_CLOUD_PORT = configuredPort(process.env.FRANKLIN_CLOUD_PORT, 0, "FRANKLIN_CLOUD_PORT");
const CLOUD_TOKEN = process.env.FRANKLIN_CLOUD_TOKEN || crypto.randomBytes(32).toString("base64url");
const AGENT_TOKEN = process.env.FRANKLIN_SERVE_TOKEN || crypto.randomBytes(32).toString("base64url");
const CANVAS_URL = loopbackHttpUrl(process.env.FRANKLIN_CANVAS_URL || "http://127.0.0.1:5173", "FRANKLIN_CANVAS_URL");
const DIST_ROOT = path.join(__dirname, "..", "dist");

// The preload and the loopback service inherit the same unguessable token.
// This prevents an arbitrary web page from driving wallet-authenticated Team
// operations just because it can reach localhost.
process.env.FRANKLIN_CLOUD_TOKEN = CLOUD_TOKEN;
process.env.FRANKLIN_SERVE_TOKEN = AGENT_TOKEN;

let win = null;
let startupWin = null;
let backend = null;
let cloudBackend = null;
let canvas = null;
let canvasWin = null;
let activeAgentPort = null;
let activeCloudPort = null;
let quitting = false;
let backendReady = false;
const rendererReadyWaiters = new Map();
let startupState = {
  status: "loading",
  message: "Preparing your secure workspace...",
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.exit(0);

function backendBaseEnvironment() {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME",
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function trustedMainRendererUrl(value) {
  return trustedRendererUrl(value, { devUrl: DEV_URL, distRoot: DIST_ROOT });
}

function trustedCanvasUrl(value) {
  return sameOriginUrl(value, CANVAS_URL);
}

async function openExternal(value) {
  const url = externalHttpUrl(value);
  if (url) await shell.openExternal(url.href);
}

function guardWindowNavigation(browserWindow, isAllowed) {
  browserWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowed(url)) return;
    event.preventDefault();
    void openExternal(url);
  });
  browserWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
}

function requireTrustedIpc(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error("IPC request did not come from the Franklin main frame");
  }
  if (!trustedMainRendererUrl(event.senderFrame.url)) throw new Error("IPC request came from an untrusted renderer URL");
}

function trustedStartupRendererUrl(value) {
  return value === pathToFileURL(path.join(__dirname, "startup.html")).href;
}

function requireTrustedStartupIpc(event) {
  if (!startupWin || startupWin.isDestroyed() || event.sender !== startupWin.webContents || event.senderFrame !== startupWin.webContents.mainFrame) {
    throw new Error("IPC request did not come from the Franklin startup frame");
  }
  if (!trustedStartupRendererUrl(event.senderFrame.url)) throw new Error("IPC request came from an untrusted startup URL");
}

function updateStartupState(status, message) {
  startupState = { status, message };
  if (startupWin && !startupWin.isDestroyed() && !startupWin.webContents.isLoading()) {
    startupWin.webContents.send("franklin:startup-state", startupState);
  }
}

function createStartupWindow() {
  if (startupWin && !startupWin.isDestroyed()) {
    startupWin.show();
    startupWin.focus();
    return startupWin;
  }

  startupWin = new BrowserWindow({
    width: 440,
    height: 300,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    backgroundColor: "#f7f6f1",
    webPreferences: {
      preload: path.join(__dirname, "startup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  });

  guardWindowNavigation(startupWin, trustedStartupRendererUrl);
  startupWin.once("ready-to-show", () => {
    if (startupWin && !startupWin.isDestroyed()) startupWin.show();
  });
  startupWin.webContents.on("did-finish-load", () => {
    if (startupWin && !startupWin.isDestroyed()) {
      startupWin.webContents.send("franklin:startup-state", startupState);
    }
  });
  startupWin.on("closed", () => { startupWin = null; });
  void startupWin.loadFile(path.join(__dirname, "startup.html")).catch((error) => {
    console.error("[franklin-desktop] failed to load startup window", error);
  });
  return startupWin;
}

function closeStartupWindow() {
  if (!startupWin || startupWin.isDestroyed()) return;
  startupWin.close();
  startupWin = null;
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    const activeWindow = win && !win.isDestroyed() ? win : startupWin;
    if (!activeWindow || activeWindow.isDestroyed()) return;
    if (activeWindow.isMinimized()) activeWindow.restore();
    activeWindow.show();
    activeWindow.focus();
  });
}

const STUDIO_RUNTIME_SPECS = {
  codex: {
    command: "codex",
    candidates: [
      process.env.CODEX_PATH,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
      path.join(os.homedir(), ".local", "bin", "codex"),
    ],
  },
  claude: {
    command: "claude",
    candidates: [process.env.CLAUDE_PATH, "/usr/local/bin/claude", "/opt/homebrew/bin/claude"],
  },
  hermes: { command: "hermes", candidates: [process.env.HERMES_PATH] },
  deepseek: { command: "dsh", candidates: [process.env.DSH_PATH] },
};

function execFileText(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: String(stdout || stderr || "").trim(), error: error ? String(error.message || error) : "" });
    });
  });
}

async function resolveStudioRuntime(id) {
  const spec = STUDIO_RUNTIME_SPECS[id];
  if (!spec) return null;
  const candidates = [...spec.candidates.filter(Boolean)];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, spec.command));
  if (id === "claude") {
    const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node");
    try {
      for (const version of fs.readdirSync(nvmRoot).sort().reverse()) candidates.push(path.join(nvmRoot, version, "bin", "claude"));
    } catch { /* nvm is optional */ }
  }
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return null;
}

async function inspectStudioRuntime(id) {
  const executable = await resolveStudioRuntime(id);
  if (!executable) return { id, available: false, running: false };
  const versionResult = await execFileText(executable, ["--version"], 5000);
  const running = false;
  return {
    id,
    available: true,
    running,
    path: executable,
    version: versionResult.output.split("\n")[0] || "Detected",
    lifecycleSupported: false,
  };
}

async function scanStudioRuntimes() {
  return Promise.all(Object.keys(STUDIO_RUNTIME_SPECS).map(inspectStudioRuntime));
}

async function startStudioRuntime(id) {
  const detected = await inspectStudioRuntime(id);
  return { ok: false, running: false, ...detected, error: "Runtime detected, but the Desktop protocol adapter is not implemented yet." };
}

async function stopStudioRuntime(id) {
  return { ok: false, running: false, error: `The ${id} Desktop protocol adapter is not implemented yet.` };
}

// Auto-start Franklin Canvas (its own backend :3100 + Vite UI :5173) so the
// embedded canvas mode "just works" — the user never juggles a second terminal
// or port. Dev only for now; packaging the canvas is a follow-up.
async function startCanvas() {
  if (!DEV_URL) return; // dev only
  // Already running (manual instance, or a previous launch)? Reuse it.
  const canvasPort = Number(CANVAS_URL.port) || 5173;
  if (await isPortOpen(canvasPort)) {
    console.log(`[franklin-desktop] canvas already running on :${canvasPort} — reusing`);
    return;
  }
  const dir = path.join(__dirname, "..", "..", "franklin-canvas");
  if (!require("node:fs").existsSync(path.join(dir, "package.json"))) {
    console.log("[franklin-desktop] franklin-canvas not found — skipping canvas auto-start");
    return;
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  canvas = spawn(npmCommand, ["start"], {
    cwd: dir,
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: "inherit",
    shell: false,
  });
  canvas.on("exit", (code) => {
    console.log(`[franklin-desktop] canvas exited (${code})`);
    canvas = null;
  });
}

// In packaged/prod mode we own the backend lifecycle. In dev it's already
// running (started by `npm run dev:real` / `npm run dev`), so we don't spawn one.
//
// The real backend is Franklin's `serve` server (drives the actual agent loop,
// wallet and tools). Set FRANKLIN_USE_MOCK=1 to fall back to the dev mock.
function resolveFranklinEntry() {
  // Packaged app: the prepared runtime is included in app.asar. Dev resolves
  // the Franklin workspace dependency.
  if (app.isPackaged) {
    const bundled = path.join(app.getAppPath(), "franklin-agent", "dist", "index.js");
    if (require("node:fs").existsSync(bundled)) return bundled;
  }
  try {
    const pkg = require.resolve("@blockrun/franklin/package.json");
    return path.join(path.dirname(pkg), "dist", "index.js");
  } catch {
    return null;
  }
}

function startBackend() {
  if (DEV_URL) {
    activeAgentPort = CONFIGURED_AGENT_PORT;
    process.env.FRANKLIN_AGENT_PORT = String(activeAgentPort);
    return Promise.resolve(activeAgentPort);
  }
  const useMock = process.env.FRANKLIN_USE_MOCK === "1";
  const franklinEntry = useMock ? null : resolveFranklinEntry();
  const workDir = process.env.FRANKLIN_WORK_DIR
    ? path.resolve(process.env.FRANKLIN_WORK_DIR)
    : path.join(app.getPath("documents"), "Franklin");
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  if (!franklinEntry && !useMock) {
    return Promise.reject(new Error("Bundled Franklin runtime is missing; refusing to silently start the mock backend"));
  }
  const requestedPort = activeAgentPort ?? CONFIGURED_AGENT_PORT;
  const [cmd, args] = useMock
    ? [path.join(__dirname, "..", "dev-server", "mock.mjs"), []]
    : [franklinEntry, ["serve", "--port", String(requestedPort), "--work-dir", workDir]];
  const child = spawn(process.execPath, [cmd, ...args], {
    cwd: workDir,
    env: {
      ...backendBaseEnvironment(),
      FRANKLIN_AGENT_PORT: String(requestedPort),
      FRANKLIN_SERVE_TOKEN: AGENT_TOKEN,
      FRANKLIN_SERVE_ALLOW_NULL_ORIGIN: "1",
      FRANKLIN_SERVE_DISCOVERY: "off",
      FRANKLIN_CLOUD_SYNC: "off",
      FRANKLIN_DESKTOP_WORKSPACE_BOUNDARY: "1",
      ELECTRON_RUN_AS_NODE: "1", // run the Node entry under Electron's Node
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  backend = child;
  child.on("exit", (code) => {
    console.log(`[franklin-desktop] backend exited (${code})`);
    if (backend === child) backend = null;
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      if (backend === child) backend = null;
      child.kill();
      reject(new Error("Franklin agent server did not become ready"));
    }, 15_000);
    child.on("message", (message) => {
      if (message?.type !== "franklin:server-ready") return;
      const readyPort = configuredPort(message.port, -1, "Franklin ready port");
      if (readyPort < 1) return;
      clearTimeout(timer);
      ready = true;
      activeAgentPort = readyPort;
      process.env.FRANKLIN_AGENT_PORT = String(readyPort);
      resolve(readyPort);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`Franklin agent server exited before readiness (${code})`));
      }
    });
  });
}

async function switchWalletChain(chain) {
  if (chain !== "base" && chain !== "solana") throw new Error("Unsupported wallet network");
  const blockrunDir = path.join(app.getPath("home"), ".blockrun");
  fs.mkdirSync(blockrunDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(blockrunDir, "payment-chain"), `${chain}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(blockrunDir, "payment-chain"), 0o600);
  if (!DEV_URL && backend) {
    const previous = backend;
    backend = null;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      previous.once("exit", () => { clearTimeout(timer); resolve(); });
      previous.kill();
    });
    await startBackend();
  }
  return { ok: true, chain };
}

function startCloudBackend() {
  const entry = path.join(__dirname, "..", "cloud-server", "server.mjs");
  const requestedPort = activeCloudPort ?? CONFIGURED_CLOUD_PORT;
  cloudBackend = spawn(process.execPath, [entry], {
    cwd: app.getPath("home"),
    env: {
      ...process.env,
      FRANKLIN_CLOUD_PORT: String(requestedPort),
      FRANKLIN_CLOUD_TOKEN: CLOUD_TOKEN,
      FRANKLIN_RUNTIME_ENTRY: resolveFranklinEntry() || "",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  cloudBackend.on("exit", (code) => {
    console.log(`[franklin-desktop] cloud workspace backend exited (${code})`);
    cloudBackend = null;
  });
  const child = cloudBackend;
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      if (cloudBackend === child) cloudBackend = null;
      child.kill();
      reject(new Error("Franklin Team sidecar did not become ready"));
    }, 15_000);
    child.on("message", (message) => {
      if (message?.type !== "franklin:cloud-ready") return;
      const readyPort = configuredPort(message.port, -1, "Franklin Team ready port");
      if (readyPort < 1) return;
      clearTimeout(timer);
      ready = true;
      activeCloudPort = readyPort;
      process.env.FRANKLIN_CLOUD_PORT = String(readyPort);
      resolve(readyPort);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`Franklin Team sidecar exited before readiness (${code})`));
      }
    });
  });
}

// Open Franklin Canvas in its own window (the full canvas app loads from
// CANVAS_URL; its server/UI was auto-started by startCanvas). Reuse the window
// if already open. Retries the load while the canvas dev server boots.
async function openCanvasWindow() {
  if (canvasWin && !canvasWin.isDestroyed()) {
    canvasWin.show();
    canvasWin.focus();
    return;
  }
  canvasWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#ffffff",
    title: "Franklin Canvas",
    // Normal native title bar (NOT hiddenInset) — the canvas app has no custom
    // drag region, so it needs the OS title bar to be movable.
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  });
  guardWindowNavigation(canvasWin, trustedCanvasUrl);
  canvasWin.on("closed", () => { canvasWin = null; });
  for (let i = 0; i < 40; i++) {
    try { await canvasWin.loadURL(CANVAS_URL.href); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}

async function loadRenderer(targetWindow) {
  if (DEV_URL) {
    // Vite may still be coming up — retry until it answers.
    for (let i = 0; i < 40; i++) {
      try {
        await targetWindow.loadURL(DEV_URL.href);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await targetWindow.loadURL(DEV_URL.href); // final attempt; let the error surface
  } else {
    await targetWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#ffffff",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  });

  // Open target=_blank / external links in the system browser, not a new window.
  guardWindowNavigation(win, trustedMainRendererUrl);
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error("[franklin-desktop] renderer load failed", { errorCode, errorDescription, validatedURL });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[franklin-desktop] renderer process exited", details);
    if (quitting) return;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    createStartupWindow();
    updateStartupState("error", "Franklin stopped unexpectedly. Please try again.");
  });
  win.on("closed", () => {
    win = null;
  });
  return win;
}

function waitForRendererContent(targetWindow) {
  return new Promise((resolve, reject) => {
    const webContentsId = targetWindow.webContents.id;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rendererReadyWaiters.delete(webContentsId);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Franklin's interface did not become ready in time.")));
    }, 15_000);
    rendererReadyWaiters.set(webContentsId, () => finish(resolve));
    targetWindow.once("closed", () => {
      finish(() => reject(new Error("Franklin window closed before its interface was ready.")));
    });
  });
}

async function openMainWindow() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    closeStartupWindow();
    return;
  }
  const mainWindow = createWindow();
  const rendererReady = waitForRendererContent(mainWindow);
  await loadRenderer(mainWindow);
  await rendererReady;
  if (mainWindow.isDestroyed()) throw new Error("Franklin window closed before it was ready.");
  mainWindow.show();
  mainWindow.focus();
  closeStartupWindow();
}

async function startApplication() {
  createStartupWindow();
  updateStartupState("loading", "Preparing your secure workspace...");
  await Promise.all([startBackend(), startCloudBackend()]);
  backendReady = true;
  updateStartupState("loading", "Opening Franklin...");
  void startCanvas();
  await openMainWindow();
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle("franklin:open-canvas", (event) => { requireTrustedIpc(event); return openCanvasWindow(); });
  ipcMain.handle("franklin:studio-scan", (event) => { requireTrustedIpc(event); return scanStudioRuntimes(); });
  ipcMain.handle("franklin:studio-start", (event, id) => { requireTrustedIpc(event); return startStudioRuntime(String(id)); });
  ipcMain.handle("franklin:studio-stop", (event, id) => { requireTrustedIpc(event); return stopStudioRuntime(String(id)); });
  ipcMain.handle("franklin:wallet-switch", (event, chain) => { requireTrustedIpc(event); return switchWalletChain(String(chain)); });
  ipcMain.on("franklin:renderer-ready", (event) => {
    requireTrustedIpc(event);
    rendererReadyWaiters.get(event.sender.id)?.();
  });
  ipcMain.handle("franklin:startup-retry", (event) => {
    requireTrustedStartupIpc(event);
    app.relaunch();
    app.exit(0);
  });
  void startApplication().catch((error) => {
    console.error("[franklin-desktop] startup failed", error);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    createStartupWindow();
    updateStartupState("error", "Franklin couldn't start. Please try again.");
  });
  app.on("activate", () => {
    if (!backendReady) {
      createStartupWindow();
      return;
    }
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    createStartupWindow();
    updateStartupState("loading", "Opening Franklin...");
    void openMainWindow().catch((error) => {
      console.error("[franklin-desktop] failed to reopen window", error);
      updateStartupState("error", "Franklin couldn't open its window. Please try again.");
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { quitting = true; });

app.on("quit", () => {
  if (backend) backend.kill();
  if (cloudBackend) cloudBackend.kill();
  if (canvas) canvas.kill();
});
