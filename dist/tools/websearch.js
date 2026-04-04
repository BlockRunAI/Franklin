/**
 * WebSearch capability — search the web via BlockRun API or DuckDuckGo fallback.
 */
import { VERSION } from '../config.js';
async function execute(input, _ctx) {
    const { query, max_results } = input;
    if (!query) {
        return { output: 'Error: query is required', isError: true };
    }
    const maxResults = Math.min(Math.max(max_results ?? 5, 1), 20);
    // Try DuckDuckGo HTML search (no API key needed)
    try {
        const encoded = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': `runcode/${VERSION} (coding-agent)`,
            },
        });
        clearTimeout(timeout);
        if (!response.ok) {
            return { output: `Search failed: HTTP ${response.status}`, isError: true };
        }
        const html = await response.text();
        const results = parseDuckDuckGoResults(html, maxResults);
        if (results.length === 0) {
            return { output: `No results found for: ${query}` };
        }
        const formatted = results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join('\n\n');
        return { output: `Search results for "${query}":\n\n${formatted}` };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) {
            return { output: `Search timed out after 15s for: ${query}`, isError: true };
        }
        return { output: `Search error: ${msg}`, isError: true };
    }
}
function parseDuckDuckGoResults(html, maxResults) {
    const results = [];
    // Match result blocks: <a class="result__a" href="...">title</a>
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];
    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        const link = links[i];
        const snippet = snippets[i];
        let url = link[1] || '';
        // DuckDuckGo wraps URLs in redirect — extract the actual URL
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
            url = decodeURIComponent(uddgMatch[1]);
        }
        results.push({
            title: stripTags(link[2] || '').trim(),
            url,
            snippet: stripTags(snippet?.[1] || '').trim(),
        });
    }
    return results;
}
function stripTags(html) {
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ');
}
export const webSearchCapability = {
    spec: {
        name: 'WebSearch',
        description: 'Search the web and return results with titles, URLs, and snippets.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' },
                max_results: { type: 'number', description: 'Max number of results. Default: 5' },
            },
            required: ['query'],
        },
    },
    execute,
    concurrent: true,
};
