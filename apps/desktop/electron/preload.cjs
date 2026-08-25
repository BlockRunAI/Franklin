// Preload — runs in an isolated context with access to Electron + Node, bridges
// a tiny, explicit surface to the renderer. For now it only injects the agent
// WebSocket URL so the socket works when the page is loaded from file:// (prod),
// where there's no same-origin to derive it from.

const { contextBridge, clipboard, nativeImage, ipcRenderer } = require("electron");

const port = process.env.FRANKLIN_AGENT_PORT || "3737";
const token = process.env.FRANKLIN_SERVE_TOKEN || "";
const agentUrl = new URL(`ws://127.0.0.1:${port}/agent`);
if (token) agentUrl.searchParams.set("token", token);

contextBridge.exposeInMainWorld("__FRANKLIN__", {
  agentUrl: agentUrl.toString(),
  // Franklin Canvas (node-based media studio) opens in its own native window;
  // Electron auto-starts the canvas server/UI, so there's nothing to run by hand.
  openCanvas: () => ipcRenderer.invoke("franklin:open-canvas"),
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
