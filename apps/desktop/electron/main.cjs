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

const { app, BrowserWindow, shell, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

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

const DEV_URL = process.env.FRANKLIN_DESKTOP_DEV_URL; // set by the desktop:dev script
const CANVAS_URL = process.env.FRANKLIN_CANVAS_URL || "http://localhost:5173";
const AGENT_TOKEN = DEV_URL ? "" : crypto.randomBytes(32).toString("base64url");
const FILE_TOKEN = DEV_URL ? "" : crypto.randomBytes(32).toString("base64url");

let agentPort = process.env.FRANKLIN_AGENT_PORT || (DEV_URL ? "3737" : "0");
if (AGENT_TOKEN) process.env.FRANKLIN_SERVE_TOKEN = AGENT_TOKEN;

let win = null;
let backend = null;
let canvas = null;
let canvasWin = null;
let quitting = false;

function backendBaseEnvironment() {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME",
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function isSafeExternalUrl(raw) {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function sameOrigin(candidate, trusted) {
  try { return new URL(candidate).origin === new URL(trusted).origin; }
  catch { return false; }
}

function isTrustedMainRendererUrl(raw) {
  if (DEV_URL) return sameOrigin(raw, DEV_URL);
  return raw === pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString();
}

function guardWindowNavigation(browserWindow, trustedUrl) {
  browserWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = trustedUrl.startsWith("file:") ? url === trustedUrl : sameOrigin(url, trustedUrl);
    if (!allowed) event.preventDefault();
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function assertTrustedIpcSender(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !isTrustedMainRendererUrl(event.sender.getURL())) {
    throw new Error("Rejected IPC from an untrusted renderer");
  }
}

// Auto-start Franklin Canvas (its own backend :3100 + Vite UI :5173) so the
// embedded canvas mode "just works" — the user never juggles a second terminal
// or port. Dev only for now; packaging the canvas is a follow-up.
async function startCanvas() {
  if (!DEV_URL) return; // dev only
  // Already running (manual instance, or a previous launch)? Reuse it.
  const canvasPort = Number(new URL(CANVAS_URL).port) || 5173;
  if (await isPortOpen(canvasPort)) {
    console.log(`[franklin-desktop] canvas already running on :${canvasPort} — reusing`);
    return;
  }
  const dir = path.join(__dirname, "..", "..", "franklin-canvas");
  if (!require("node:fs").existsSync(path.join(dir, "package.json"))) {
    console.log("[franklin-desktop] franklin-canvas not found — skipping canvas auto-start");
    return;
  }
  canvas = spawn("npm", ["start"], {
    cwd: dir,
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: "inherit",
    shell: true, // npm is a shell script; resolve via PATH
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
  // Packaged app: the agent runtime lives inside app.asar next to the
  // production dependencies electron-builder already collects. Keeping the
  // runtime there avoids shipping a second, full copy of node_modules.
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
  if (DEV_URL) return Promise.resolve(String(agentPort));
  const useMock = process.env.FRANKLIN_USE_MOCK === "1";
  if (app.isPackaged && useMock) {
    throw new Error("The development mock is disabled in packaged Franklin builds.");
  }
  const franklinEntry = useMock ? null : resolveFranklinEntry();
  if (!useMock && !franklinEntry) {
    throw new Error("The packaged Franklin agent runtime is missing.");
  }
  // Keep the default tool root out of the user's entire home directory. A user
  // can still select an explicit workspace with FRANKLIN_WORK_DIR.
  const workDir = process.env.FRANKLIN_WORK_DIR
    ? path.resolve(process.env.FRANKLIN_WORK_DIR)
    : path.join(app.getPath("documents"), "Franklin");
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const [cmd, args] = franklinEntry
    ? [franklinEntry, ["serve", "--port", agentPort, "--work-dir", workDir]]
    : [path.join(__dirname, "..", "dev-server", "mock.mjs"), []];
  backend = spawn(process.execPath, [cmd, ...args], {
    cwd: workDir,
    env: {
      ...backendBaseEnvironment(),
      FRANKLIN_AGENT_PORT: agentPort,
      FRANKLIN_SERVE_TOKEN: AGENT_TOKEN,
      FRANKLIN_SERVE_FILE_TOKEN: FILE_TOKEN,
      FRANKLIN_SERVE_ALLOW_NULL_ORIGIN: "1",
      FRANKLIN_SERVE_DISCOVERY: "off",
      FRANKLIN_CLOUD_SYNC: "off",
      FRANKLIN_DESKTOP_WORKSPACE_BOUNDARY: "1",
      ELECTRON_RUN_AS_NODE: "1", // run the Node entry under Electron's Node
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => {
      if (backend) backend.kill();
      reject(new Error("Franklin agent server did not become ready in time."));
    }, 20_000);
    backend.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    backend.on("message", (message) => {
      if (ready || !message || message.type !== "franklin:server-ready") return;
      const reported = Number(message.port);
      if (!Number.isInteger(reported) || reported <= 0 || reported > 65535) {
        clearTimeout(timeout);
        backend.kill();
        reject(new Error("Franklin agent server reported an invalid port."));
        return;
      }
      ready = true;
      clearTimeout(timeout);
      resolve(String(reported));
    });
    backend.on("exit", (code) => {
      clearTimeout(timeout);
      console.log(`[franklin-desktop] backend exited (${code})`);
      backend = null;
      if (!ready) reject(new Error(`Franklin agent server exited before readiness (${code}).`));
      else if (!quitting) app.quit();
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  guardWindowNavigation(canvasWin, CANVAS_URL);
  canvasWin.on("closed", () => { canvasWin = null; });
  for (let i = 0; i < 40; i++) {
    try { await canvasWin.loadURL(CANVAS_URL); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}

async function loadRenderer() {
  if (DEV_URL) {
    // Vite may still be coming up — retry until it answers.
    for (let i = 0; i < 40; i++) {
      try {
        await win.loadURL(DEV_URL);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await win.loadURL(DEV_URL); // final attempt; let the error surface
  } else {
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const trustedRendererUrl = DEV_URL || pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString();
  guardWindowNavigation(win, trustedRendererUrl);

  loadRenderer();
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  agentPort = await startBackend();
  process.env.FRANKLIN_AGENT_PORT = agentPort;
  startCanvas();
  ipcMain.handle("franklin:open-canvas", (event) => {
    assertTrustedIpcSender(event);
    return openCanvasWindow();
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("[franklin-desktop] startup failed", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { quitting = true; });

app.on("quit", () => {
  if (backend) backend.kill();
  if (canvas) canvas.kill();
});
