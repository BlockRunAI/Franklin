/**
 * Franklin Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 */
import type { AgentConfig, Dialogue, StreamEvent } from './types.js';
/**
 * Run a multi-turn interactive session.
 * Each user message triggers a full agent loop.
 * Returns the accumulated conversation history.
 */
export declare function interactiveSession(config: AgentConfig, getUserInput: () => Promise<string | null>, onEvent: (event: StreamEvent) => void, onAbortReady?: (abort: () => void) => void): Promise<Dialogue[]>;
