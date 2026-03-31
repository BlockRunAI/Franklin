/**
 * SSE Event Translator: OpenAI → Anthropic Messages API format
 *
 * Handles three critical gaps in the streaming pipeline:
 * 1. Tool calls: choice.delta.tool_calls → content_block_start/content_block_delta (tool_use)
 * 2. Reasoning: reasoning_content → content_block_start/content_block_delta (thinking)
 * 3. Ensures proper content_block_stop and message_stop events
 */

interface TranslatorState {
  messageId: string;
  model: string;
  blockIndex: number;
  activeToolCalls: Map<number, { id: string; name: string }>;
  thinkingBlockActive: boolean;
  textBlockActive: boolean;
  messageStarted: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface SSEEvent {
  event?: string;
  data: string;
}

// ─── SSE Translator ─────────────────────────────────────────────────────────
export class SSETranslator {
  private state: TranslatorState;
  private buffer = '';

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
  static isOpenAIFormat(chunk: string): boolean {
    return (
      chunk.includes('"choices"') &&
      chunk.includes('"delta"') &&
      !chunk.includes('"content_block_')
    );
  }

  /**
   * Process a raw SSE text chunk and return translated Anthropic-format SSE events.
   * Returns null if no translation needed (already Anthropic format or not parseable).
   */
  processChunk(rawChunk: string): string | null {
    this.buffer += rawChunk;
    const events = this.parseSSEEvents();
    if (events.length === 0) return null;

    const translated: string[] = [];

    for (const event of events) {
      if (event.data === '[DONE]') {
        translated.push(...this.closeActiveBlocks());
        translated.push(
          this.formatSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: this.state.outputTokens },
          })
        );
        translated.push(this.formatSSE('message_stop', { type: 'message_stop' }));
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }

      // Skip if not OpenAI format
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) {
        // Could be a usage-only event
        const usage = parsed.usage as Record<string, number> | undefined;
        if (usage) {
          this.state.inputTokens = usage.prompt_tokens ?? 0;
          this.state.outputTokens = usage.completion_tokens ?? 0;
        }
        continue;
      }

      // Emit message_start on first chunk
      if (!this.state.messageStarted) {
        this.state.messageStarted = true;
        if (parsed.model) this.state.model = parsed.model as string;
        translated.push(
          this.formatSSE('message_start', {
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
          })
        );
        translated.push(this.formatSSE('ping', { type: 'ping' }));
      }

      const choice = choices[0] as Record<string, unknown>;
      const delta = choice.delta as Record<string, unknown>;

      // ── Reasoning content → thinking block ──
      if (delta.reasoning_content) {
        if (!this.state.thinkingBlockActive) {
          if (this.state.textBlockActive) translated.push(...this.closeTextBlock());
          this.state.thinkingBlockActive = true;
          translated.push(
            this.formatSSE('content_block_start', {
              type: 'content_block_start',
              index: this.state.blockIndex,
              content_block: { type: 'thinking', thinking: '' },
            })
          );
        }
        translated.push(
          this.formatSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.state.blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          })
        );
        this.state.outputTokens++;
      }

      // ── Text content → text block ──
      if (delta.content) {
        if (this.state.thinkingBlockActive) translated.push(...this.closeThinkingBlock());
        if (!this.state.textBlockActive) {
          translated.push(...this.closeToolCalls());
          this.state.textBlockActive = true;
          translated.push(
            this.formatSSE('content_block_start', {
              type: 'content_block_start',
              index: this.state.blockIndex,
              content_block: { type: 'text', text: '' },
            })
          );
        }
        translated.push(
          this.formatSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.state.blockIndex,
            delta: { type: 'text_delta', text: delta.content },
          })
        );
        this.state.outputTokens++;
      }

      // ── Tool calls → tool_use blocks ──
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        if (this.state.thinkingBlockActive) translated.push(...this.closeThinkingBlock());
        if (this.state.textBlockActive) translated.push(...this.closeTextBlock());

        for (const tc of toolCalls) {
          const tcIndex = tc.index as number;
          const fn = tc.function as Record<string, string> | undefined;

          if (tc.id && fn?.name) {
            if (this.state.activeToolCalls.has(tcIndex)) {
              translated.push(
                this.formatSSE('content_block_stop', {
                  type: 'content_block_stop',
                  index: this.state.blockIndex,
                })
              );
              this.state.blockIndex++;
            }
            this.state.activeToolCalls.set(tcIndex, { id: tc.id as string, name: fn.name });
            translated.push(
              this.formatSSE('content_block_start', {
                type: 'content_block_start',
                index: this.state.blockIndex,
                content_block: { type: 'tool_use', id: tc.id, name: fn.name, input: {} },
              })
            );
            if (fn.arguments) {
              translated.push(
                this.formatSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: this.state.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: fn.arguments },
                })
              );
            }
          } else if (fn?.arguments) {
            translated.push(
              this.formatSSE('content_block_delta', {
                type: 'content_block_delta',
                index: this.state.blockIndex,
                delta: { type: 'input_json_delta', partial_json: fn.arguments },
              })
            );
          }
        }
        this.state.outputTokens++;
      }

      // ── Handle finish_reason ──
      if (choice.finish_reason) {
        translated.push(...this.closeActiveBlocks());
        const stopReason =
          choice.finish_reason === 'tool_calls'
            ? 'tool_use'
            : choice.finish_reason === 'stop'
              ? 'end_turn'
              : choice.finish_reason;
        translated.push(
          this.formatSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: this.state.outputTokens },
          })
        );
      }
    }

    return translated.length > 0 ? translated.join('') : null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private parseSSEEvents(): SSEEvent[] {
    const events: SSEEvent[] = [];
    const lines = this.buffer.split('\n');
    let currentEvent: string | undefined;
    let dataLines: string[] = [];
    let consumed = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line === '' && dataLines.length > 0) {
        events.push({ event: currentEvent, data: dataLines.join('\n') });
        currentEvent = undefined;
        dataLines = [];
        consumed = lines.slice(0, i + 1).join('\n').length + 1;
      }
    }

    if (consumed > 0) this.buffer = this.buffer.slice(consumed);
    return events;
  }

  private formatSSE(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private closeThinkingBlock(): string[] {
    if (!this.state.thinkingBlockActive) return [];
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

  private closeTextBlock(): string[] {
    if (!this.state.textBlockActive) return [];
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

  private closeToolCalls(): string[] {
    if (this.state.activeToolCalls.size === 0) return [];
    const events: string[] = [];
    for (const [_index] of this.state.activeToolCalls) {
      events.push(
        this.formatSSE('content_block_stop', {
          type: 'content_block_stop',
          index: this.state.blockIndex,
        })
      );
      this.state.blockIndex++;
    }
    this.state.activeToolCalls.clear();
    return events;
  }

  private closeActiveBlocks(): string[] {
    return [
      ...this.closeThinkingBlock(),
      ...this.closeTextBlock(),
      ...this.closeToolCalls(),
    ];
  }
}
