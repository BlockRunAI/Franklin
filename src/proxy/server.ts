import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
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
import type { Chain } from '../config.js';
import { recordUsage } from '../stats/tracker.js';
import {
  fetchWithFallback,
  buildFallbackChain,
  DEFAULT_FALLBACK_CONFIG,
  type FallbackConfig,
} from './fallback.js';
import {
  routeRequest,
  parseRoutingProfile,
  getFallbackChain as getRouterFallbackChain,
  type RoutingProfile,
} from '../router/index.js';

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let VERSION = '0.9.0';
try {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  VERSION = pkg.version || VERSION;
} catch { /* use default */ }

// User-Agent for backend requests
const USER_AGENT = `brcc/${VERSION}`;
const X_BRCC_VERSION = VERSION;

export interface ProxyOptions {
  port: number;
  apiUrl: string;
  chain?: Chain;
  modelOverride?: string;
  debug?: boolean;
  fallbackEnabled?: boolean;
}

const LOG_FILE = path.join(os.homedir(), '.blockrun', 'brcc-debug.log');

function debug(options: ProxyOptions, ...args: unknown[]) {
  if (!options.debug) return;
  const msg = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, msg);
  } catch {
    /* ignore */
  }
}

function log(...args: unknown[]) {
  const msg = `[brcc] ${args.map(String).join(' ')}`;
  console.log(msg);
}

const DEFAULT_MAX_TOKENS = 4096;
let lastOutputTokens = 0;

// Model shortcuts for quick switching
const MODEL_SHORTCUTS: Record<string, string> = {
  auto: 'blockrun/auto',
  smart: 'blockrun/auto',
  eco: 'blockrun/eco',
  premium: 'blockrun/premium',
  gpt: 'openai/gpt-5.4',
  gpt5: 'openai/gpt-5.4',
  'gpt-5': 'openai/gpt-5.4',
  'gpt-5.4': 'openai/gpt-5.4',
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5',
  deepseek: 'deepseek/deepseek-chat',
  gemini: 'google/gemini-2.5-pro',
  grok: 'xai/grok-3',
  free: 'nvidia/gpt-oss-120b',
  mini: 'openai/gpt-5-mini',
  glm: 'zai/glm-5',
};

