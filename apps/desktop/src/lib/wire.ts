// Wire protocol — the message shapes the CLI backend and the browser exchange
// over WebSocket. Kept narrow and explicit so the CLI side can implement
// against a single type contract without sharing TS types across repos.
//
// Why WebSocket over HTTP/SSE: the agent loop is bidirectional — the UI sends
// turn input + cancel + permission responses; the CLI streams text deltas +
// tool events + activity steps. A single duplex channel keeps ordering
// trivial and avoids the SSE-vs-fetch+abort dance the franklin-run web client
// had to do for its streaming chat.
//
// Why "envelope with id" instead of plain JSON-RPC: request/response pairs
// (e.g. listSessions) and long-running streams (agent turn) coexist on the
// same socket. An `id` + `kind` envelope lets both shapes share one router
// without a parallel REST endpoint surface.

export type ClientMsgKind =
  | "agent.send"
  | "agent.cancel"
  | "agent.permissionResponse"
  | "session.list"
  | "session.load"
  | "session.delete"
  | "session.rename"
  | "wallet.info"
  | "wallet.balance"
  | "wallet.spend"
  | "wallet.tokens"
  | "wallet.swaps"
  | "history.load"
  | "history.save"
  | "models.list"
  | "mcp.list"
  | "skills.list"
  | "skills.toggle"
  | "skills.create"
  | "skills.upload"
  | "settings.get"
  | "settings.set";

export type ServerMsgKind =
  | "agent.text"          // streaming model text delta
  | "agent.tool_use"      // model is calling a tool
  | "agent.tool_result"   // tool returned
  | "agent.step"          // CLI-style activity step ("Searching the web · Exa")
  | "agent.permissionAsk" // tool needs permission (Bash, Write, etc.)
  | "agent.payment"       // x402 sign/settle event (FYI; CLI signs locally — no popup)
  | "agent.done"          // turn finished
  | "agent.error"         // turn failed
  | "session.event"       // session created/updated/deleted (broadcast)
  | "wallet.event"        // wallet balance changed
  | "response"            // response to a request/reply ClientMsg
  | "error";              // RPC-level error response to a ClientMsg id

export interface ClientMsg<T = unknown> {
  /** Correlation id. Reused for responses and streamed events that belong to
   *  a single client request. The client picks any string; server echoes it. */
  id: string;
  kind: ClientMsgKind;
  payload?: T;
}

export interface ServerMsg<T = unknown> {
  /** Echo of the ClientMsg.id this is responding to, or a fresh server-issued
   *  id for unsolicited broadcasts (wallet.event, session.event). */
  id: string;
  kind: ServerMsgKind;
  payload?: T;
}

// ─── Agent-loop payloads ──────────────────────────────────────────────────

export interface AgentSendPayload {
  /** Session id to append to, or null for a brand-new session (server returns
   *  the new id in the first agent.* event's payload.sessionId). */
  sessionId: string | null;
  /** Plain text user input. Tool results and assistant turns are server-owned. */
  text: string;
  /** Optional client-side file references resolved to absolute paths. The CLI
   *  Read tool inlines them as it would for an Ink turn. */
  attachments?: Array<{ path: string; mediaType?: string }>;
  /** Override model for this turn only (default: session's active model). */
  model?: string;
  /** Force a specific tool for this turn (CLI "focus mode" — agent must call
   *  this tool first regardless of routing). */
  forceTool?: string;
  /** Composer mode: "chat" (default), or "image"/"video"/"music" media
   *  generation. The CLI uses this to bias toward its media generation tools. */
  mode?: "chat" | "image" | "video" | "music";
  /** Local conversation id this turn belongs to. The server resets its agent
   *  history when this changes, so separate sidebar conversations don't bleed
   *  context into each other (the server runs one long-lived session). */
  convId?: string;
}

export interface AgentTextDelta {
  sessionId: string;
  text: string;
  /** True if this delta closes a reasoning block; the UI collapses the prior
   *  deltas under a "Thoughts" disclosure rather than rendering inline. */
  reasoning?: boolean;
}

export interface AgentToolUse {
  sessionId: string;
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResult {
  sessionId: string;
  toolCallId: string;
  /** Truncated for display; server keeps full result in session storage. */
  preview: string;
  /** Path + media for file/image returns so the UI can render an inline
   *  thumbnail or download link. */
  artifacts?: Array<{ path: string; mediaType: string; bytes?: number }>;
  isError?: boolean;
}

export interface AgentStep {
  sessionId: string;
  /** "thinking" → model is generating; "run" → tool is executing; "sign" → CLI
   *  is signing an x402 payment; "done" → step finished. */
  state: "thinking" | "run" | "sign" | "done";
  label: string;
  /** Per-call detail — the tool's key argument (query/prompt/symbol/url…),
   *  shown as small text next to the tool so you see WHAT it's doing. */
  detail?: string;
  /** Steps the server emits with the same id update in place rather than
   *  appending a new line — mirrors the Ink CLI's spinner-then-checkmark. */
  stepId: number;
}

export interface AgentPermissionAsk {
  sessionId: string;
  toolName: string;
  description: string;
  /** Echo this in the agent.permissionResponse to unblock the agent loop. */
  askId: string;
}

export interface AgentPermissionResponse {
  askId: string;
  /** "y" / "n" / "always" — matches the CLI prompt verbs. */
  decision: "y" | "n" | "always";
}

export interface AgentPayment {
  sessionId: string;
  /** "verify" → just probed; "sign" → wallet signed the authorization; "settle"
   *  → on-chain transfer landed. CLI signs from local key, never asks user. */
  phase: "verify" | "sign" | "settle";
  model: string;
  usd: number;
  chain: "base" | "solana";
}

export interface AgentDone {
  sessionId: string;
  /** Cost rolled up for this turn. */
  costUsd: number;
}

export interface AgentError {
  sessionId: string;
  message: string;
  /** Maps to the CLI's error-classifier label. UI uses this to decide whether
   *  to show a retry button vs a wallet-config tip. */
  label?: string;
}

// ─── Session / wallet / models RPC payloads ───────────────────────────────

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Last-known model (so the picker can default per-session, like the CLI). */
  lastModel?: string;
}

export interface WalletInfo {
  address: string;
  chain: "base" | "solana";
  balanceUsd?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  free: boolean;
  /** Provider/company the models are grouped under (Anthropic, OpenAI, …). */
  group: string;
  provider?: string;
  /** Pricing in $/M tokens. Undefined for free / flat-priced. */
  inputPrice?: number;
  outputPrice?: number;
  contextWindow?: number;
}
