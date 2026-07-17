/**
 * Lifecycle hooks — user-authored guardrails and automations.
 *
 * Hooks are external commands the harness runs at fixed lifecycle points.
 * They receive a JSON envelope on stdin and can veto the action (blocking
 * events only) by exiting 2 or printing {"decision":"deny"} on stdout.
 *
 * Safety model: hooks are a convenience layer, not a security boundary.
 * A hook that crashes, times out, or is missing FAILS OPEN — work proceeds
 * and the failure is logged. Only an explicit deny blocks. This keeps a
 * buggy hook from bricking the agent while still letting deliberate policy
 * (spend caps, token blacklists) intercept actions.
 */

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd'
  | 'PreSpend'
  | 'PostSpend';

/** Events whose handlers can veto the action. All others are notify-only. */
export const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set([
  'PreToolUse',
  'PreSpend',
]);

/** Events that carry no tool context — a matcher on these is a config error. */
export const LIFECYCLE_EVENTS: ReadonlySet<HookEvent> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
]);

export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
  'PreSpend',
  'PostSpend',
]);

export interface HookHandlerDef {
  type: 'command';
  /** Shell command. A bare relative path resolves against the hook file's dir. */
  command: string;
  /** Seconds before the handler is killed and treated as allow. Default 5. */
  timeout?: number;
  env?: Record<string, string>;
}

export interface HookMatcherDef {
  /** Regex tested against the tool name. Absent/empty = match all. */
  matcher?: string;
  hooks: HookHandlerDef[];
}

/** On-disk file shape: { "hooks": { "<Event>": [ {matcher, hooks:[...]} ] } } */
export interface HookConfigFile {
  hooks: Partial<Record<string, HookMatcherDef[]>>;
}

/** Loaded + validated handler with provenance for logs and the /hooks UI. */
export interface LoadedHook {
  event: HookEvent;
  matcher?: RegExp;
  handler: HookHandlerDef;
  /** Absolute path of the JSON file this hook came from. */
  sourceFile: string;
  scope: 'user' | 'project';
}

/** stdin envelope delivered to every handler. */
export interface HookInput {
  hookEventName: HookEvent;
  sessionId: string;
  cwd: string;
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Present on PreSpend/PostSpend. estimatedUsd is null when unknown. */
  spend?: {
    estimatedUsd: number | null;
    tool: string;
    params: Record<string, unknown>;
  };
}

export interface HookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}
