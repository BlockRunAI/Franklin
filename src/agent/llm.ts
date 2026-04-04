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
import { VERSION, type Chain } from '../config.js';
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
  async *streamCompletion(
    request: ModelRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    const body = JSON.stringify({
      ...request,
      stream: true,
    });

    const endpoint = `${this.apiUrl}/v1/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'x402-agent-handles-auth',
      'User-Agent': `runcode/${VERSION}`,
    };

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
      yield {
        kind: 'error',
        payload: { status: response.status, message: errorBody },
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
          throw new Error(errMsg);
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
