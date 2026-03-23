import http from 'node:http';
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

export interface ProxyOptions {
  port: number;
  apiUrl: string;
  chain?: Chain;
  modelOverride?: string;
  debug?: boolean;
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_FILE = path.join(os.homedir(), '.blockrun', 'brcc-debug.log');

function debug(options: ProxyOptions, ...args: unknown[]) {
  if (!options.debug) return;
  const msg = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, msg);
  } catch { /* ignore */ }
}

const DEFAULT_MAX_TOKENS = 4096;
let lastOutputTokens = 0;

// Model shortcuts for quick switching
const MODEL_SHORTCUTS: Record<string, string> = {
  'gpt': 'openai/gpt-5.4',
  'gpt5': 'openai/gpt-5.4',
  'gpt-5': 'openai/gpt-5.4',
  'gpt-5.4': 'openai/gpt-5.4',
  'sonnet': 'anthropic/claude-sonnet-4.6',
  'claude': 'anthropic/claude-sonnet-4.6',
  'opus': 'anthropic/claude-opus-4.6',
  'haiku': 'anthropic/claude-haiku-4.5',
  'deepseek': 'deepseek/deepseek-chat',
  'gemini': 'google/gemini-2.5-pro',
  'grok': 'xai/grok-3',
  'free': 'nvidia/gpt-oss-120b',
  'mini': 'openai/gpt-5-mini',
  'glm': 'zai/glm-5',
};

function detectModelSwitch(parsed: { messages?: Array<{ role: string; content: string | unknown }> }): string | null {
  if (!parsed.messages || parsed.messages.length === 0) return null;
  const last = parsed.messages[parsed.messages.length - 1];
  if (last.role !== 'user' || typeof last.content !== 'string') return null;

  const content = last.content.trim().toLowerCase();
  const match = content.match(/^use\s+(.+)$/);
  if (!match) return null;

  const modelInput = match[1].trim();
  // Check shortcuts first
  if (MODEL_SHORTCUTS[modelInput]) return MODEL_SHORTCUTS[modelInput];
  // If it contains a slash, treat as full model ID
  if (modelInput.includes('/')) return modelInput;
  return null;
}

export function createProxy(options: ProxyOptions): http.Server {
  const chain = options.chain || 'base';
  let currentModel: string | null = options.modelOverride || null;

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

    const path = req.url?.replace(/^\/api/, '') || '';
    const targetUrl = `${options.apiUrl}${path}`;
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        if (body) {
          try {
            const parsed = JSON.parse(body);

            // Intercept "use <model>" commands for in-session model switching
            const switchCmd = detectModelSwitch(parsed);
            if (switchCmd) {
              currentModel = switchCmd;
              debug(options, `model switched to: ${currentModel}`);
              const fakeResponse = {
                id: `msg_brcc_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: currentModel,
                content: [{ type: 'text', text: `Switched to **${currentModel}**. All subsequent requests will use this model.` }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 10 },
              };
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(fakeResponse));
              return;
            }

            // Apply model override
            if ((currentModel || options.modelOverride) && parsed.model) {
              parsed.model = currentModel || options.modelOverride!;
            }
            if (parsed.max_tokens) {
              const original = parsed.max_tokens;
              const model = (parsed.model || '').toLowerCase();
              const modelCap = (model.includes('deepseek') || model.includes('haiku') || model.includes('gpt-oss')) ? 8192 : 16384;

              // Use max of (last output × 2, default 4096) capped by model limit
              // This ensures short replies don't starve the next request
              const adaptive = lastOutputTokens > 0
                ? Math.max(lastOutputTokens * 2, DEFAULT_MAX_TOKENS)
                : DEFAULT_MAX_TOKENS;
              parsed.max_tokens = Math.min(adaptive, modelCap);

              if (original !== parsed.max_tokens) {
                debug(options, `max_tokens: ${original} → ${parsed.max_tokens} (last output: ${lastOutputTokens || 'none'})`);
              }
            }
            body = JSON.stringify(parsed);
          } catch { /* not JSON, pass through */ }
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() !== 'host' &&
            key.toLowerCase() !== 'content-length' &&
            value
          ) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }

        let response = await fetch(targetUrl, {
          method: req.method || 'POST',
          headers,
          body: body || undefined,
        });

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
        res.writeHead(response.status, responseHeaders);

        const isStreaming = responseHeaders['content-type']?.includes('text/event-stream');

        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let lastChunkText = '';

          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (isStreaming && lastChunkText) {
                  const match = lastChunkText.match(/"output_tokens"\s*:\s*(\d+)/);
                  if (match) {
                    lastOutputTokens = parseInt(match[1], 10);
                    debug(options, `recorded output_tokens: ${lastOutputTokens} (stream)`);
                  }
                }
                res.end();
                break;
              }
              if (isStreaming) {
                lastChunkText = decoder.decode(value, { stream: true });
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
              debug(options, `recorded output_tokens: ${lastOutputTokens}`);
            }
          } catch { /* not JSON */ }
          res.end(text);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Proxy error';
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
// Shared helpers
// ======================================================================

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

    if (content.includes('```') || content.includes('function ') ||
        content.includes('class ') || content.includes('import ') ||
        content.includes('def ') || content.includes('const ')) {
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
