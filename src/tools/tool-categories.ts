/**
 * Tool visibility categories.
 *
 * Franklin ships with ~27 capabilities. Exposing all of them to the model on
 * every turn makes the tool inventory large enough that weak models start
 * hallucinating tool names or emitting role-play "[TOOLCALL]" fragments.
 * The fix: keep a minimal always-on core (file ops, shell, ask) and gate the
 * rest behind an `ActivateTool` meta-tool that the agent pulls on demand —
 * the same per-session visibility pattern that OpenBB's MCP server uses.
 *
 * `CORE_TOOL_NAMES` is the per-session initial active set. Everything else
 * becomes visible only after the agent calls ActivateTool with its name.
 */

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // File operations — nothing else works without these.
  'Read',
  'Write',
  'Edit',
  // Shell execution — needed for running tests, builds, scripts.
  'Bash',
  // Search — code exploration is table stakes.
  'Grep',
  'Glob',
  // User dialogue — the agent must be able to ask for clarification.
  'AskUser',
  // Sub-agent delegation — the sub-agent has its own tool resolution,
  // so keeping this in the core doesn't leak the full inventory.
  'Task',
  // The meta-tool itself — must always be callable so the agent can
  // discover and activate the rest.
  'ActivateTool',
]);

/** True if this tool is always available without activation. */
export function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.has(name);
}

/**
 * Env opt-out: setting `FRANKLIN_DYNAMIC_TOOLS=0` disables the core/on-demand
 * split and exposes every registered tool on every turn (pre-3.8.9 behavior).
 * Kept as a safety valve for users whose workflows depend on the full surface.
 */
export function dynamicToolsEnabled(): boolean {
  return process.env.FRANKLIN_DYNAMIC_TOOLS !== '0';
}
