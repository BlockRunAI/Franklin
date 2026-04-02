/**
 * LLM Client for runcode
 * Calls BlockRun API directly with x402 payment handling and streaming.
 * Original implementation — not derived from any existing codebase.
 */
import type { Chain } from '../config.js';
import type { Dialogue, CapabilityDefinition, ContentPart, CapabilityInvocation } from './types.js';
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
    kind: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop' | 'ping' | 'error';
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
export declare class ModelClient {
    private apiUrl;
    private chain;
    private debug;
    private walletAddress;
    private cachedBaseWallet;
    private cachedSolanaWallet;
    constructor(opts: LLMClientOptions);
    /**
     * Stream a completion from the BlockRun API.
     * Yields parsed SSE chunks as they arrive.
     * Handles x402 payment automatically on 402 responses.
     */
    streamCompletion(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk>;
    /**
     * Non-streaming completion for simple requests.
     */
    complete(request: ModelRequest, signal?: AbortSignal, onToolReady?: (tool: CapabilityInvocation) => void): Promise<{
        content: ContentPart[];
        usage: CompletionUsage;
        stopReason: string;
    }>;
    private signPayment;
    private signBasePayment;
    private signSolanaPayment;
    private extractPaymentReq;
    private parseSSEStream;
    private mapEventType;
}
