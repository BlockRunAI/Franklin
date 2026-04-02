/**
 * WebFetch capability — fetch web page content.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

interface WebFetchInput {
  url: string;
  max_length?: number;
}

const MAX_BODY_BYTES = 256 * 1024; // 256KB

async function execute(input: Record<string, unknown>, _ctx: ExecutionScope): Promise<CapabilityResult> {
  const { url, max_length } = input as unknown as WebFetchInput;

  if (!url) {
    return { output: 'Error: url is required', isError: true };
  }

  // Basic URL validation
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { output: `Error: invalid URL: ${url}`, isError: true };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { output: `Error: only http/https URLs are supported`, isError: true };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': '0xcode/1.0 (coding-agent)',
        'Accept': 'text/html,application/json,text/plain,*/*',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        output: `HTTP ${response.status} ${response.statusText} for ${url}`,
        isError: true,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const maxLen = Math.min(max_length ?? MAX_BODY_BYTES, MAX_BODY_BYTES);

    // Read body with size limit
    const reader = response.body?.getReader();
    if (!reader) {
      return { output: 'Error: no response body', isError: true };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (totalBytes < maxLen) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    reader.releaseLock();

    const decoder = new TextDecoder();
    let body = decoder.decode(Buffer.concat(chunks)).slice(0, maxLen);

    // Strip HTML tags for readability if HTML
    if (contentType.includes('html')) {
      body = stripHtml(body);
    }

    let output = `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${body}`;

    if (totalBytes >= maxLen) {
      output += '\n\n... (content truncated)';
    }

    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { output: `Error: request timed out after 30s for ${url}`, isError: true };
    }
    return { output: `Error fetching ${url}: ${msg}`, isError: true };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export const webFetchCapability: CapabilityHandler = {
  spec: {
    name: 'WebFetch',
    description: 'Fetch a web page and return its content. HTML tags are stripped for readability.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        max_length: { type: 'number', description: 'Max content bytes to return. Default: 256KB' },
      },
      required: ['url'],
    },
  },
  execute,
  concurrent: true,
};
