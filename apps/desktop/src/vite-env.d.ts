/// <reference types="vite/client" />

// Injected by the Electron preload (electron/preload.cjs) so the WebSocket
// transport knows where the local agent server is when the page is loaded from
// file:// (no same-origin to derive from). Absent in the browser.
interface Window {
  __FRANKLIN__?: {
    agentUrl: string;
    cloudUrl?: string;
    cloudToken?: string;
    copy?: (text: string) => boolean;
    scanAgentRuntimes?: () => Promise<Array<{ id: string; available: boolean; running: boolean; path?: string; version?: string; endpoint?: string; lifecycleSupported?: boolean; error?: string }>>;
    startAgentRuntime?: (id: string) => Promise<{ ok: boolean; available?: boolean; running: boolean; path?: string; version?: string; endpoint?: string; lifecycleSupported?: boolean; error?: string }>;
    stopAgentRuntime?: (id: string) => Promise<{ ok: boolean; running: boolean; error?: string }>;
    switchWalletChain?: (chain: "base" | "solana") => Promise<{ ok: boolean; chain: "base" | "solana" }>;
    getUpdateState?: () => Promise<import("./lib/desktop-updates").DesktopUpdateState>;
    checkForUpdates?: () => Promise<import("./lib/desktop-updates").DesktopUpdateState>;
    downloadUpdate?: () => Promise<import("./lib/desktop-updates").DesktopUpdateState>;
    openUpdateInstaller?: () => Promise<import("./lib/desktop-updates").DesktopUpdateState>;
    cancelUpdateDownload?: () => Promise<void>;
    onUpdateState?: (callback: (state: import("./lib/desktop-updates").DesktopUpdateState) => void) => () => void;
  };
}
