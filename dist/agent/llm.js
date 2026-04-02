/**
 * LLM Client for runcode
 * Calls BlockRun API directly with x402 payment handling and streaming.
 * Original implementation — not derived from any existing codebase.
 */
import { getOrCreateWallet, getOrCreateSolanaWallet, createPaymentPayload, createSolanaPaymentPayload, parsePaymentRequired, extractPaymentDetails, solanaKeyToBytes, SOLANA_NETWORK, } from '@blockrun/llm';
// ─── Client ────────────────────────────────────────────────────────────────
export class ModelClient {
    apiUrl;
    chain;
    debug;
    walletAddress = '';
    cachedBaseWallet = null;
    cachedSolanaWallet = null;
    constructor(opts) {
        this.apiUrl = opts.apiUrl;
        this.chain = opts.chain;
        this.debug = opts.debug ?? false;
    }
    /**
     * Stream a completion from the BlockRun API.
     * Yields parsed SSE chunks as they arrive.
     * Handles x402 payment automatically on 402 responses.
     */
    async *streamCompletion(request, signal) {
        const body = JSON.stringify({
            ...request,
            stream: true,
        });
        const endpoint = `${this.apiUrl}/v1/messages`;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': 'x402-agent-handles-auth',
            'User-Agent': 'runcode/1.0',
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
            if (this.debug)
                console.error('[runcode] Payment required — signing...');
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
    async complete(request, signal, onToolReady, onStreamDelta) {
        const collected = [];
        let usage = { inputTokens: 0, outputTokens: 0 };
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
                    const block = chunk.payload;
                    const cblock = block['content_block'];
                    if (cblock?.type === 'tool_use') {
                        currentToolId = cblock.id || '';
                        currentToolName = cblock.name || '';
                        currentToolInput = '';
                    }
                    else if (cblock?.type === 'thinking') {
                        currentThinking = '';
                    }
                    else if (cblock?.type === 'text') {
                        currentText = '';
                    }
                    break;
                }
                case 'content_block_delta': {
                    const delta = chunk.payload['delta'];
                    if (!delta)
                        break;
                    if (delta.type === 'text_delta') {
                        const text = delta.text || '';
                        currentText += text;
                        if (text)
                            onStreamDelta?.({ type: 'text', text });
                    }
                    else if (delta.type === 'thinking_delta') {
                        const text = delta.thinking || '';
                        currentThinking += text;
                        if (text)
                            onStreamDelta?.({ type: 'thinking', text });
                    }
                    else if (delta.type === 'input_json_delta') {
                        currentToolInput += delta.partial_json || '';
                    }
                    break;
                }
                case 'content_block_stop': {
                    if (currentToolId) {
                        let parsedInput = {};
                        try {
                            parsedInput = JSON.parse(currentToolInput || '{}');
                        }
                        catch { /* empty */ }
                        const toolInvocation = {
                            type: 'tool_use',
                            id: currentToolId,
                            name: currentToolName,
                            input: parsedInput,
                        };
                        collected.push(toolInvocation);
                        // Notify caller so concurrent tools can start immediately
                        onToolReady?.(toolInvocation);
                        currentToolId = '';
                        currentToolName = '';
                        currentToolInput = '';
                    }
                    else if (currentThinking) {
                        collected.push({
                            type: 'thinking',
                            thinking: currentThinking,
                        });
                        currentThinking = '';
                    }
                    else if (currentText) {
                        collected.push({
                            type: 'text',
                            text: currentText,
                        });
                        currentText = '';
                    }
                    break;
                }
                case 'message_delta': {
                    const msgUsage = chunk.payload['usage'];
                    if (msgUsage) {
                        usage.outputTokens = msgUsage['output_tokens'] ?? usage.outputTokens;
                    }
                    const delta = chunk.payload['delta'];
                    if (delta?.['stop_reason']) {
                        stopReason = delta['stop_reason'];
                    }
                    break;
                }
                case 'message_start': {
                    const msg = chunk.payload['message'];
                    const msgUsage = msg?.['usage'];
                    if (msgUsage) {
                        usage.inputTokens = msgUsage['input_tokens'] ?? 0;
                        usage.outputTokens = msgUsage['output_tokens'] ?? 0;
                    }
                    break;
                }
                case 'error': {
                    const errMsg = chunk.payload['message'] || 'API error';
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
    async signPayment(response) {
        try {
            if (this.chain === 'solana') {
                return await this.signSolanaPayment(response);
            }
            return await this.signBasePayment(response);
        }
        catch (err) {
            const msg = err.message || '';
            if (msg.includes('insufficient') || msg.includes('balance')) {
                console.error(`[runcode] Insufficient USDC balance. Run 'runcode balance' to check.`);
            }
            else if (this.debug) {
                console.error('[runcode] Payment error:', msg);
            }
            else {
                console.error(`[runcode] Payment failed: ${msg.slice(0, 100)}`);
            }
            return null;
        }
    }
    async signBasePayment(response) {
        if (!this.cachedBaseWallet) {
            const w = getOrCreateWallet();
            this.cachedBaseWallet = { privateKey: w.privateKey, address: w.address };
        }
        const wallet = this.cachedBaseWallet;
        this.walletAddress = wallet.address;
        // Extract payment requirements from 402 response
        const paymentHeader = await this.extractPaymentReq(response);
        if (!paymentHeader)
            throw new Error('No payment requirements in 402 response');
        const paymentRequired = parsePaymentRequired(paymentHeader);
        const details = extractPaymentDetails(paymentRequired);
        const payload = await createPaymentPayload(wallet.privateKey, wallet.address, details.recipient, details.amount, details.network || 'eip155:8453', {
            resourceUrl: details.resource?.url || this.apiUrl,
            resourceDescription: details.resource?.description || 'BlockRun AI API call',
            maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
            extra: details.extra,
        });
        return { 'PAYMENT-SIGNATURE': payload };
    }
    async signSolanaPayment(response) {
        if (!this.cachedSolanaWallet) {
            const w = await getOrCreateSolanaWallet();
            this.cachedSolanaWallet = { privateKey: w.privateKey, address: w.address };
        }
        const wallet = this.cachedSolanaWallet;
        this.walletAddress = wallet.address;
        const paymentHeader = await this.extractPaymentReq(response);
        if (!paymentHeader)
            throw new Error('No payment requirements in 402 response');
        const paymentRequired = parsePaymentRequired(paymentHeader);
        const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
        const secretBytes = await solanaKeyToBytes(wallet.privateKey);
        const feePayer = details.extra?.feePayer || details.recipient;
        const payload = await createSolanaPaymentPayload(secretBytes, wallet.address, details.recipient, details.amount, feePayer, {
            resourceUrl: details.resource?.url || this.apiUrl,
            resourceDescription: details.resource?.description || 'BlockRun AI API call',
            maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
            extra: details.extra,
        });
        return { 'PAYMENT-SIGNATURE': payload };
    }
    async extractPaymentReq(response) {
        let header = response.headers.get('payment-required');
        if (!header) {
            try {
                const body = (await response.json());
                if (body.x402 || body.accepts) {
                    header = btoa(JSON.stringify(body));
                }
            }
            catch { /* ignore parse errors */ }
        }
        return header;
    }
    // ─── SSE Parsing ───────────────────────────────────────────────────────
    async *parseSSEStream(response, signal) {
        const reader = response.body?.getReader();
        if (!reader) {
            yield { kind: 'error', payload: { message: 'No response body' } };
            return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        // Persist across read() calls — event: and data: may arrive in separate chunks
        let currentEvent = '';
        try {
            while (true) {
                if (signal?.aborted)
                    break;
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
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
                    }
                    else if (trimmed.startsWith('data:')) {
                        const data = trimmed.slice(5).trim();
                        if (data === '[DONE]')
                            return;
                        try {
                            const parsed = JSON.parse(data);
                            const mappedKind = this.mapEventType(currentEvent, parsed);
                            if (mappedKind) {
                                yield { kind: mappedKind, payload: parsed };
                            }
                        }
                        catch {
                            // Skip malformed JSON lines
                        }
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    mapEventType(event, _payload) {
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
