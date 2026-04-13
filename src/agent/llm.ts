/**
 * LLM Client for runcode
 * Calls BlockRun API directly with x402 payment handling and streaming.
 * Original implementation — not derived from any existing codebase.
 */

import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import { USER_AGENT, type Chain } from '../config.js';
import type {
  Dialogue,
  CapabilityDefinition,
  ContentPart,
  CapabilityInvocation,
  TextSegment,
  ThinkingSegment,
} from './types.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ModelRequest {
  model: string;
  messages: Dialogue[];
  system?: string;
  tools?: CapabilityDefinition[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

export interface StreamChunk {
  kind: 'content_block_start' | 'content_block_delta' | 'content_block_stop'
      | 'message_start' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  payload: Record<string, unknown>;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMClientOptions {
  apiUrl: string;
  chain: Chain;
  debug?: boolean;
}

// ─── Anthropic Prompt Caching ─────────────────────────────────────────────

/**
 * Apply Anthropic prompt caching using the `system_and_3` strategy.
 * Pattern from nousresearch/hermes-agent `agent/prompt_caching.py`.
 *
 * Places 4 cache_control breakpoints (Anthropic's max):
 *   1. System prompt (stable across all turns)
 *   2-4. Last 3 non-system messages (rolling window)
 *
 * Also caches the last tool definition (tools are stable across turns).
 *
 * This keeps the cache warm: each new turn extends the cached prefix rather
 * than invalidating it. Multi-turn conversations see ~75% input token savings
 * on Anthropic models.
 */
function applyAnthropicPromptCaching(
  payload: Record<string, unknown>,
  request: ModelRequest
): Record<string, unknown> {
  const out = { ...payload };
  const cacheMarker = { type: 'ephemeral' as const };

  // 1. System prompt → wrap as array with cache_control on the text block
  if (typeof request.system === 'string' && request.system.length > 0) {
    out['system'] = [
      { type: 'text', text: request.system, cache_control: cacheMarker },
    ];
  }

  // 2. Tools → cache_control on the last tool (stable across turns)
  if (request.tools && request.tools.length > 0) {
    const toolsCopy = request.tools.map(t => ({ ...t }));
    (toolsCopy[toolsCopy.length - 1] as Record<string, unknown>)['cache_control'] = cacheMarker;
    out['tools'] = toolsCopy;
  }

  // 3. Messages → rolling cache_control on last 3 messages (user/assistant).
  // System is a separate field in ModelRequest, so all messages here are non-system.
  // Strategy: mark the last 3 messages so the cached prefix extends as the
  // conversation grows. Older cached prefixes expire after 5 min but newer
  // ones keep the cache warm.
  if (request.messages && request.messages.length > 0) {
    const messagesCopy = request.messages.map(m => ({ ...m }));
    // Mark last 3 messages (or fewer if history is shorter)
    const start = Math.max(0, messagesCopy.length - 3);
    for (let idx = start; idx < messagesCopy.length; idx++) {
      const msg = messagesCopy[idx];
      if (typeof msg.content === 'string') {
        (messagesCopy[idx] as Record<string, unknown>)['content'] = [
          { type: 'text', text: msg.content, cache_control: cacheMarker },
        ];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const contentCopy = msg.content.map(c => ({ ...(c as unknown as Record<string, unknown>) }));
        // cache_control goes on the last content block
        contentCopy[contentCopy.length - 1]['cache_control'] = cacheMarker;
        (messagesCopy[idx] as Record<string, unknown>)['content'] = contentCopy;
      }
    }
    out['messages'] = messagesCopy;
  }

  return out;
}

// ─── Client ────────────────────────────────────────────────────────────────

export class ModelClient {
  private apiUrl: string;
  private chain: Chain;
  private debug: boolean;
  private walletAddress = '';
  private cachedBaseWallet: { privateKey: string; address: string } | null = null;
  private cachedSolanaWallet: { privateKey: string; address: string } | null = null;
  private walletCacheTime = 0;
  private static WALLET_CACHE_TTL = 30 * 60 * 1000; // 30 min TTL

  constructor(opts: LLMClientOptions) {
    this.apiUrl = opts.apiUrl;
    this.chain = opts.chain;
    this.debug = opts.debug ?? false;
  }

  /**
   * Stream a completion from the BlockRun API.
   * Yields parsed SSE chunks as they arrive.
   * Handles x402 payment automatically on 402 responses.
   */
  /**
   * Resolve virtual routing profiles (blockrun/auto, blockrun/eco, etc.)
   * to concrete models. This is the final safety net — if the router in
   * loop.ts didn't resolve it (e.g. old global install without router),
   * we resolve it here before hitting the API.
   */
  private resolveVirtualModel(model: string): string {
    if (!model.startsWith('blockrun/')) return model;

    // Import router dynamically to avoid circular deps
    try {
      const { routeRequest, parseRoutingProfile } = require('../router/index.js');
      const profile = parseRoutingProfile(model);
      if (profile) {
        const result = routeRequest('', profile);
        if (result?.model && !result.model.startsWith('blockrun/')) {
          return result.model;
        }
      }
    } catch {
      // Router not available (e.g. old build) — use hardcoded fallback table
    }

    // Static fallback if router is unavailable
    const FALLBACKS: Record<string, string> = {
      'blockrun/auto': 'zai/glm-5.1',
      'blockrun/eco': 'nvidia/nemotron-ultra-253b',
      'blockrun/premium': 'anthropic/claude-sonnet-4.6',
      'blockrun/free': 'nvidia/nemotron-ultra-253b',
    };
    return FALLBACKS[model] || 'zai/glm-5.1';
  }

  async *streamCompletion(
    request: ModelRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    // Resolve virtual models before any API call
    const resolvedModel = this.resolveVirtualModel(request.model);
    if (resolvedModel !== request.model) {
      request = { ...request, model: resolvedModel };
    }

    const isAnthropic = request.model.startsWith('anthropic/');
    const isGLM = request.model.startsWith('zai/') || request.model.includes('glm');

    // Build the request payload, injecting model-specific optimizations
    let requestPayload: Record<string, unknown> = { ...request, stream: true };

    // ── GLM-specific optimizations ───────────────────────────────────────────
    // GLM models work best with temperature=0.8 per official zai spec.
    // Enable thinking mode only for explicit reasoning variants (-thinking-).
    if (isGLM) {
      if (requestPayload['temperature'] === undefined) {
        requestPayload['temperature'] = 0.8;
      }
      // Only enable thinking for models that explicitly ship reasoning mode
      if (request.model.includes('-thinking-')) {
        requestPayload['thinking'] = { type: 'enabled' };
      }
    }

    if (isAnthropic) {
      // ─ Anthropic prompt caching: `system_and_3` strategy ─────────────────
      // 4 cache_control breakpoints (Anthropic max):
      //   1. System prompt (stable across turns)
      //   2-4. Last 3 non-system messages (rolling window)
      //
      // This keeps the cache warm across turns: each new turn extends the
      // cache instead of invalidating it. ~75% input token savings on
      // multi-turn conversations. Pattern adopted from nousresearch/hermes-agent.
      requestPayload = applyAnthropicPromptCaching(requestPayload, request);
    }

    const body = JSON.stringify(requestPayload);

    const endpoint = `${this.apiUrl}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'x402-agent-handles-auth',
      'User-Agent': USER_AGENT,
    };

    // Enable prompt caching beta for Anthropic models
    if (isAnthropic) {
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    if (this.debug) {
      console.error(`[runcode] POST ${endpoint} model=${request.model}`);
    }

    let response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    // Handle x402 payment
    if (response.status === 402) {
      if (this.debug) console.error('[runcode] Payment required — signing...');
      const paymentHeader = await this.signPayment(response);
      if (!paymentHeader) {
        yield { kind: 'error', payload: { message: 'Payment signing failed' } };
        return;
      }

      response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, ...paymentHeader },
        body,
        signal,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      // Extract human-readable message from JSON error bodies ({"error":{"message":"..."}})
      let message = errorBody;
      try {
        const parsed = JSON.parse(errorBody);
        message = parsed?.error?.message || parsed?.message || errorBody;
      } catch { /* not JSON — use raw text */ }
      yield {
        kind: 'error',
        payload: { status: response.status, message },
      };
      return;
    }

    // Parse SSE stream
    yield* this.parseSSEStream(response, signal);
  }

  /**
   * Non-streaming completion for simple requests.
   */
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
    onToolReady?: (tool: CapabilityInvocation) => void,
    onStreamDelta?: (delta: { type: 'text' | 'thinking'; text: string }) => void
  ): Promise<{ content: ContentPart[]; usage: CompletionUsage; stopReason: string }> {
    const collected: ContentPart[] = [];
    let usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = 'end_turn';

    // Accumulate from stream
    let currentText = '';
    let currentThinking = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    for await (const chunk of this.streamCompletion(request, signal)) {
      switch (chunk.kind) {
        case 'content_block_start': {
          const block = chunk.payload as Record<string, unknown>;
          const cblock = block['content_block'] as Record<string, unknown> | undefined;
          if (cblock?.type === 'tool_use') {
            currentToolId = (cblock.id as string) || '';
            currentToolName = (cblock.name as string) || '';
            currentToolInput = '';
          } else if (cblock?.type === 'thinking') {
            currentThinking = '';
          } else if (cblock?.type === 'text') {
            currentText = '';
          }
          break;
        }
        case 'content_block_delta': {
          const delta = chunk.payload['delta'] as Record<string, unknown> | undefined;
          if (!delta) break;
          if (delta.type === 'text_delta') {
            const text = (delta.text as string) || '';
            currentText += text;
            if (text) onStreamDelta?.({ type: 'text', text });
          } else if (delta.type === 'thinking_delta') {
            const text = (delta.thinking as string) || '';
            currentThinking += text;
            if (text) onStreamDelta?.({ type: 'thinking', text });
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += (delta.partial_json as string) || '';
          }
          break;
        }
        case 'content_block_stop': {
          if (currentToolId) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(currentToolInput || '{}');
            } catch (parseErr) {
              // Log malformed JSON instead of silently defaulting to {}
              if (this.debug) {
                console.error(`[runcode] Malformed tool input JSON for ${currentToolName}: ${(parseErr as Error).message}`);
              }
            }
            const toolInvocation = {
              type: 'tool_use',
              id: currentToolId,
              name: currentToolName,
              input: parsedInput,
            } as CapabilityInvocation;
            collected.push(toolInvocation);
            // Notify caller so concurrent tools can start immediately
            onToolReady?.(toolInvocation);
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          } else if (currentThinking) {
            collected.push({
              type: 'thinking',
              thinking: currentThinking,
            } as ThinkingSegment);
            currentThinking = '';
          } else if (currentText) {
            collected.push({
              type: 'text',
              text: currentText,
            } as TextSegment);
            currentText = '';
          }
          break;
        }
        case 'message_delta': {
          const msgUsage = chunk.payload['usage'] as Record<string, number> | undefined;
          if (msgUsage) {
            usage.outputTokens = msgUsage['output_tokens'] ?? usage.outputTokens;
          }
          const delta = chunk.payload['delta'] as Record<string, unknown> | undefined;
          if (delta?.['stop_reason']) {
            stopReason = delta['stop_reason'] as string;
          }
          break;
        }
        case 'message_start': {
          const msg = chunk.payload['message'] as Record<string, unknown> | undefined;
          const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
          if (msgUsage) {
            usage.inputTokens = msgUsage['input_tokens'] ?? 0;
            usage.outputTokens = msgUsage['output_tokens'] ?? 0;
          }
          break;
        }
        case 'error': {
          const errMsg = (chunk.payload['message'] as string) || 'API error';
          const status = chunk.payload['status'] as number | undefined;
          // Prefix with HTTP status so classifyAgentError() can match on it
          // (the inner JSON .message field often strips the status code, e.g.
          // "Service temporarily unavailable" doesn't contain "503").
          throw new Error(status ? `HTTP ${status}: ${errMsg}` : errMsg);
        }
      }
    }

    // Flush any remaining text
    if (currentText) {
      collected.push({ type: 'text', text: currentText });
    }

    return { content: collected, usage, stopReason };
  }

  // ─── Payment ───────────────────────────────────────────────────────────

  private async signPayment(
    response: Response
  ): Promise<Record<string, string> | null> {
    try {
      if (this.chain === 'solana') {
        return await this.signSolanaPayment(response);
      }
      return await this.signBasePayment(response);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('insufficient') || msg.includes('balance')) {
        console.error(`[runcode] Insufficient USDC balance. Run 'runcode balance' to check.`);
      } else if (this.debug) {
        console.error('[runcode] Payment error:', msg);
      } else {
        console.error(`[runcode] Payment failed: ${msg.slice(0, 100)}`);
      }
      return null;
    }
  }

  private async signBasePayment(
    response: Response
  ): Promise<Record<string, string>> {
    // Refresh wallet cache after TTL to pick up balance/key changes
    if (!this.cachedBaseWallet || (Date.now() - this.walletCacheTime > ModelClient.WALLET_CACHE_TTL)) {
      const w = getOrCreateWallet();
      this.walletCacheTime = Date.now();
      this.cachedBaseWallet = { privateKey: w.privateKey, address: w.address };
    }
    const wallet = this.cachedBaseWallet;
    this.walletAddress = wallet.address;

    // Extract payment requirements from 402 response
    const paymentHeader = await this.extractPaymentReq(response);
    if (!paymentHeader) throw new Error('No payment requirements in 402 response');

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);

    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || this.apiUrl,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );

    return { 'PAYMENT-SIGNATURE': payload };
  }

  private async signSolanaPayment(
    response: Response
  ): Promise<Record<string, string>> {
    if (!this.cachedSolanaWallet || (Date.now() - this.walletCacheTime > ModelClient.WALLET_CACHE_TTL)) {
      const w = await getOrCreateSolanaWallet();
      this.walletCacheTime = Date.now();
      this.cachedSolanaWallet = { privateKey: w.privateKey, address: w.address };
    }
    const wallet = this.cachedSolanaWallet;
    this.walletAddress = wallet.address;

    const paymentHeader = await this.extractPaymentReq(response);
    if (!paymentHeader) throw new Error('No payment requirements in 402 response');

    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

    const secretBytes = await solanaKeyToBytes(wallet.privateKey);
    const feePayer = details.extra?.feePayer || details.recipient;

    const payload = await createSolanaPaymentPayload(
      secretBytes,
      wallet.address,
      details.recipient,
      details.amount,
      feePayer as string,
      {
        resourceUrl: details.resource?.url || this.apiUrl,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      }
    );

    return { 'PAYMENT-SIGNATURE': payload };
  }

  private async extractPaymentReq(response: Response): Promise<string | null> {
    let header = response.headers.get('payment-required');
    if (!header) {
      try {
        const body = (await response.json()) as Record<string, unknown>;
        if (body.x402 || body.accepts) {
          header = btoa(JSON.stringify(body));
        }
      } catch { /* ignore parse errors */ }
    }
    return header;
  }

  // ─── SSE Parsing ───────────────────────────────────────────────────────

  private async *parseSSEStream(
    response: Response,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    const reader = response.body?.getReader();
    if (!reader) {
      yield { kind: 'error', payload: { message: 'No response body' } };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Persist across read() calls — event: and data: may arrive in separate chunks
    let currentEvent = '';

    const MAX_BUFFER = 1_000_000; // 1MB buffer cap
    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Safety: if buffer grows too large without newlines, something is wrong
        if (buffer.length > MAX_BUFFER) {
          if (this.debug) {
            console.error(`[runcode] SSE buffer overflow (${(buffer.length / 1024).toFixed(0)}KB) — truncating to prevent OOM`);
          }
          buffer = buffer.slice(-MAX_BUFFER / 2);
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') {
            // Blank line = end of SSE event (reset for next event)
            currentEvent = '';
            continue;
          }
          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data);
              const mappedKind = this.mapEventType(currentEvent, parsed);
              if (mappedKind) {
                yield { kind: mappedKind, payload: parsed };
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private mapEventType(
    event: string,
    _payload: Record<string, unknown>
  ): StreamChunk['kind'] | null {
    switch (event) {
      case 'message_start': return 'message_start';
      case 'message_delta': return 'message_delta';
      case 'message_stop': return 'message_stop';
      case 'content_block_start': return 'content_block_start';
      case 'content_block_delta': return 'content_block_delta';
      case 'content_block_stop': return 'content_block_stop';
      case 'ping': return 'ping';
      case 'error': return 'error';
      default: return null;
    }
  }
}
