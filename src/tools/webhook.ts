/**
 * WebhookPost — generic HTTP POST tool for pushing agent output to any
 * webhook endpoint. Covers WeChat Work, Feishu, Discord, Slack, Telegram
 * Bot API, PushPlus, ServerChan, custom HTTP receivers — anything that
 * accepts a JSON body over POST.
 *
 * Intentionally not per-vendor: those integrations differ only in body
 * shape, which the agent already knows how to construct. One tool, eight
 * channels. If a channel needs a signature header (e.g., Feishu sign
 * mode), the agent passes it in via `headers`.
 *
 * Safety: outbound URLs are a publish surface. We refuse localhost,
 * private ranges, and file schemes so an agent can't be tricked into
 * hitting internal services. A permission prompt fires on first use per
 * session.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { isIP } from 'node:net';
import { VERSION } from '../config.js';

interface WebhookPostInput {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  method?: 'POST' | 'PUT' | 'PATCH';
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB is generous for a chat push.

function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('%', 1)[0]
    .toLowerCase();

  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::' || h === '::1') return true;

  // IPv4 private ranges.
  if (isIP(h) === 4) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true; // link-local
      if (a === 127) return true;
    }
  }

  if (isIP(h) === 6) {
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
    if (h.startsWith('::ffff:')) {
      return isPrivateHost(h.slice('::ffff:'.length));
    }
  }

  return false;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { url, body, headers, method = 'POST' } = input as unknown as WebhookPostInput;

  if (!url || typeof url !== 'string') {
    return { output: 'Error: url is required (string).', isError: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { output: `Error: invalid URL: ${url}`, isError: true };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { output: `Error: only http(s) URLs allowed, got ${parsed.protocol}`, isError: true };
  }
  if (isPrivateHost(parsed.hostname)) {
    return {
      output: `Error: refusing to post to private/loopback host ${parsed.hostname}. ` +
        `WebhookPost is for public webhook endpoints only.`,
      isError: true,
    };
  }

  // Serialize body. Accept object/array (JSON.stringify) or string (used as-is).
  let bodyText: string;
  let contentType = 'application/json';
  if (typeof body === 'string') {
    bodyText = body;
    contentType = 'text/plain';
  } else if (body === undefined || body === null) {
    bodyText = '';
  } else {
    try {
      bodyText = JSON.stringify(body);
    } catch (err) {
      return { output: `Error: body is not JSON-serializable: ${(err as Error).message}`, isError: true };
    }
  }
  const bodyBytes = Buffer.byteLength(bodyText, 'utf-8');
  if (bodyBytes > MAX_BODY_BYTES) {
    return {
      output: `Error: body is ${(bodyBytes / 1024).toFixed(1)} KB, exceeds ${MAX_BODY_BYTES / 1024} KB cap.`,
      isError: true,
    };
  }

  const finalHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'User-Agent': `franklin/${VERSION} (webhook)`,
    ...(headers ?? {}),
  };

  const ctrl = new AbortController();
  // Chain abort from the execution scope so Ctrl+C cancels the webhook call.
  const onParentAbort = () => ctrl.abort();
  ctx.abortSignal.addEventListener('abort', onParentAbort);
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: bodyText || undefined,
      signal: ctrl.signal,
    });

    // Capture a small slice of the response body for debugging — most webhook
    // endpoints return a short ack ({"ok":true}, "ok", "1", etc.).
    const text = await res.text();
    const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;

    if (!res.ok) {
      return {
        output: `Webhook POST failed: HTTP ${res.status} ${res.statusText}\nResponse: ${preview}`,
        isError: true,
      };
    }
    return {
      output:
        `Posted ${bodyBytes}B to ${parsed.host}${parsed.pathname}\n` +
        `Response ${res.status}: ${preview || '(empty)'}`,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (ctx.abortSignal.aborted) return { output: 'Webhook POST canceled by user.', isError: true };
      return { output: `Webhook POST timed out after ${DEFAULT_TIMEOUT_MS}ms`, isError: true };
    }
    return { output: `Webhook POST error: ${(err as Error).message}`, isError: true };
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onParentAbort);
  }
}

export const webhookPostCapability: CapabilityHandler = {
  spec: {
    name: 'WebhookPost',
    description:
      'POST a JSON or plain-text payload to a webhook URL. Works with any service that ' +
      'accepts an HTTP POST: WeChat Work bots, Feishu/Lark bots, Discord/Slack webhooks, ' +
      'Telegram Bot API (sendMessage), PushPlus, ServerChan, or a custom receiver. ' +
      'The agent is responsible for the body shape — each channel has its own schema ' +
      '(e.g., Discord: { "content": "hello" }; WeChat Work: { "msgtype": "markdown", ' +
      '"markdown": { "content": "..." } }).\n\n' +
      'Safety: private/loopback hosts are refused. Bodies over 512KB are refused. ' +
      'Do NOT use for GET requests — use WebFetch for reads.',
    input_schema: {
      type: 'object',
      required: ['url', 'body'],
      properties: {
        url: {
          type: 'string',
          description: 'Full https (or http) webhook URL. Must be a public host.',
        },
        body: {
          description:
            'Request body. Pass an object/array → JSON.stringify. Pass a string → sent ' +
            'as text/plain. Construct the shape each channel expects.',
        },
        headers: {
          type: 'object',
          description:
            'Optional extra request headers (auth tokens, signing headers). Content-Type ' +
            'is set automatically based on body type.',
        },
        method: {
          type: 'string',
          enum: ['POST', 'PUT', 'PATCH'],
          description: 'HTTP method. Defaults to POST.',
        },
      },
    },
  },
  execute,
  concurrent: false,
};
