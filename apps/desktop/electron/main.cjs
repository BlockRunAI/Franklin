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
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

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
const AGENT_PORT = process.env.FRANKLIN_AGENT_PORT || "3737";
const CANVAS_URL = process.env.FRANKLIN_CANVAS_URL || "http://localhost:5173";

let win = null;
let backend = null;
let canvas = null;
let canvasWin = null;

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
  // Packaged app: the agent runtime is bundled under
  // resources/franklin-agent/ (extraResources). Dev: resolve the workspace dep.
  if (app.isPackaged && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "franklin-agent", "dist", "index.js");
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
  if (DEV_URL) return;
  const useMock = process.env.FRANKLIN_USE_MOCK === "1";
  const franklinEntry = useMock ? null : resolveFranklinEntry();
  // Tools (Read/Write/Bash) run in this directory. Default to the user's home
  // so a packaged app launched from Finder doesn't operate at "/".
  const workDir = app.getPath("home");
  const [cmd, args] = franklinEntry
    ? [franklinEntry, ["serve", "--port", AGENT_PORT, "--work-dir", workDir]]
    : [path.join(__dirname, "..", "dev-server", "mock.mjs"), []];
  backend = spawn(process.execPath, [cmd, ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      FRANKLIN_AGENT_PORT: AGENT_PORT,
      ELECTRON_RUN_AS_NODE: "1", // run the Node entry under Electron's Node
    },
    stdio: "inherit",
  });
  backend.on("exit", (code) => {
    console.log(`[franklin-desktop] backend exited (${code})`);
    backend = null;
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  canvasWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
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
    },
  });

  // Open target=_blank / external links in the system browser, not a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  loadRenderer();
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  startBackend();
  startCanvas();
  ipcMain.handle("franklin:open-canvas", () => openCanvasWindow());
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
  if (backend) backend.kill();
  if (canvas) canvas.kill();
});
