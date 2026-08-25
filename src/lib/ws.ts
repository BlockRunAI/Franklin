// Single WebSocket connection to the Franklin CLI agent server, with auto-
// reconnect and a tiny pub/sub on top. One connection per browser tab; all
// hooks (chat, sessions, wallet) share it.
//
// Why a singleton: the agent loop owns a session; if a hook were to open a
// fresh socket per render the CLI side would see N parallel connections per
// tab and have to dedup. Single connection + correlation ids keeps the CLI
// router trivial.
//
// Why no auto-resubscribe on reconnect: the CLI session is the source of
// truth; on reconnect we just re-issue session.list and re-render. Streaming
// turns survive reconnects on the CLI side (the agent loop runs in the CLI
// process, not in the socket) and the UI catches up via session.event when
// it rebinds.

import type { ClientMsg, ClientMsgKind, ServerMsg, ServerMsgKind } from "./wire";

type Listener = (msg: ServerMsg) => void;

interface Pending {
  resolve: (value: ServerMsg) => void;
  reject: (err: Error) => void;
  /** Stream subscribers receive every ServerMsg that matches their id, not just
   *  the terminal "response" / "error". Used by agent.send to receive deltas. */
  stream?: Listener;
  timer?: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

class AgentSocket {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idSeq = 0;
  private url: string;

  /** Last connection state, exposed via subscribe(). React hooks render off it. */
  state: "connecting" | "open" | "closed" = "closed";

  constructor() {
    // Three load contexts:
    //  - Browser dev: Vite proxies /agent → ws://localhost:3737 (same-origin).
    //  - Browser prod (served by the CLI): same-origin ws:// / wss:// upgrade.
    //  - Electron: the page is loaded from file:// (no origin to upgrade), so the
    //    preload injects an absolute agent URL (window.__FRANKLIN__.agentUrl).
    const injected = typeof window !== "undefined" ? window.__FRANKLIN__?.agentUrl : undefined;
    if (injected) {
      this.url = injected;
    } else if (location.protocol === "file:") {
      // Packaged Electron without an injected URL — fall back to the default
      // local agent port.
      this.url = "ws://127.0.0.1:3737/agent";
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${location.host}/agent`;
    }
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.state = "connecting";
    this.emitState();
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      console.warn("[agent-ws] connect failed:", err);
      return;
    }
    this.ws.addEventListener("open", () => {
      this.state = "open";
      this.reconnectAttempts = 0;
      this.emitState();
    });
    this.ws.addEventListener("message", (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return; // ignore unparseable frames
      }
      this.dispatch(msg);
    });
    this.ws.addEventListener("close", () => {
      this.state = "closed";
      this.emitState();
      this.failAllPending(new Error("WebSocket closed"));
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // The close handler fires next and takes care of state + reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private nextId(): string {
    this.idSeq++;
    return `m${this.idSeq}`;
  }

  private dispatch(msg: ServerMsg): void {
    const p = this.pending.get(msg.id);
    if (p) {
      if (msg.kind === "response") {
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg);
        this.pending.delete(msg.id);
      } else if (msg.kind === "error") {
        if (p.timer) clearTimeout(p.timer);
        const errMsg = (msg.payload as { message?: string })?.message || "RPC error";
        p.reject(new Error(errMsg));
        this.pending.delete(msg.id);
      } else if (p.stream) {
        // agent.* deltas during a streaming turn — keep the entry; only
        // agent.done / agent.error end the stream and trigger resolve.
        p.stream(msg);
        if (msg.kind === "agent.done" || msg.kind === "agent.error") {
          if (p.timer) clearTimeout(p.timer);
          p.resolve(msg);
          this.pending.delete(msg.id);
        }
      }
    }
    // Broadcasts (session.event / wallet.event) flow to all global listeners
    // regardless of correlation id.
    for (const l of this.listeners) l(msg);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Fire-and-forget — used by agent.cancel and agent.permissionResponse where
   *  the server emits its acknowledgement through the original turn's stream. */
  emit<T>(kind: ClientMsgKind, payload?: T): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg<T> = { id: this.nextId(), kind, payload };
    this.ws.send(JSON.stringify(msg));
  }

  /** Request/response. Resolves on the first "response" or rejects on "error"
   *  or a 30 s timeout. */
  async request<TReq, TResp = unknown>(kind: ClientMsgKind, payload?: TReq): Promise<TResp> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent server not connected");
    }
    const id = this.nextId();
    const msg: ClientMsg<TReq> = { id, kind, payload };
    return new Promise<TResp>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${kind} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (m) => resolve((m.payload as TResp) ?? (undefined as unknown as TResp)),
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  /** Streaming request — `onEvent` fires for every ServerMsg sharing this id
   *  (including the final agent.done). Returns a cancel function that emits
   *  agent.cancel for the same id. */
  stream<TReq>(kind: ClientMsgKind, payload: TReq, onEvent: Listener): () => void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent server not connected");
    }
    const id = this.nextId();
    const msg: ClientMsg<TReq> = { id, kind, payload };
    this.pending.set(id, {
      resolve: () => {},
      reject: () => {},
      stream: onEvent,
    });
    this.ws!.send(JSON.stringify(msg));
    return () => {
      const p = this.pending.get(id);
      if (p?.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      this.emit("agent.cancel", { turnId: id });
    };
  }

  /** Subscribe to ALL ServerMsg traffic — for wallet/session event broadcasts.
   *  Filter by kind inside the listener. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private stateListeners = new Set<(state: AgentSocket["state"]) => void>();
  onState(fn: (state: AgentSocket["state"]) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }
  private emitState(): void {
    for (const fn of this.stateListeners) fn(this.state);
  }

  /** Convenience matcher for hooks that only care about one server-msg kind. */
  static isKind<K extends ServerMsgKind>(msg: ServerMsg, kind: K): boolean {
    return msg.kind === kind;
  }
}

export const agent = new AgentSocket();
// Eagerly connect — the UI is useless without it. Reconnect logic handles
// the case where the CLI process isn't up yet (user opened browser first).
if (typeof window !== "undefined") agent.connect();
