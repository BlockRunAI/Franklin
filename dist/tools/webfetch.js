/**
 * WebFetch capability — fetch web page content.
 */
import { VERSION } from '../config.js';
const MAX_BODY_BYTES = 256 * 1024; // 256KB
// ─── Session cache ──────────────────────────────────────────────────────────
// Avoids re-fetching the same URL within a session (common in research tasks).
// 15-min TTL, max 50 entries.
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const fetchCache = new Map();
function getCached(url) {
    const entry = fetchCache.get(url);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        fetchCache.delete(url);
        return null;
    }
    return entry.output;
}
function setCached(url, output) {
    // Evict oldest entry if at capacity
    if (fetchCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = fetchCache.keys().next().value;
        if (firstKey)
            fetchCache.delete(firstKey);
    }
    fetchCache.set(url, { output, expiresAt: Date.now() + CACHE_TTL_MS });
}
// ─── Execute ────────────────────────────────────────────────────────────────
async function execute(input, _ctx) {
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
    // Check cache first
    const cached = getCached(url);
    if (cached) {
        return { output: cached + '\n\n(cached)' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': `runcode/${VERSION} (coding-agent)`,
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
        const maxLen = Math.min(max_length ?? MAX_BODY_BYTES, MAX_BODY_BYTES);
        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
            return { output: 'Error: no response body', isError: true };
        }
        const chunks = [];
        let totalBytes = 0;
        try {
            while (totalBytes < maxLen) {
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
        let body = decoder.decode(Buffer.concat(chunks)).slice(0, maxLen);
        // Format response based on content type
        if (contentType.includes('json')) {
            try {
                const parsedJson = JSON.parse(body);
                body = JSON.stringify(parsedJson, null, 2).slice(0, maxLen);
            }
            catch { /* leave as-is if not valid JSON */ }
        }
        else if (contentType.includes('html')) {
            body = stripHtml(body);
        }
        let output = `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${body}`;
        if (totalBytes >= maxLen) {
            output += '\n\n... (content truncated)';
        }
        // Cache successful responses
        setCached(url, output);
        return { output };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) {
            return { output: `Error: request timed out after 30s for ${url}`, isError: true };
        }
        return { output: `Error fetching ${url}: ${msg}`, isError: true };
    }
    finally {
        clearTimeout(timeout);
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
        .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
        // Convert block elements to newlines for readability
        .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
        // Strip remaining tags
        .replace(/<[^>]+>/g, ' ')
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
