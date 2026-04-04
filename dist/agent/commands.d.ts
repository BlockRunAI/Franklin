/**
 * Slash command registry for runcode.
 * Extracted from loop.ts for maintainability.
 *
 * Two types of commands:
 * 1. "Handled" — execute directly, emit events, return { handled: true }
 * 2. "Rewrite" — transform input into a prompt for the agent, return { handled: false, rewritten }
 */
import type { ModelClient } from './llm.js';
import type { AgentConfig, Dialogue, StreamEvent } from './types.js';
type EventEmitter = (event: StreamEvent) => void;
interface CommandContext {
    history: Dialogue[];
    config: AgentConfig;
    client: ModelClient;
    sessionId: string;
    onEvent: EventEmitter;
}
interface CommandResult {
    handled: boolean;
    rewritten?: string;
}
/**
 * Handle a slash command. Returns result indicating what happened.
 */
export declare function handleSlashCommand(input: string, ctx: CommandContext): Promise<CommandResult>;
export {};
