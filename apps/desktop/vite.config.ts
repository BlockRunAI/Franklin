import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Dev mode: Vite serves the UI on 5173 and proxies the agent WebSocket +
// HTTP RPC to the Franklin CLI (or the mock dev server) running on 3737.
// Prod mode: the build is served directly by the CLI's embedded HTTP server
// — no Vite involved, no proxy needed (same-origin).
const requestedAgentPort = Number(process.env.FRANKLIN_AGENT_PORT || 3737);
if (!Number.isInteger(requestedAgentPort) || requestedAgentPort < 1 || requestedAgentPort > 65_535) {
  throw new Error("FRANKLIN_AGENT_PORT must be an integer from 1 to 65535");
}
const AGENT_PORT = requestedAgentPort;

export default defineConfig({
  // Relative asset paths so the build works when loaded from file:// inside the
  // packaged Electron app (absolute "/assets/…" would 404 → white screen).
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 5174 (not 5173) so the desktop dev server doesn't collide with Franklin
    // Canvas, which runs its own Vite UI on 5173.
    port: 5174,
    strictPort: true,
    proxy: {
      "/agent": {
        target: `ws://127.0.0.1:${AGENT_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      "/api": {
        target: `http://127.0.0.1:${AGENT_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Browsers Franklin CLI users have are recent — Node 20+ era. Skip the
    // legacy fallbacks Vite ships by default to keep the bundle slim.
    target: "es2022",
  },
});
