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

export interface CapabilityOutcome {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentPart[];
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
}

// ─── Execution Scope ───────────────────────────────────────────────────────

export interface ExecutionScope {
  workingDir: string;
  abortSignal: AbortSignal;
  onProgress?: (text: string) => void;
  /** Routes AskUser questions through ink UI input to avoid raw-mode stdin conflict */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
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
  reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'budget' | 'no_progress';
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
}
