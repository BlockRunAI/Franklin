/**
 * Core types for the Franklin agent system.
 * All type names and structures are original designs.
 */

// ─── Messages ──────────────────────────────────────────────────────────────

export type Role = 'user' | 'assistant';

export interface TextSegment {
  type: 'text';
  text: string;
}

export interface CapabilityInvocation {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingSegment {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ImageSegment {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface CapabilityOutcome {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextSegment | ImageSegment>;
  is_error?: boolean;
}

export type ContentPart = TextSegment | CapabilityInvocation | ThinkingSegment;
export type UserContentPart = TextSegment | CapabilityOutcome;

export interface Dialogue {
  role: Role;
  content: ContentPart[] | UserContentPart[] | string;
}

// ─── Capabilities (Tools) ──────────────────────────────────────────────────

export interface CapabilitySchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CapabilityDefinition {
  name: string;
  description: string;
  input_schema: CapabilitySchema;
}

export interface CapabilityHandler {
  spec: CapabilityDefinition;
  execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult>;
  concurrent?: boolean; // safe to run in parallel with other concurrent capabilities
  /** Dynamic concurrency check — called per-invocation. Overrides `concurrent` when provided. */
  isConcurrentSafe?: (input: Record<string, unknown>) => boolean;
}

export interface CapabilityResult {
  output: string;
  isError?: boolean;
  /** Structured diff for Edit tool — enables colored diff display in UI. */
  diff?: { file: string; oldLines: string[]; newLines: string[]; count: number };
  /** Full tool output for expandable display — separate from truncated preview. */
  fullOutput?: string;
  /**
   * Optional image attachments emitted by a tool (e.g. Read on a .png).
   * The agent loop wraps these into an Anthropic-native tool_result.content
   * array so vision-capable models can actually see the bytes instead of
   * getting a "Binary file" stub.
   */
  images?: Array<{ mediaType: string; base64: string }>;
}

// ─── Execution Scope ───────────────────────────────────────────────────────

export interface ExecutionScope {
  workingDir: string;
  abortSignal: AbortSignal;
  onProgress?: (text: string) => void;
  /** Routes AskUser questions through ink UI input to avoid raw-mode stdin conflict */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  /**
   * Structured approval surface (trade plans, dashboard-answered prompts).
   * Wired from AgentConfig.approvalPromptFn. Absent = fail closed for
   * anything that requires an explicit decision.
   */
  onApproval?: import('./approvals.js').ApprovalPromptFn;
  /** Context from parent agent — helps sub-agents avoid duplicate work */
  parentContext?: {
    goal?: string;
    recentFiles?: string[];
  };
}

// ─── Streaming Events ──────────────────────────────────────────────────────

export interface StreamTextDelta {
  kind: 'text_delta';
  text: string;
}

export interface StreamThinkingDelta {
  kind: 'thinking_delta';
  text: string;
}

export interface StreamCapabilityStart {
  kind: 'capability_start';
  id: string;
  name: string;
  preview?: string; // Short description shown in spinner (e.g. truncated command for Bash)
}

export interface StreamCapabilityInputDelta {
  kind: 'capability_input_delta';
  id: string;
  delta: string;
}

export interface StreamCapabilityProgress {
  kind: 'capability_progress';
  id: string;
  text: string; // Latest output snippet — streams last-line while tool is running
}

export interface StreamCapabilityDone {
  kind: 'capability_done';
  id: string;
  result: CapabilityResult;
}

export interface StreamTurnDone {
  kind: 'turn_done';
  reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'budget' | 'no_progress' | 'cap_exceeded';
  error?: string;
}

export interface StreamUsageInfo {
  kind: 'usage';
  inputTokens: number;
  outputTokens: number;
  model: string;
  calls: number;
  // Routing transparency — populated when using a routing profile
  tier?: 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
  confidence?: number;
  savings?: number; // 0-1, percentage savings vs Opus
  // Context window utilization
  contextPct?: number; // 0-100
}

export type StreamEvent =
  | StreamTextDelta
  | StreamThinkingDelta
  | StreamCapabilityStart
  | StreamCapabilityInputDelta
  | StreamCapabilityProgress
  | StreamCapabilityDone
  | StreamTurnDone
  | StreamUsageInfo;

// ─── Agent Configuration ───────────────────────────────────────────────────

export interface AgentConfig {
  model: string;
  apiUrl: string;
  chain: 'base' | 'solana';
  systemInstructions: string[];
  capabilities: CapabilityHandler[];
  maxTurns?: number;
  workingDir?: string;
  permissionMode?: 'default' | 'trust' | 'deny-all' | 'plan';
  onEvent?: (event: StreamEvent) => void;
  debug?: boolean;
  /** Ultrathink mode: inject deep-reasoning instruction into every prompt */
  ultrathink?: boolean;
  /**
   * Permission prompt function — injected by Ink UI to avoid stdin conflict.
   * Replaces the readline-based askQuestion() when running in interactive mode.
   * Returns 'yes' | 'no' | 'always' (always = allow for rest of session).
   */
  permissionPromptFn?: (toolName: string, description: string) => Promise<'yes' | 'no' | 'always'>;
  /** Routes AskUser questions through ink UI input to avoid raw-mode stdin conflict */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  /** Notify UI when agent switches model. `reason` is 'user' for explicit /model
   *  commands and 'system' for payment fallbacks or recovery. User-initiated
   *  changes must also update `baseModel`. */
  onModelChange?: (model: string, reason?: 'user' | 'system') => void;
  /** The user's intended model — updated by /model command, used for turn recovery */
  baseModel?: string;
  /** Resume an existing session by ID — loads prior history and keeps appending to the same JSONL */
  resumeSessionId?: string;
  /** Notify callers of the concrete session ID once created/resolved. */
  onSessionStart?: (sessionId: string) => void;
  /**
   * Optional channel tag persisted to SessionMeta. Lets non-CLI drivers
   * (Telegram bot, Discord bot, future ingresses) find their own sessions
   * later via findLatestSessionByChannel. Regular CLI sessions leave this
   * unset. Format: "<driver>:<owner-or-chat-id>", e.g. "telegram:12345".
   */
  sessionChannel?: string;
  /**
   * Hard cap on total USD spend for this session. When accumulated API cost
   * crosses the cap, the loop stops with `reason: 'budget'`. Zero/negative
   * values disable the cap. Primary use case: batch/scripted callers that must
   * bound a single run to keep autonomous execution inside a known envelope.
   */
  maxSpendUsd?: number;
  /** Show user-visible harness prefetch status lines (interactive UX only). */
  showPrefetchStatus?: boolean;
  /**
   * On the final turn, withhold tools so the model must commit to a text answer
   * instead of researching until cut off. For one-shot forecasting/extraction
   * callers (e.g. `franklin predict`) where some models never stop calling tools
   * and would otherwise hit maxTurns with no answer.
   */
  forceAnswerOnFinalTurn?: boolean;
  /**
   * Hard cap on total tool calls for the turn. Once reached, tools are withheld
   * and the model is forced to answer from what it has. Bounds research/cost
   * deterministically (a turn budget alone doesn't — a turn may have no tool).
   */
  maxToolCalls?: number;
  /**
   * Disable Franklin's automatic model-switching (empty-response / stalled-intent
   * fallbacks). One-shot callers want a clean abstain from the requested model,
   * not a silent switch to a different one.
   */
  disableModelFallback?: boolean;
  /**
   * Disable the post-response "ungrounded claims → force a tool-use retry" guard.
   * It fights the forced-answer path and pollutes one-shot structured output.
   */
  disableGroundingRetry?: boolean;
  /** Mid-turn "research-bloat" compaction — summarizes history when a turn
   *  racks up many tool calls + spend, to cut input-replay cost. Default on;
   *  set false to disable (the desktop exposes this as a toggle). */
  costSaver?: boolean;
  /**
   * Lifecycle hook engine. When unset, the loop builds one from the working
   * directory's hook files (~/.blockrun/hooks + trusted project .franklin/hooks).
   * Callers inject a prebuilt engine to share it across sessions or to stub
   * hooks in tests. FRANKLIN_HOOKS=0 disables hooks regardless.
   */
  hooks?: import('../hooks/runner.js').HookEngine;
  /**
   * Structured approval prompt (trade plans and future approvables). The TUI
   * routes it through the ask-user modal; serve routes it through a broker to
   * remote clients; headless runs install an auto-policy honoring
   * --approve-trades + --max-spend. Absent = approvals fail closed.
   */
  approvalPromptFn?: import('./approvals.js').ApprovalPromptFn;
}
