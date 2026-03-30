/**
 * SSE Event Translator: OpenAI → Anthropic Messages API format
 *
 * Handles three critical gaps in the streaming pipeline:
 * 1. Tool calls: choice.delta.tool_calls → content_block_start/content_block_delta (tool_use)
 * 2. Reasoning: reasoning_content → content_block_start/content_block_delta (thinking)
 * 3. Ensures proper content_block_stop and message_stop events
 */
export declare class SSETranslator {
    private state;
    private buffer;
    constructor(model?: string);
    /**
     * Detect whether an SSE chunk is in OpenAI format.
     * Returns true if it contains OpenAI-style `choices[].delta` structure.
     */
    static isOpenAIFormat(chunk: string): boolean;
    /**
     * Process a raw SSE text chunk and return translated Anthropic-format SSE events.
     * Returns null if no translation needed (already Anthropic format or not parseable).
     */
    processChunk(rawChunk: string): string | null;
    private parseSSEEvents;
    private formatSSE;
    private closeThinkingBlock;
    private closeTextBlock;
    private closeToolCalls;
    private closeActiveBlocks;
}