// Model pricing (per 1M tokens) - used for stats
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Routing profiles (blended averages)
  'blockrun/auto': { input: 0.8, output: 4.0 },
  'blockrun/eco': { input: 0.2, output: 1.0 },
  'blockrun/premium': { input: 3.0, output: 15.0 },
  'blockrun/free': { input: 0, output: 0 },
  // Individual models
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'anthropic/claude-opus-4.6': { input: 5.0, output: 25.0 },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0 },
  'openai/gpt-5.4': { input: 2.5, output: 15.0 },
  'openai/gpt-5-mini': { input: 0.25, output: 2.0 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'deepseek/deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek/deepseek-reasoner': { input: 0.55, output: 2.19 },
  'xai/grok-3': { input: 3.0, output: 15.0 },
  'xai/grok-4-fast': { input: 0.2, output: 0.5 },
  'xai/grok-4-1-fast-reasoning': { input: 0.2, output: 0.5 },
  'nvidia/gpt-oss-120b': { input: 0, output: 0 },
  'zai/glm-5': { input: 1.0, output: 3.2 },
  'moonshot/kimi-k2.5': { input: 0.6, output: 3.0 },
  'openai/gpt-5.3-codex': { input: 2.5, output: 10.0 },
  'openai/o3': { input: 2.0, output: 8.0 },
  'openai/o4-mini': { input: 1.1, output: 4.4 },
  'google/gemini-2.5-flash-lite': { input: 0.08, output: 0.3 },
  'google/gemini-3.1-pro': { input: 1.25, output: 10.0 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model] || { input: 2.0, output: 10.0 };
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

function detectModelSwitch(parsed: {
  messages?: Array<{ role: string; content: string | unknown[] | unknown }>;
}): string | null {
  if (!parsed.messages || parsed.messages.length === 0) return null;
  const last = parsed.messages[parsed.messages.length - 1];
  if (last.role !== 'user') return null;

  let content = '';
  if (typeof last.content === 'string') {
    content = last.content;
  } else if (Array.isArray(last.content)) {
    const textBlock = (
      last.content as Array<{ type: string; text?: string }>
    ).find((b) => b.type === 'text' && b.text);
    if (textBlock && textBlock.text) content = textBlock.text;
  }
  if (!content) return null;

  content = content.trim().toLowerCase();
  const match = content.match(/^use\s+(.+)$/);
  if (!match) return null;

  const modelInput = match[1].trim();
  // Check shortcuts first
  if (MODEL_SHORTCUTS[modelInput]) return MODEL_SHORTCUTS[modelInput];
  // If it contains a slash, treat as full model ID
  if (modelInput.includes('/')) return modelInput;
  return null;
}

// Default model - smart routing built-in
const DEFAULT_MODEL = 'blockrun/auto';

export function createProxy(options: ProxyOptions): http.Server {
  const chain = options.chain || 'base';
  let currentModel: string | null = options.modelOverride || DEFAULT_MODEL;
  const fallbackEnabled = options.fallbackEnabled !== false; // Default true

  let baseWallet: { privateKey: string; address: string } | null = null;
  let solanaWallet: { privateKey: string; address: string } | null = null;

  if (chain === 'base') {
    const w = getOrCreateWallet();
    baseWallet = { privateKey: w.privateKey, address: w.address };
  }

  const initSolana = async () => {
    if (chain === 'solana' && !solanaWallet) {
      const w = await getOrCreateSolanaWallet();
      solanaWallet = { privateKey: w.privateKey, address: w.address };
    }
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

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      let requestModel = currentModel || options.modelOverride || 'unknown';
      let usedFallback = false;

      try {
        debug(
          options,
          `request: ${req.method} ${req.url} currentModel=${currentModel || 'none'}`
        );
        if (body) {
          try {
            const parsed = JSON.parse(body);

            // Intercept "use <model>" commands for in-session model switching
            if (parsed.messages) {
              const last = parsed.messages[parsed.messages.length - 1];
              debug(
                options,
                `last msg role=${last?.role} content-type=${typeof last?.content} content=${JSON.stringify(last?.content).slice(0, 200)}`
              );
            }
            const switchCmd = detectModelSwitch(parsed);
            if (switchCmd) {
              currentModel = switchCmd;
              debug(options, `model switched to: ${currentModel}`);
              const fakeResponse = {
                id: `msg_brcc_${Date.now()}`,
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

            // Apply model override only if:
            // 1. User specified --model on CLI (options.modelOverride)
            // 2. User switched model in-session (currentModel set by "use X" command)
            // 3. Request has no model specified
            if (options.modelOverride && currentModel) {
              // CLI --model flag: always use this
              parsed.model = currentModel;
            } else if (!parsed.model) {
              // No model in request: use default
              parsed.model = currentModel || DEFAULT_MODEL;
            }
            // Otherwise: use the model from the request as-is
            requestModel = parsed.model || DEFAULT_MODEL;

            // Smart routing: if model is a routing profile, classify and route
            const routingProfile = parseRoutingProfile(requestModel);
            if (routingProfile) {
              // Extract user prompt for classification
              const userMessages = parsed.messages?.filter(
                (m: { role: string }) => m.role === 'user'
              ) || [];
              const lastUserMsg = userMessages[userMessages.length - 1];
              let promptText = '';
              if (lastUserMsg) {
                if (typeof lastUserMsg.content === 'string') {
                  promptText = lastUserMsg.content;
                } else if (Array.isArray(lastUserMsg.content)) {
                  promptText = lastUserMsg.content
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b: { text: string }) => b.text)
                    .join('\n');
                }
              }

              // Route the request
              const routing = routeRequest(promptText, routingProfile);
              parsed.model = routing.model;
              requestModel = routing.model;

              log(
                `🧠 Smart routing: ${routingProfile} → ${routing.tier} → ${routing.model} ` +
                `(${(routing.savings * 100).toFixed(0)}% savings) [${routing.signals.join(', ')}]`
              );
            }

            {
              const original = parsed.max_tokens;
              const model = (parsed.model || '').toLowerCase();
              const modelCap =
                model.includes('deepseek') ||
                model.includes('haiku') ||
                model.includes('gpt-oss')
                  ? 8192
                  : 16384;

              // Use max of (last output × 2, default 4096) capped by model limit
              // This ensures short replies don't starve the next request
              const adaptive =
                lastOutputTokens > 0
                  ? Math.max(lastOutputTokens * 2, DEFAULT_MAX_TOKENS)
                  : DEFAULT_MAX_TOKENS;
              parsed.max_tokens = Math.min(adaptive, modelCap);

              if (original !== parsed.max_tokens) {
                debug(
                  options,
                  `max_tokens: ${original || 'unset'} → ${parsed.max_tokens} (last output: ${lastOutputTokens || 'none'})`
                );
              }
            }
            body = JSON.stringify(parsed);
          } catch {
            /* not JSON, pass through */
          }
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Brcc-Version': X_BRCC_VERSION,
        };
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() !== 'host' &&
            key.toLowerCase() !== 'content-length' &&
            key.toLowerCase() !== 'user-agent' && // Don't forward client's user-agent
            value
          ) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        // Build request init
        const requestInit: RequestInit = {
          method: req.method || 'POST',
          headers,
          body: body || undefined,
        };

        let response: Response;
        let finalModel = requestModel;

        // Use fallback chain if enabled
        if (fallbackEnabled && body && requestPath.includes('messages')) {
          const fallbackConfig: FallbackConfig = {
            ...DEFAULT_FALLBACK_CONFIG,
            chain: buildFallbackChain(requestModel),
          };

          const result = await fetchWithFallback(
            targetUrl,
            requestInit,
            body,
            fallbackConfig,
            (failedModel, status, nextModel) => {
              log(
                `⚠️  ${failedModel} returned ${status}, falling back to ${nextModel}`
              );
            }
          );

          response = result.response;
          finalModel = result.modelUsed;
          usedFallback = result.fallbackUsed;

          if (usedFallback) {
            log(`↺ Fallback successful: using ${finalModel}`);
          }
        } else {
          // Direct fetch without fallback
          response = await fetch(targetUrl, requestInit);
        }

        // Handle 402 payment
        if (response.status === 402) {
          if (chain === 'solana' && solanaWallet) {
            response = await handleSolanaPayment(
              response,
              targetUrl,
              req.method || 'POST',
              headers,
              body,
              solanaWallet.privateKey,
              solanaWallet.address
            );
          } else if (baseWallet) {
            response = await handleBasePayment(
              response,
              targetUrl,
              req.method || 'POST',
              headers,
              body,
              baseWallet.privateKey as `0x${string}`,
              baseWallet.address
            );
          }
        }

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });

        // Intercept error responses and ensure Anthropic-format errors
        // so Claude Code doesn't fall back to showing a login page
        if (response.status >= 400 && !responseHeaders['content-type']?.includes('text/event-stream')) {
          let errorBody: string;
          try {
            const rawText = await response.text();
            const parsed = JSON.parse(rawText);
            // Already has Anthropic error shape? Pass through
            if (parsed.type === 'error' && parsed.error) {
              errorBody = rawText;
            } else {
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
          } catch {
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

        const isStreaming =
          responseHeaders['content-type']?.includes('text/event-stream');

        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullResponse = '';
          const STREAM_CAP = 5_000_000; // 5MB cap on accumulated stream

          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Record stats from streaming response
                if (isStreaming && fullResponse) {
                  // Search full response for the last output_tokens value
                  const allOutputMatches = [...fullResponse.matchAll(
                    /"output_tokens"\s*:\s*(\d+)/g
                  )];
                  const lastOutputMatch = allOutputMatches[allOutputMatches.length - 1];
                  const inputMatch = fullResponse.match(
                    /"input_tokens"\s*:\s*(\d+)/
                  );
                  if (lastOutputMatch) {
                    lastOutputTokens = parseInt(lastOutputMatch[1], 10);
                    const inputTokens = inputMatch
                      ? parseInt(inputMatch[1], 10)
                      : 0;
                    const latencyMs = Date.now() - requestStartTime;
                    const cost = estimateCost(
                      finalModel,
                      inputTokens,
                      lastOutputTokens
                    );

                    recordUsage(
                      finalModel,
                      inputTokens,
                      lastOutputTokens,
                      cost,
                      latencyMs,
                      usedFallback
                    );
                    debug(
                      options,
                      `recorded: model=${finalModel} in=${inputTokens} out=${lastOutputTokens} cost=$${cost.toFixed(4)} fallback=${usedFallback}`
                    );
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
          pump().catch(() => res.end());
        } else {
          const text = await response.text();
          try {
            const parsed = JSON.parse(text);
            if (parsed.usage?.output_tokens) {
              lastOutputTokens = parsed.usage.output_tokens;
              const inputTokens = parsed.usage?.input_tokens || 0;
              const latencyMs = Date.now() - requestStartTime;
              const cost = estimateCost(
                finalModel,
                inputTokens,
                lastOutputTokens
              );

              recordUsage(
                finalModel,
                inputTokens,
                lastOutputTokens,
                cost,
                latencyMs,
                usedFallback
              );
              debug(
                options,
                `recorded: model=${finalModel} in=${inputTokens} out=${lastOutputTokens} cost=$${cost.toFixed(4)} fallback=${usedFallback}`
              );
            }
          } catch {
            /* not JSON */
          }
          res.end(text);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Proxy error';
        log(`❌ Error: ${msg}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: msg },
          })
        );
      }
    });
  });

  return server;
}

// ======================================================================
// Base (EIP-712) payment handler
// ======================================================================

async function handleBasePayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: `0x${string}`,
  fromAddress: string
): Promise<Response> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 response but no payment requirements found');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired);

  const paymentPayload = await createPaymentPayload(
    privateKey,
    fromAddress,
    details.recipient,
    details.amount,
    details.network || 'eip155:8453',
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra,
    }
  );

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

async function handleSolanaPayment(
  response: Response,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  privateKey: string,
  fromAddress: string
): Promise<Response> {
  const paymentHeader = await extractPaymentHeader(response);
  if (!paymentHeader) {
    throw new Error('402 response but no payment requirements found');
  }

  const paymentRequired = parsePaymentRequired(paymentHeader);
  const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);

  const secretKey = await solanaKeyToBytes(privateKey);

  const feePayer = details.extra?.feePayer || details.recipient;

  const paymentPayload = await createSolanaPaymentPayload(
    secretKey,
    fromAddress,
    details.recipient,
    details.amount,
    feePayer,
    {
      resourceUrl: details.resource?.url || url,
      resourceDescription:
        details.resource?.description || 'BlockRun AI API call',
      maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
      extra: details.extra as Record<string, unknown> | undefined,
    }
  );

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
// Request classification (smart routing infrastructure)
// ======================================================================

type RequestCategory = 'simple' | 'code' | 'default';

interface ClassifiedRequest {
  category: RequestCategory;
  suggestedModel?: string;
}

export function classifyRequest(body: string): ClassifiedRequest {
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
    } else if (Array.isArray(lastMessage.content)) {
      content = lastMessage.content
        .filter(
          (b: { type: string; text?: string }) => b.type === 'text' && b.text
        )
        .map((b: { text: string }) => b.text)
        .join('\n');
    }

    if (
      content.includes('```') ||
      content.includes('function ') ||
      content.includes('class ') ||
      content.includes('import ') ||
      content.includes('def ') ||
      content.includes('const ')
    ) {
      return { category: 'code' };
    }

    if (content.length < 100) {
      return { category: 'simple' };
    }

    return { category: 'default' };
  } catch {
    return { category: 'default' };
  }
}

// ======================================================================
// Shared helpers
// ======================================================================

async function extractPaymentHeader(
  response: Response
): Promise<string | null> {
  let paymentHeader = response.headers.get('payment-required');

  if (!paymentHeader) {
    try {
      const respBody = (await response.json()) as Record<string, unknown>;
      if (respBody.x402 || respBody.accepts) {
        paymentHeader = btoa(JSON.stringify(respBody));
      }
    } catch {
      // ignore parse errors
    }
  }

  return paymentHeader;
}
