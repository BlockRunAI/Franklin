import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getOrCreateWallet, getOrCreateSolanaWallet, createPaymentPayload, createSolanaPaymentPayload, parsePaymentRequired, extractPaymentDetails, solanaKeyToBytes, SOLANA_NETWORK, } from '@blockrun/llm';
import { recordUsage } from '../stats/tracker.js';
import { fetchWithFallback, buildFallbackChain, DEFAULT_FALLBACK_CONFIG, } from './fallback.js';
import { routeRequest, parseRoutingProfile, } from '../router/index.js';
import { estimateCost } from '../pricing.js';
import { VERSION } from '../config.js';
// User-Agent for backend requests
const USER_AGENT = `runcode/${VERSION}`;
const X_RUNCODE_VERSION = VERSION;
const LOG_FILE = path.join(os.homedir(), '.blockrun', 'runcode-debug.log');
// Strip ANSI escape codes so log file doesn't distort terminal on replay
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][A-B]|\r/g, '');
}
function debug(options, ...args) {
    if (!options.debug)
        return;
    const msg = `[${new Date().toISOString()}] ${stripAnsi(args.map(String).join(' '))}\n`;
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, msg);
    }
    catch {
        /* ignore */
    }
}
function log(...args) {
    const msg = `[runcode] ${args.map(String).join(' ')}`;
    // Do NOT print to stdout — Claude Code owns the terminal (stdio: inherit).
    // Use `runcode logs` to read runtime messages.
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${stripAnsi(msg)}\n`);
    }
    catch { /* ignore */ }
}
const DEFAULT_MAX_TOKENS = 4096;
// Per-model last output tokens for adaptive max_tokens (avoids cross-request pollution)
const MAX_TRACKED_MODELS = 50;
const lastOutputByModel = new Map();
function trackOutputTokens(model, tokens) {
    if (lastOutputByModel.size >= MAX_TRACKED_MODELS) {
        const firstKey = lastOutputByModel.keys().next().value;
        if (firstKey)
            lastOutputByModel.delete(firstKey);
    }
    lastOutputByModel.set(model, tokens);
}
// Model shortcuts for quick switching
const MODEL_SHORTCUTS = {
    // Routing profiles
    auto: 'blockrun/auto',
    smart: 'blockrun/auto',
    eco: 'blockrun/eco',
    premium: 'blockrun/premium',
    // Anthropic
    sonnet: 'anthropic/claude-sonnet-4.6',
    claude: 'anthropic/claude-sonnet-4.6',
    opus: 'anthropic/claude-opus-4.6',
    haiku: 'anthropic/claude-haiku-4.5',
    // OpenAI
    gpt: 'openai/gpt-5.4',
    gpt5: 'openai/gpt-5.4',
    'gpt-5': 'openai/gpt-5.4',
    'gpt-5.4': 'openai/gpt-5.4',
    'gpt-5.4-pro': 'openai/gpt-5.4-pro',
    'gpt-5.3': 'openai/gpt-5.3',
    'gpt-5.2': 'openai/gpt-5.2',
    'gpt-5.2-pro': 'openai/gpt-5.2-pro',
    'gpt-4.1': 'openai/gpt-4.1',
    codex: 'openai/gpt-5.3-codex',
    nano: 'openai/gpt-5-nano',
    mini: 'openai/gpt-5-mini',
    o3: 'openai/o3',
    o4: 'openai/o4-mini',
    'o4-mini': 'openai/o4-mini',
    o1: 'openai/o1',
    // Google
    gemini: 'google/gemini-2.5-pro',
    flash: 'google/gemini-2.5-flash',
    'gemini-3': 'google/gemini-3.1-pro',
    // xAI
    grok: 'xai/grok-3',
    'grok-4': 'xai/grok-4-0709',
    'grok-fast': 'xai/grok-4-1-fast-reasoning',
    // DeepSeek
    deepseek: 'deepseek/deepseek-chat',
    r1: 'deepseek/deepseek-reasoner',
    // Free models
    free: 'nvidia/nemotron-ultra-253b',
    nemotron: 'nvidia/nemotron-ultra-253b',
    'deepseek-free': 'nvidia/deepseek-v3.2',
    devstral: 'nvidia/devstral-2-123b',
    'qwen-coder': 'nvidia/qwen3-coder-480b',
    maverick: 'nvidia/llama-4-maverick',
    // Minimax
    minimax: 'minimax/minimax-m2.7',
    // Others
    glm: 'zai/glm-5',
    kimi: 'moonshot/kimi-k2.5',
};
// Model pricing now uses shared source from src/pricing.ts
function detectModelSwitch(parsed) {
    if (!parsed.messages || parsed.messages.length === 0)
        return null;
    const last = parsed.messages[parsed.messages.length - 1];
    if (last.role !== 'user')
        return null;
    let content = '';
    if (typeof last.content === 'string') {
        content = last.content;
    }
    else if (Array.isArray(last.content)) {
        const textBlock = last.content.find((b) => b.type === 'text' && b.text);
        if (textBlock && textBlock.text)
            content = textBlock.text;
    }
    if (!content)
        return null;
    content = content.trim().toLowerCase();
    const match = content.match(/^use\s+(.+)$/);
    if (!match)
        return null;
    const modelInput = match[1].trim();
    // Check shortcuts first
    if (MODEL_SHORTCUTS[modelInput])
        return MODEL_SHORTCUTS[modelInput];
    // If it contains a slash, treat as full model ID
    if (modelInput.includes('/'))
        return modelInput;
    return null;
}
// Default model - smart routing built-in
const DEFAULT_MODEL = 'blockrun/auto';
export function createProxy(options) {
    const chain = options.chain || 'base';
    let currentModel = options.modelOverride || DEFAULT_MODEL;
    const fallbackEnabled = options.fallbackEnabled !== false; // Default true
    let baseWallet = null;
    let solanaWallet = null;
    if (chain === 'base') {
        const w = getOrCreateWallet();
        baseWallet = { privateKey: w.privateKey, address: w.address };
    }
    let solanaInitPromise = null;
    const initSolana = () => {
        if (chain !== 'solana' || solanaWallet)
            return Promise.resolve();
        if (!solanaInitPromise) {
            solanaInitPromise = getOrCreateSolanaWallet().then((w) => {
                solanaWallet = { privateKey: w.privateKey, address: w.address };
            }).catch((err) => {
                solanaInitPromise = null; // Allow retry on failure
                throw err;
            });
        }
        return solanaInitPromise;
    };
    const server = http.createServer(async (req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        await initSolana();
        const requestPath = req.url?.replace(/^\/api/, '') || '';
        const targetUrl = `${options.apiUrl}${requestPath}`;
        let body = '';
        const requestStartTime = Date.now();
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', async () => {
            let requestModel = currentModel || options.modelOverride || 'unknown';
            let usedFallback = false;
            try {
                debug(options, `request: ${req.method} ${req.url} currentModel=${currentModel || 'none'}`);
                if (body) {
                    try {
                        const parsed = JSON.parse(body);
                        // Intercept "use <model>" commands for in-session model switching
                        if (parsed.messages) {
                            const last = parsed.messages[parsed.messages.length - 1];
                            debug(options, `last msg role=${last?.role} content-type=${typeof last?.content} content=${JSON.stringify(last?.content).slice(0, 200)}`);
                        }
                        const switchCmd = detectModelSwitch(parsed);
                        if (switchCmd) {
                            currentModel = switchCmd;
                            debug(options, `model switched to: ${currentModel}`);
                            const fakeResponse = {
                                id: `msg_runcode_${Date.now()}`,
                                type: 'message',
                                role: 'assistant',
                                model: currentModel,
                                content: [
                                    {
                                        type: 'text',
                                        text: `Switched to **${currentModel}**. All subsequent requests will use this model.`,
                                    },
                                ],
                                stop_reason: 'end_turn',
                                stop_sequence: null,
                                usage: { input_tokens: 0, output_tokens: 10 },
                            };
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(fakeResponse));
                            return;
                        }
                        // Model override logic:
                        // - Claude Code sends native Anthropic IDs (e.g. "claude-sonnet-4-6-20250514")
                        //   which don't contain "/" — these MUST be replaced with currentModel.
                        // - BlockRun model IDs always contain "/" (e.g. "blockrun/auto", "nvidia/nemotron-ultra-253b")
                        //   — these should be passed through as-is.
                        // - If --model CLI flag is set, always override regardless.
                        if (options.modelOverride) {
                            parsed.model = currentModel;
                        }
                        else if (!parsed.model || !parsed.model.includes('/')) {
                            parsed.model = currentModel || DEFAULT_MODEL;
                        }
                        requestModel = parsed.model || DEFAULT_MODEL;
                        // Smart routing: if model is a routing profile, classify and route
                        const routingProfile = parseRoutingProfile(requestModel);
                        if (routingProfile) {
                            // Extract user prompt for classification
                            const userMessages = parsed.messages?.filter((m) => m.role === 'user') || [];
                            const lastUserMsg = userMessages[userMessages.length - 1];
                            let promptText = '';
                            if (lastUserMsg) {
                                if (typeof lastUserMsg.content === 'string') {
                                    promptText = lastUserMsg.content;
                                }
                                else if (Array.isArray(lastUserMsg.content)) {
                                    promptText = lastUserMsg.content
                                        .filter((b) => b.type === 'text')
                                        .map((b) => b.text)
                                        .join('\n');
                                }
                            }
                            // Route the request
                            const routing = routeRequest(promptText, routingProfile);
                            parsed.model = routing.model;
                            requestModel = routing.model;
                            log(`🧠 Smart routing: ${routingProfile} → ${routing.tier} → ${routing.model} ` +
                                `(${(routing.savings * 100).toFixed(0)}% savings) [${routing.signals.join(', ')}]`);
                        }
                        {
                            const original = parsed.max_tokens;
                            const model = (parsed.model || '').toLowerCase();
                            const modelCap = model.includes('deepseek') ||
                                model.includes('haiku') ||
                                model.includes('gpt-oss')
                                ? 8192
                                : 16384;
                            // Use max of (last output × 2, default 4096) capped by model limit
                            // This ensures short replies don't starve the next request
                            const lastOut = lastOutputByModel.get(requestModel) ?? 0;
                            const adaptive = lastOut > 0
                                ? Math.max(lastOut * 2, DEFAULT_MAX_TOKENS)
                                : DEFAULT_MAX_TOKENS;
                            parsed.max_tokens = Math.min(adaptive, modelCap);
                            if (original !== parsed.max_tokens) {
                                debug(options, `max_tokens: ${original || 'unset'} → ${parsed.max_tokens} (last output: ${lastOut || 'none'})`);
                            }
                        }
                        body = JSON.stringify(parsed);
                    }
                    catch {
                        /* not JSON, pass through */
                    }
                }
                const headers = {
                    'Content-Type': 'application/json',
                    'User-Agent': USER_AGENT,
                    'X-runcode-Version': X_RUNCODE_VERSION,
                };
                for (const [key, value] of Object.entries(req.headers)) {
                    if (key.toLowerCase() !== 'host' &&
                        key.toLowerCase() !== 'content-length' &&
                        key.toLowerCase() !== 'user-agent' && // Don't forward client's user-agent
                        value) {
                        headers[key] = Array.isArray(value) ? value[0] : value;
                    }
                }
                // Build request init
                const requestInit = {
                    method: req.method || 'POST',
                    headers,
                    body: body || undefined,
                };
                let response;
                let finalModel = requestModel;
                // Use fallback chain if enabled
                if (fallbackEnabled && body && requestPath.includes('messages')) {
                    const fallbackConfig = {
                        ...DEFAULT_FALLBACK_CONFIG,
                        chain: buildFallbackChain(requestModel),
                    };
                    const result = await fetchWithFallback(targetUrl, requestInit, body, fallbackConfig, (failedModel, status, nextModel) => {
                        log(`⚠️  ${failedModel} returned ${status}, falling back to ${nextModel}`);
                    });
                    response = result.response;
                    finalModel = result.modelUsed;
                    // Use the body with the correct fallback model for payment
                    body = result.bodyUsed;
                    usedFallback = result.fallbackUsed;
                    if (usedFallback) {
                        log(`↺ Fallback successful: using ${finalModel}`);
                    }
                }
                else {
                    // Direct fetch without fallback (with timeout)
                    const directCtrl = new AbortController();
                    const directTimeout = setTimeout(() => directCtrl.abort(), 120_000); // 2min
                    response = await fetch(targetUrl, { ...requestInit, signal: directCtrl.signal });
                    clearTimeout(directTimeout);
                }
                // Handle 402 payment — body now has the correct model after fallback
                if (response.status === 402) {
                    if (chain === 'solana' && solanaWallet) {
                        response = await handleSolanaPayment(response, targetUrl, req.method || 'POST', headers, body, solanaWallet.privateKey, solanaWallet.address);
                    }
                    else if (baseWallet) {
                        response = await handleBasePayment(response, targetUrl, req.method || 'POST', headers, body, baseWallet.privateKey, baseWallet.address);
                    }
                }
                const responseHeaders = {};
                response.headers.forEach((v, k) => {
                    responseHeaders[k] = v;
                });
                // Intercept error responses and ensure Anthropic-format errors
                // so Claude Code doesn't fall back to showing a login page
                if (response.status >= 400 && !responseHeaders['content-type']?.includes('text/event-stream')) {
                    let errorBody;
                    try {
                        const rawText = await response.text();
                        const parsed = JSON.parse(rawText);
                        // Already has Anthropic error shape? Pass through
                        if (parsed.type === 'error' && parsed.error) {
                            errorBody = rawText;
                        }
                        else {
                            // Wrap in Anthropic error format
                            const errorMsg = parsed.error?.message || parsed.message || rawText.slice(0, 500);
                            errorBody = JSON.stringify({
                                type: 'error',
                                error: {
                                    type: response.status === 401 ? 'authentication_error'
                                        : response.status === 402 ? 'invalid_request_error'
                                            : response.status === 429 ? 'rate_limit_error'
                                                : response.status === 400 ? 'invalid_request_error'
                                                    : 'api_error',
                                    message: `[${finalModel}] ${errorMsg}`,
                                },
                            });
                        }
                    }
                    catch {
                        errorBody = JSON.stringify({
                            type: 'error',
                            error: { type: 'api_error', message: `Backend returned ${response.status}` },
                        });
                    }
                    res.writeHead(response.status, { 'Content-Type': 'application/json' });
                    res.end(errorBody);
                    log(`⚠️  ${response.status} from backend for ${finalModel}`);
                    return;
                }
                res.writeHead(response.status, responseHeaders);
                const isStreaming = responseHeaders['content-type']?.includes('text/event-stream');
                if (response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullResponse = '';
                    const STREAM_CAP = 5_000_000; // 5MB cap on accumulated stream
                    const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 min timeout for entire stream
                    const streamDeadline = Date.now() + STREAM_TIMEOUT_MS;
                    const pump = async () => {
                        while (true) {
                            if (Date.now() > streamDeadline) {
                                log('⚠️  Stream timeout after 5 minutes');
                                try {
                                    reader.cancel();
                                }
                                catch { /* ignore */ }
                                break;
                            }
                            const { done, value } = await reader.read();
                            if (done) {
                                // Record stats from streaming response
                                if (isStreaming && fullResponse) {
                                    // Extract token usage from SSE stream by parsing message_delta events
                                    let outputTokens = 0;
                                    let inputTokens = 0;
                                    // Find all data: lines and parse JSON to extract usage
                                    for (const line of fullResponse.split('\n')) {
                                        if (!line.startsWith('data: '))
                                            continue;
                                        const json = line.slice(6).trim();
                                        if (json === '[DONE]')
                                            continue;
                                        try {
                                            const parsed = JSON.parse(json);
                                            if (parsed.usage?.output_tokens)
                                                outputTokens = parsed.usage.output_tokens;
                                            if (parsed.usage?.input_tokens)
                                                inputTokens = parsed.usage.input_tokens;
                                        }
                                        catch { /* skip malformed */ }
                                    }
                                    if (outputTokens > 0) {
                                        trackOutputTokens(finalModel, outputTokens);
                                        const latencyMs = Date.now() - requestStartTime;
                                        const cost = estimateCost(finalModel, inputTokens, outputTokens);
                                        recordUsage(finalModel, inputTokens, outputTokens, cost, latencyMs, usedFallback);
                                        debug(options, `recorded: model=${finalModel} in=${inputTokens} out=${outputTokens} cost=$${cost.toFixed(4)} fallback=${usedFallback}`);
                                    }
                                }
                                res.end();
                                break;
                            }
                            if (isStreaming && fullResponse.length < STREAM_CAP) {
                                const chunk = decoder.decode(value, { stream: true });
                                fullResponse += chunk;
                            }
                            res.write(value);
                        }
                    };
                    pump().catch((err) => {
                        log(`❌ Stream error: ${err instanceof Error ? err.message : String(err)}`);
                        res.end();
                    });
                }
                else {
                    const text = await response.text();
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed.usage?.output_tokens) {
                            const outputTokens = parsed.usage.output_tokens;
                            trackOutputTokens(finalModel, outputTokens);
                            const inputTokens = parsed.usage?.input_tokens || 0;
                            const latencyMs = Date.now() - requestStartTime;
                            const cost = estimateCost(finalModel, inputTokens, outputTokens);
                            recordUsage(finalModel, inputTokens, outputTokens, cost, latencyMs, usedFallback);
                            debug(options, `recorded: model=${finalModel} in=${inputTokens} out=${outputTokens} cost=$${cost.toFixed(4)} fallback=${usedFallback}`);
                        }
                    }
                    catch {
                        /* not JSON */
                    }
                    res.end(text);
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : 'Proxy error';
                log(`❌ Error: ${msg}`);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: msg },
                }));
            }
        });
    });
    return server;
}
// ======================================================================
// Base (EIP-712) payment handler
// ======================================================================
async function handleBasePayment(response, url, method, headers, body, privateKey, fromAddress) {
    const paymentHeader = await extractPaymentHeader(response);
    if (!paymentHeader) {
        throw new Error('402 Payment Required — wallet may need funding. Run: runcode balance');
    }
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const paymentPayload = await createPaymentPayload(privateKey, fromAddress, details.recipient, details.amount, details.network || 'eip155:8453', {
        resourceUrl: details.resource?.url || url,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
    });
    return fetch(url, {
        method,
        headers: {
            ...headers,
            'PAYMENT-SIGNATURE': paymentPayload,
        },
        body: body || undefined,
    });
}
// ======================================================================
// Solana payment handler
// ======================================================================
async function handleSolanaPayment(response, url, method, headers, body, privateKey, fromAddress) {
    const paymentHeader = await extractPaymentHeader(response);
    if (!paymentHeader) {
        throw new Error('402 Payment Required — wallet may need funding. Run: runcode balance');
    }
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
    const secretKey = await solanaKeyToBytes(privateKey);
    const feePayer = details.extra?.feePayer || details.recipient;
    const paymentPayload = await createSolanaPaymentPayload(secretKey, fromAddress, details.recipient, details.amount, feePayer, {
        resourceUrl: details.resource?.url || url,
        resourceDescription: details.resource?.description || 'BlockRun AI API call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra,
    });
    return fetch(url, {
        method,
        headers: {
            ...headers,
            'PAYMENT-SIGNATURE': paymentPayload,
        },
        body: body || undefined,
    });
}
export function classifyRequest(body) {
    try {
        const parsed = JSON.parse(body);
        const messages = parsed.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            return { category: 'default' };
        }
        const lastMessage = messages[messages.length - 1];
        let content = '';
        if (typeof lastMessage.content === 'string') {
            content = lastMessage.content;
        }
        else if (Array.isArray(lastMessage.content)) {
            content = lastMessage.content
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text)
                .join('\n');
        }
        if (content.includes('```') ||
            content.includes('function ') ||
            content.includes('class ') ||
            content.includes('import ') ||
            content.includes('def ') ||
            content.includes('const ')) {
            return { category: 'code' };
        }
        if (content.length < 100) {
            return { category: 'simple' };
        }
        return { category: 'default' };
    }
    catch {
        return { category: 'default' };
    }
}
// ======================================================================
// Shared helpers
// ======================================================================
async function extractPaymentHeader(response) {
    let paymentHeader = response.headers.get('payment-required');
    if (!paymentHeader) {
        try {
            const respBody = (await response.json());
            if (respBody.x402 || respBody.accepts) {
                paymentHeader = btoa(JSON.stringify(respBody));
            }
        }
        catch {
            // ignore parse errors
        }
    }
    return paymentHeader;
}
