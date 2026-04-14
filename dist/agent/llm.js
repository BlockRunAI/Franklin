/**
 * LLM Client for Franklin
 * Calls BlockRun API directly with x402 payment handling and streaming.
 * Original implementation — not derived from any existing codebase.
 */
import { getOrCreateWallet, getOrCreateSolanaWallet, createPaymentPayload, createSolanaPaymentPayload, parsePaymentRequired, extractPaymentDetails, solanaKeyToBytes, SOLANA_NETWORK, } from '@blockrun/llm';
import { USER_AGENT } from '../config.js';
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
function applyAnthropicPromptCaching(payload, request) {
    const out = { ...payload };
    const cacheMarker = { type: 'ephemeral' };
    // 1. System prompt → wrap as array with cache_control on the text block
    if (typeof request.system === 'string' && request.system.length > 0) {
        out['system'] = [
            { type: 'text', text: request.system, cache_control: cacheMarker },
        ];
    }
    // 2. Tools → cache_control on the last tool (stable across turns)
    if (request.tools && request.tools.length > 0) {
        const toolsCopy = request.tools.map(t => ({ ...t }));
        toolsCopy[toolsCopy.length - 1]['cache_control'] = cacheMarker;
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
                messagesCopy[idx]['content'] = [
                    { type: 'text', text: msg.content, cache_control: cacheMarker },
                ];
            }
            else if (Array.isArray(msg.content) && msg.content.length > 0) {
                const contentCopy = msg.content.map(c => ({ ...c }));
                // cache_control goes on the last content block
                contentCopy[contentCopy.length - 1]['cache_control'] = cacheMarker;
                messagesCopy[idx]['content'] = contentCopy;
            }
        }
        out['messages'] = messagesCopy;
    }
    return out;
}
// ─── Client ────────────────────────────────────────────────────────────────
export class ModelClient {
    apiUrl;
    chain;
    debug;
    walletAddress = '';
    cachedBaseWallet = null;
    cachedSolanaWallet = null;
    walletCacheTime = 0;
    static WALLET_CACHE_TTL = 30 * 60 * 1000; // 30 min TTL
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
    /**
     * Resolve virtual routing profiles (blockrun/auto, blockrun/eco, etc.)
     * to concrete models. This is the final safety net — if the router in
     * loop.ts didn't resolve it (e.g. old global install without router),
     * we resolve it here before hitting the API.
     */
    resolveVirtualModel(model) {
        if (!model.startsWith('blockrun/'))
            return model;
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
        }
        catch {
            // Router not available (e.g. old build) — use hardcoded fallback table
        }
        // Static fallback if router is unavailable. Default to FREE model so
        // users aren't silently charged when their intended model can't resolve.
        const FALLBACKS = {
            'blockrun/auto': 'nvidia/nemotron-ultra-253b',
            'blockrun/eco': 'nvidia/nemotron-ultra-253b',
            'blockrun/premium': 'anthropic/claude-sonnet-4.6',
            'blockrun/free': 'nvidia/nemotron-ultra-253b',
        };
        return FALLBACKS[model] || 'nvidia/nemotron-ultra-253b';
    }
    async *streamCompletion(request, signal) {
        // Resolve virtual models before any API call
        const resolvedModel = this.resolveVirtualModel(request.model);
        if (resolvedModel !== request.model) {
            request = { ...request, model: resolvedModel };
        }
        const isAnthropic = request.model.startsWith('anthropic/');
        const isGLM = request.model.startsWith('zai/') || request.model.includes('glm');
        // Build the request payload, injecting model-specific optimizations
        let requestPayload = { ...request, stream: true };
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
            // ─ Anthropic extended thinking ──────────────────────────────────────
            // Enable thinking for Claude models that support it (Opus 4.6, Sonnet 4.6).
            // This is the single biggest quality lever — Claude with thinking enabled
            // is dramatically better at complex multi-step tasks, reasoning, and code.
            //
            // Uses adaptive thinking: the model decides how much to think per request.
            // budget_tokens is the MAX it can use (not a minimum), so the model won't
            // waste tokens on simple tasks. Set to 80% of max_tokens to leave room
            // for the actual response.
            const supportsThinking = request.model.includes('opus') ||
                request.model.includes('sonnet-4') ||
                request.model.includes('sonnet-3.7');
            if (supportsThinking) {
                const maxOut = (request.max_tokens ?? 16_384);
                requestPayload['thinking'] = {
                    type: 'enabled',
                    budget_tokens: Math.min(maxOut, 16_384), // Cap thinking budget — most benefit comes from first few K tokens
                };
                // Extended thinking requires temperature=1 on Anthropic API
                requestPayload['temperature'] = 1;
            }
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
        // ── GPT-5 / Codex: use "developer" role for system prompt ──────────────
        // OpenAI GPT models give stronger instruction-following weight to the
        // "developer" role. Move the top-level system prompt into messages[0]
        // with role "developer" instead of the default "system".
        const isGPT5OrCodex = request.model.includes('gpt-5') || request.model.includes('codex');
        if (isGPT5OrCodex && typeof request.system === 'string' && request.system.length > 0) {
            const systemRole = 'developer';
            const existingMessages = requestPayload['messages'] || [];
            requestPayload['messages'] = [
                { role: systemRole, content: request.system },
                ...existingMessages,
            ];
            delete requestPayload['system'];
        }
        const body = JSON.stringify(requestPayload);
        const endpoint = `${this.apiUrl}/v1/messages`;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': 'x402-agent-handles-auth',
            'User-Agent': USER_AGENT,
        };
        // Enable prompt caching + extended thinking betas for Anthropic models
        if (isAnthropic) {
            headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
        }
        if (this.debug) {
            console.error(`[franklin] POST ${endpoint} model=${request.model}`);
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
                console.error('[franklin] Payment required — signing...');
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
            }
            catch { /* not JSON — use raw text */ }
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
    async complete(request, signal, onToolReady, onStreamDelta) {
        const collected = [];
        let usage = { inputTokens: 0, outputTokens: 0 };
        let stopReason = 'end_turn';
        // Accumulate from stream
        let currentText = '';
        let currentThinking = '';
        let currentThinkingSignature = '';
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
                        currentThinkingSignature = '';
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
                    else if (delta.type === 'signature_delta') {
                        // Accumulate signature for multi-turn thinking continuity
                        currentThinkingSignature += delta.signature || '';
                    }
                    else if (delta.type === 'input_json_delta') {
                        currentToolInput += delta.partial_json || '';
                    }
                    break;
                }
                case 'content_block_stop': {
                    if (currentToolId) {
                        let parsedInput = {};
                        let inputParseError = false;
                        try {
                            parsedInput = JSON.parse(currentToolInput || '{}');
                        }
                        catch (parseErr) {
                            // Incomplete JSON from stream abort or model error.
                            // Mark as error so the executor returns an error result
                            // instead of silently invoking the tool with empty/wrong params.
                            inputParseError = true;
                            if (this.debug) {
                                console.error(`[franklin] Malformed tool input JSON for ${currentToolName}: ${parseErr.message}`);
                                console.error(`[franklin] Raw input was: ${currentToolInput.slice(0, 200)}`);
                            }
                        }
                        if (inputParseError) {
                            // Don't invoke the tool — add a text block explaining the error
                            // and skip the tool_use entirely. The model will see the error and retry.
                            collected.push({
                                type: 'text',
                                text: `[Tool call to ${currentToolName} failed: incomplete JSON input from stream. The request may have been interrupted.]`,
                            });
                        }
                        else {
                            const toolInvocation = {
                                type: 'tool_use',
                                id: currentToolId,
                                name: currentToolName,
                                input: parsedInput,
                            };
                            collected.push(toolInvocation);
                            // Notify caller so concurrent tools can start immediately
                            onToolReady?.(toolInvocation);
                        }
                        currentToolId = '';
                        currentToolName = '';
                        currentToolInput = '';
                    }
                    else if (currentThinking) {
                        collected.push({
                            type: 'thinking',
                            thinking: currentThinking,
                            ...(currentThinkingSignature ? { signature: currentThinkingSignature } : {}),
                        });
                        currentThinking = '';
                        currentThinkingSignature = '';
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
                    const status = chunk.payload['status'];
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
                console.error(`[franklin] Insufficient USDC balance. Run 'franklin balance' to check.`);
            }
            else if (this.debug) {
                console.error('[franklin] Payment error:', msg);
            }
            else {
                console.error(`[franklin] Payment failed: ${msg.slice(0, 100)}`);
            }
            return null;
        }
    }
    async signBasePayment(response) {
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
        if (!this.cachedSolanaWallet || (Date.now() - this.walletCacheTime > ModelClient.WALLET_CACHE_TTL)) {
            const w = await getOrCreateSolanaWallet();
            this.walletCacheTime = Date.now();
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
        const MAX_BUFFER = 1_000_000; // 1MB buffer cap
        try {
            while (true) {
                if (signal?.aborted)
                    break;
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                // Safety: if buffer grows too large without newlines, something is wrong
                if (buffer.length > MAX_BUFFER) {
                    if (this.debug) {
                        console.error(`[franklin] SSE buffer overflow (${(buffer.length / 1024).toFixed(0)}KB) — truncating to prevent OOM`);
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
