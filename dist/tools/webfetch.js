/**
 * WebFetch capability — fetch web page content.
 */
import { USER_AGENT } from '../config.js';
const MAX_BODY_BYTES = 256 * 1024; // 256KB
const DEFAULT_MAX_LENGTH = 12_288;
const HTML_READ_AHEAD_BYTES = 8_192;
// ─── Session cache ──────────────────────────────────────────────────────────
// Avoids re-fetching the same URL within a session (common in research tasks).
// 15-min TTL, max 50 entries.
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const fetchCache = new Map();
function cacheKey(url, maxLength) {
    return `${url}::${maxLength}`;
}
function getCached(key) {
    const entry = fetchCache.get(key);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        fetchCache.delete(key);
        return null;
    }
    return entry.output;
}
function setCached(key, output) {
    // Evict oldest entry if at capacity
    if (fetchCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = fetchCache.keys().next().value;
        if (firstKey)
            fetchCache.delete(firstKey);
    }
    fetchCache.set(key, { output, expiresAt: Date.now() + CACHE_TTL_MS });
}
// ─── Execute ────────────────────────────────────────────────────────────────
async function execute(input, ctx) {
    const { url, max_length } = input;
    if (!url) {
        return { output: 'Error: url is required', isError: true };
    }
    // Basic URL validation
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { output: `Error: invalid URL: ${url}`, isError: true };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { output: `Error: only http/https URLs are supported`, isError: true };
    }
    const maxLen = Math.min(max_length ?? DEFAULT_MAX_LENGTH, MAX_BODY_BYTES);
    const key = cacheKey(url, maxLen);
    // Check cache first
    const cached = getCached(key);
    if (cached) {
        return { output: cached + '\n\n(cached)' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const onAbort = () => controller.abort();
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/json,text/plain,*/*',
            },
            redirect: 'follow',
        });
        if (!response.ok) {
            return {
                output: `HTTP ${response.status} ${response.statusText} for ${url}`,
                isError: true,
            };
        }
        const contentType = response.headers.get('content-type') || '';
        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
            return { output: 'Error: no response body', isError: true };
        }
        const chunks = [];
        let totalBytes = 0;
        const readBudget = contentType.includes('html')
            ? Math.min(maxLen + HTML_READ_AHEAD_BYTES, MAX_BODY_BYTES)
            : maxLen;
        try {
            while (totalBytes < readBudget) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                chunks.push(value);
                totalBytes += value.length;
            }
        }
        finally {
            reader.releaseLock();
        }
        const decoder = new TextDecoder();
        const rawBody = decoder.decode(Buffer.concat(chunks));
        let body = rawBody;
        // Format response based on content type
        if (contentType.includes('json')) {
            try {
                const parsedJson = JSON.parse(rawBody.slice(0, maxLen));
                body = JSON.stringify(parsedJson, null, 2).slice(0, maxLen);
            }
            catch { /* leave as-is if not valid JSON */ }
        }
        else if (contentType.includes('html')) {
            body = stripHtml(rawBody).slice(0, maxLen);
        }
        else {
            body = rawBody.slice(0, maxLen);
        }
        let output = `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${body}`;
        if (totalBytes >= readBudget || rawBody.length > maxLen) {
            output += '\n\n... (content truncated)';
        }
        // Cache successful responses
        setCached(key, output);
        return { output };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ctx.abortSignal.aborted) {
            return { output: `Error: request aborted for ${url}`, isError: true };
        }
        if (msg.includes('abort')) {
            return { output: `Error: request timed out after 30s for ${url}`, isError: true };
        }
        return { output: `Error fetching ${url}: ${msg}`, isError: true };
    }
    finally {
        clearTimeout(timeout);
        ctx.abortSignal.removeEventListener('abort', onAbort);
    }
}
function stripHtml(html) {
    return html
        // Remove non-content elements
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
        .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
        .replace(/<(path|g|defs|clipPath|symbol|use|mask|rect|circle|ellipse|polygon|polyline|line)\b[^>]*>/gi, ' ')
        .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
        // Convert block elements to newlines for readability
        .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
        // Strip remaining tags
        .replace(/<[^>]+>/g, ' ')
        .replace(/<[^>\n]*$/g, '')
        // Decode entities
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // Clean whitespace
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export const webFetchCapability = {
    spec: {
        name: 'WebFetch',
        description: 'Fetch a web page and return its content. HTML tags are stripped for readability. Results are cached for 15 minutes.',
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
