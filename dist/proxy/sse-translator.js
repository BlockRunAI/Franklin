/**
 * SSE Event Translator: OpenAI → Anthropic Messages API format
 *
 * Handles three critical gaps in the streaming pipeline:
 * 1. Tool calls: choice.delta.tool_calls → content_block_start/content_block_delta (tool_use)
 * 2. Reasoning: reasoning_content → content_block_start/content_block_delta (thinking)
 * 3. Ensures proper content_block_stop and message_stop events
 */
// ─── SSE Translator ─────────────────────────────────────────────────────────
export class SSETranslator {
    state;
    buffer = '';
    constructor(model = 'unknown') {
        this.state = {
            messageId: `msg_brcc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            model,
            blockIndex: 0,
            activeToolCalls: new Map(),
            thinkingBlockActive: false,
            textBlockActive: false,
            messageStarted: false,
            inputTokens: 0,
            outputTokens: 0,
        };
    }
    /**
     * Detect whether an SSE chunk is in OpenAI format.
     * Returns true if it contains OpenAI-style `choices[].delta` structure.
     */
    static isOpenAIFormat(chunk) {
        // Look for OpenAI-specific patterns in the SSE data
        return (chunk.includes('"choices"') &&
            chunk.includes('"delta"') &&
            !chunk.includes('"content_block_'));
    }
    /**
     * Process a raw SSE text chunk and return translated Anthropic-format SSE events.
     * Returns null if no translation needed (already Anthropic format or not parseable).
     */
    processChunk(rawChunk) {
        this.buffer += rawChunk;
        const events = this.parseSSEEvents();
        if (events.length === 0)
            return null;
        const translated = [];
        for (const event of events) {
            if (event.data === '[DONE]') {
                // Close any active blocks, then emit message_stop
                translated.push(...this.closeActiveBlocks());
                translated.push(this.formatSSE('message_delta', {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { output_tokens: this.state.outputTokens },
                }));
                translated.push(this.formatSSE('message_stop', { type: 'message_stop' }));
                continue;
            }
            let parsed;
            try {
                parsed = JSON.parse(event.data);
            }
            catch {
                continue;
            }
            // Skip if this doesn't look like OpenAI format
            if (!parsed.choices || parsed.choices.length === 0) {
                // Could be a usage-only event
                if (parsed.usage) {
                    this.state.inputTokens = parsed.usage.prompt_tokens || 0;
                    this.state.outputTokens = parsed.usage.completion_tokens || 0;
                }
                continue;
            }
            // Emit message_start on first chunk
            if (!this.state.messageStarted) {
                this.state.messageStarted = true;
                if (parsed.model)
                    this.state.model = parsed.model;
                translated.push(this.formatSSE('message_start', {
                    type: 'message_start',
                    message: {
                        id: this.state.messageId,
                        type: 'message',
                        role: 'assistant',
                        model: this.state.model,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: this.state.inputTokens, output_tokens: 0 },
                    },
                }));
                translated.push(this.formatSSE('ping', { type: 'ping' }));
            }
            const choice = parsed.choices[0];
            const delta = choice.delta;
            // ── Reasoning content → thinking block ──
            if (delta.reasoning_content) {
                if (!this.state.thinkingBlockActive) {
                    // Close text block if active
                    if (this.state.textBlockActive) {
                        translated.push(...this.closeTextBlock());
                    }
                    this.state.thinkingBlockActive = true;
                    translated.push(this.formatSSE('content_block_start', {
                        type: 'content_block_start',
                        index: this.state.blockIndex,
                        content_block: { type: 'thinking', thinking: '' },
                    }));
                }
                translated.push(this.formatSSE('content_block_delta', {
                    type: 'content_block_delta',
                    index: this.state.blockIndex,
                    delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
                }));
                this.state.outputTokens++;
            }
            // ── Text content → text block ──
            if (delta.content) {
                // Close thinking block if transitioning
                if (this.state.thinkingBlockActive) {
                    translated.push(...this.closeThinkingBlock());
                }
                if (!this.state.textBlockActive) {
                    // Close any active tool calls first
                    translated.push(...this.closeToolCalls());
                    this.state.textBlockActive = true;
                    translated.push(this.formatSSE('content_block_start', {
                        type: 'content_block_start',
                        index: this.state.blockIndex,
                        content_block: { type: 'text', text: '' },
                    }));
                }
                translated.push(this.formatSSE('content_block_delta', {
                    type: 'content_block_delta',
                    index: this.state.blockIndex,
                    delta: { type: 'text_delta', text: delta.content },
                }));
                this.state.outputTokens++;
            }
            // ── Tool calls → tool_use blocks ──
            if (delta.tool_calls && delta.tool_calls.length > 0) {
                // Close thinking/text blocks first
                if (this.state.thinkingBlockActive) {
                    translated.push(...this.closeThinkingBlock());
                }
                if (this.state.textBlockActive) {
                    translated.push(...this.closeTextBlock());
                }
                for (const tc of delta.tool_calls) {
                    const tcIndex = tc.index;
                    if (tc.id && tc.function?.name) {
                        // New tool call start
                        // Close previous tool call at same index if exists
                        if (this.state.activeToolCalls.has(tcIndex)) {
                            translated.push(this.formatSSE('content_block_stop', {
                                type: 'content_block_stop',
                                index: this.state.blockIndex,
                            }));
                            this.state.blockIndex++;
                        }
                        const toolId = tc.id;
                        const toolName = tc.function.name;
                        this.state.activeToolCalls.set(tcIndex, { id: toolId, name: toolName });
                        translated.push(this.formatSSE('content_block_start', {
                            type: 'content_block_start',
                            index: this.state.blockIndex,
                            content_block: {
                                type: 'tool_use',
                                id: toolId,
                                name: toolName,
                                input: {},
                            },
                        }));
                        // If there are initial arguments, send them
                        if (tc.function.arguments) {
                            translated.push(this.formatSSE('content_block_delta', {
                                type: 'content_block_delta',
                                index: this.state.blockIndex,
                                delta: {
                                    type: 'input_json_delta',
                                    partial_json: tc.function.arguments,
                                },
                            }));
                        }
                    }
                    else if (tc.function?.arguments) {
                        // Continuation of existing tool call - stream arguments
                        translated.push(this.formatSSE('content_block_delta', {
                            type: 'content_block_delta',
                            index: this.state.blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: tc.function.arguments,
                            },
                        }));
                    }
                }
                this.state.outputTokens++;
            }
            // ── Handle finish_reason ──
            if (choice.finish_reason) {
                translated.push(...this.closeActiveBlocks());
                const stopReason = choice.finish_reason === 'tool_calls'
                    ? 'tool_use'
                    : choice.finish_reason === 'stop'
                        ? 'end_turn'
                        : choice.finish_reason;
                translated.push(this.formatSSE('message_delta', {
                    type: 'message_delta',
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: this.state.outputTokens },
                }));
            }
        }
        return translated.length > 0 ? translated.join('') : null;
    }
    // ── Helpers ─────────────────────────────────────────────────────────────
    parseSSEEvents() {
        const events = [];
        const lines = this.buffer.split('\n');
        let currentEvent;
        let dataLines = [];
        let consumed = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
            }
            else if (line.startsWith('data: ')) {
                dataLines.push(line.slice(6));
            }
            else if (line === '' && dataLines.length > 0) {
                // End of event
                events.push({ event: currentEvent, data: dataLines.join('\n') });
                currentEvent = undefined;
                dataLines = [];
                consumed = lines.slice(0, i + 1).join('\n').length + 1;
            }
        }
        // Keep unconsumed text in buffer
        if (consumed > 0) {
            this.buffer = this.buffer.slice(consumed);
        }
        return events;
    }
    formatSSE(event, data) {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }
    closeThinkingBlock() {
        if (!this.state.thinkingBlockActive)
            return [];
        this.state.thinkingBlockActive = false;
        const events = [
            this.formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: this.state.blockIndex,
            }),
        ];
        this.state.blockIndex++;
        return events;
    }
    closeTextBlock() {
        if (!this.state.textBlockActive)
            return [];
        this.state.textBlockActive = false;
        const events = [
            this.formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: this.state.blockIndex,
            }),
        ];
        this.state.blockIndex++;
        return events;
    }
    closeToolCalls() {
        if (this.state.activeToolCalls.size === 0)
            return [];
        const events = [];
        for (const [_index] of this.state.activeToolCalls) {
            events.push(this.formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: this.state.blockIndex,
            }));
            this.state.blockIndex++;
        }
        this.state.activeToolCalls.clear();
        return events;
    }
    closeActiveBlocks() {
        const events = [];
        events.push(...this.closeThinkingBlock());
        events.push(...this.closeTextBlock());
        events.push(...this.closeToolCalls());
        return events;
    }
}
