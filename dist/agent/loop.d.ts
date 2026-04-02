/**
 * runcode Agent Loop
 * The core reasoning-action cycle: prompt → model → extract capabilities → execute → repeat.
 * Original implementation with different architecture from any reference codebase.
 */
import type { AgentConfig, Dialogue, StreamEvent } from './types.js';
/**
 * Run the agent loop.
 * Yields StreamEvents for the UI to render. Returns when the conversation ends.
 */
export declare function runAgent(config: AgentConfig, initialPrompt: string): AsyncGenerator<StreamEvent, void>;
/**
 * Run a multi-turn interactive session.
 * Each user message triggers a full agent loop.
 * Returns the accumulated conversation history.
 */
export declare function interactiveSession(config: AgentConfig, getUserInput: () => Promise<string | null>, onEvent: (event: StreamEvent) => void): Promise<Dialogue[]>;
