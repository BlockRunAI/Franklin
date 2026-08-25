/// <reference types="vite/client" />

// Injected by the Electron preload (electron/preload.cjs) so the WebSocket
// transport knows where the local agent server is when the page is loaded from
// file:// (no same-origin to derive from). Absent in the browser.
interface Window {
  __FRANKLIN__?: {
    agentUrl: string;
    copy?: (text: string) => boolean;
  };
}
