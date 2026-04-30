/**
 * Tool visibility categories.
 *
 * Franklin ships with ~27 capabilities. Exposing all of them on every turn
 * makes the tool inventory large enough that weak models start hallucinating
 * tool names or emitting role-play "[TOOLCALL]" fragments. The compromise:
 * keep the hero surface always-on (file/shell/search PLUS the trading and
 * research tools that define Franklin's category), and gate the long tail
 * (webhook, imagegen, videogen, musicgen, memory, etc.) behind an
 * `ActivateTool` meta-tool the agent pulls on demand.
 *
 * History: earlier releases kept only file/shell/search in core, which made
 * mid-tier models answer stock / market questions from 2022 training data
 * instead of calling TradingMarket. That's anti-positioning for an agent
 * whose whole brand is "spends USDC for real market data." Hero tools now
 * live in the always-on set so the default experience shows the wallet
 * actually at work.
 */

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // File operations — nothing else works without these.
  'Read',
  'Write',
  'Edit',
  // Shell execution — needed for running tests, builds, scripts.
  'Bash',
  // Detached background execution — bash-adjacent: spawns a long-running
  // command that survives Franklin exiting. Belongs in core so the agent
  // can offload >20-item iteration without first activating a meta-tool.
  'Detach',
  // Search — code exploration is table stakes.
  'Grep',
  'Glob',
  // User dialogue — the agent must be able to ask for clarification.
  'AskUser',
  // Sub-agent delegation — the sub-agent has its own tool resolution,
  // so keeping this in the core doesn't leak the full inventory.
  'Task',
  // The meta-tool itself — must always be callable so the agent can
  // discover and activate anything not in this core set.
  'ActivateTool',
  // ── Hero surface: Franklin's reason to exist ────────────────────────
  // Trading market data — crypto, FX, commodity, stocks (via x402).
  // "Is NVDA up?" / "Should I sell CRCL?" must never fall back to
  // training-data guessing.
  'TradingMarket',
  'TradingSignal',
  // Research — synthesized answers with real citations, semantic web
  // search, and clean URL fetching. Any factual current-events question
  // ("why did X drop?") should route here rather than the model's prior.
  'ExaAnswer',
  'ExaSearch',
  'ExaReadUrls',
  // Plain web fetch — specific URL → readable text. Cheap and obvious
  // enough that every model tends to pick it correctly.
  'WebFetch',
  'WebSearch',
  // Wallet read — Franklin is the agent with a wallet, so balance + chain
  // + address must be a one-call answer rather than a Bash shell-out.
  'Wallet',
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
