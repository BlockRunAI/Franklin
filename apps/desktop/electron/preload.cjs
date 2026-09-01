// Preload — runs in an isolated context with access to Electron + Node, bridges
// a tiny, explicit surface to the renderer. For now it only injects the agent
// WebSocket URL so the socket works when the page is loaded from file:// (prod),
// where there's no same-origin to derive it from.

const { contextBridge, clipboard, nativeImage, ipcRenderer } = require("electron");

// `ready-to-show` can fire before React paints meaningful content. Wait for two
// animation frames after DOMContentLoaded, then let the main process replace
// the startup window. This keeps a blank Electron surface off screen.
window.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => ipcRenderer.send("franklin:renderer-ready"));
  });
}, { once: true });

function readyPort(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${label} is not ready`);
  return parsed;
}
const port = readyPort(process.env.FRANKLIN_AGENT_PORT, "Franklin agent port");
const cloudPort = readyPort(process.env.FRANKLIN_CLOUD_PORT, "Franklin Team port");
const agentToken = process.env.FRANKLIN_SERVE_TOKEN || "";
const agentQuery = agentToken ? `?token=${encodeURIComponent(agentToken)}` : "";

contextBridge.exposeInMainWorld("__FRANKLIN__", {
  agentUrl: `ws://127.0.0.1:${port}/agent${agentQuery}`,
  cloudUrl: `http://127.0.0.1:${cloudPort}`,
  cloudToken: process.env.FRANKLIN_CLOUD_TOKEN || "",
  // Franklin Canvas (node-based media studio) opens in its own native window;
  // Electron auto-starts the canvas server/UI, so there's nothing to run by hand.
  openCanvas: () => ipcRenderer.invoke("franklin:open-canvas"),
  scanAgentRuntimes: () => ipcRenderer.invoke("franklin:studio-scan"),
  startAgentRuntime: (id) => ipcRenderer.invoke("franklin:studio-start", id),
  stopAgentRuntime: (id) => ipcRenderer.invoke("franklin:studio-stop", id),
  switchWalletChain: (chain) => ipcRenderer.invoke("franklin:wallet-switch", chain),
  // Native clipboard — navigator.clipboard is unreliable inside Electron, so the
  // renderer prefers this when present.
  copy: (text) => {
    try {
      const value = String(text ?? "");
      if (value.length > 1_000_000) return false;
      clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  },
  // Copy a PNG data URL to the clipboard as an image (for share-as-image).
  copyImage: (dataUrl) => {
    try {
      const value = String(dataUrl ?? "");
      if (!value.startsWith("data:image/png;base64,") || value.length > 8_000_000) return false;
      const img = nativeImage.createFromDataURL(value);
      if (img.isEmpty()) return false;
      clipboard.writeImage(img);
      return true;
    } catch {
      return false;
    }
  },
});
