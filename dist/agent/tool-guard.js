import fs from 'node:fs';
import path from 'node:path';
const MAX_WEBSEARCHES_PER_TURN = 8;
const MAX_SIMILAR_SEARCHES_PER_TURN = 4;
const MAX_NO_SIGNAL_SEARCHES_PER_FAMILY = 2;
const SEARCH_FAMILY_SIMILARITY = 0.58;
const DUPLICATE_READ_TURN_WINDOW = 1;
const DUPLICATE_FETCH_TURN_WINDOW = 1;
const MAX_PREVIEW_CHARS = 320;
const SEARCH_STOPWORDS = new Set([
    'a', 'an', 'and', 'april', 'at', 'builder', 'builders', 'com', 'developer',
    'developers', 'for', 'from', 'in', 'latest', 'live', 'may', 'of', 'on', 'or',
    'post', 'posts', 'recent', 'reply', 'replies', 'site', 'status', 'the', 'to',
    'tweet', 'tweets', 'via', 'x',
]);
function stemToken(token) {
    let result = token.toLowerCase();
    if (/^\d{4}$/.test(result))
        return '';
    if (result.endsWith('ing') && result.length > 6)
        result = result.slice(0, -3);
    else if (result.endsWith('ers') && result.length > 5)
        result = result.slice(0, -3);
    else if (result.endsWith('er') && result.length > 4)
        result = result.slice(0, -2);
    else if (result.endsWith('ed') && result.length > 4)
        result = result.slice(0, -2);
    else if (result.endsWith('es') && result.length > 4)
        result = result.slice(0, -2);
    else if (result.endsWith('s') && result.length > 4)
        result = result.slice(0, -1);
    return result;
}
export function normalizeSearchQuery(query) {
    const tokens = query
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map(stemToken)
        .filter((token) => token.length >= 2 && !SEARCH_STOPWORDS.has(token));
    const normalized = [...new Set(tokens)].sort().join(' ');
    return { normalized, tokens: [...new Set(tokens)] };
}
function jaccardSimilarity(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const token of a) {
        if (b.has(token))
            intersection++;
    }
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
}
function summarizeOutput(output) {
    const compact = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join('\n');
    return compact.length > MAX_PREVIEW_CHARS
        ? compact.slice(0, MAX_PREVIEW_CHARS - 3) + '...'
        : compact;
}
function isNoSignalSearchResult(output, isError) {
    const lower = output.toLowerCase();
    return Boolean(isError ||
        lower.startsWith('no results found for:') ||
        lower.startsWith('no candidate posts found') ||
        lower.startsWith('search timed out') ||
        lower.startsWith('search error:') ||
        lower.startsWith('searchx error:'));
}
function readKey(resolved, offset, limit) {
    return `${resolved}::${offset ?? 1}::${limit ?? 2000}`;
}
function fetchKey(url, maxLength) {
    return `${url}::${maxLength ?? 12288}`;
}
export class SessionToolGuard {
    turn = 0;
    webSearchesThisTurn = 0;
    searchFamilies = [];
    searchCache = new Map();
    pendingSearches = new Map();
    recentReads = new Map();
    pendingReads = new Map();
    recentFetches = new Map();
    pendingFetches = new Map();
    toolErrorCounts = new Map();
    startTurn() {
        this.turn++;
        this.webSearchesThisTurn = 0;
        for (const family of this.searchFamilies) {
            family.turnSearches = 0;
        }
    }
    async beforeExecute(invocation, scope) {
        // Hard-block tools that have failed too many times this session
        const errorCount = this.toolErrorCounts.get(invocation.name) ?? 0;
        if (errorCount >= 3) {
            return {
                output: `${invocation.name} has failed ${errorCount} times this session and is now disabled. ` +
                    'Tell the user what went wrong and suggest alternatives.',
                isError: true,
            };
        }
        switch (invocation.name) {
            case 'WebSearch':
            case 'SearchX':
                return this.beforeWebSearch(invocation);
            case 'Read':
                return this.beforeRead(invocation, scope);
            case 'WebFetch':
                return this.beforeWebFetch(invocation);
            default:
                return null;
        }
    }
    afterExecute(invocation, result) {
        // Track per-tool error counts across the session
        if (result.isError) {
            this.toolErrorCounts.set(invocation.name, (this.toolErrorCounts.get(invocation.name) ?? 0) + 1);
        }
        switch (invocation.name) {
            case 'WebSearch':
            case 'SearchX':
                this.afterWebSearch(invocation, result);
                break;
            case 'Read':
                this.afterRead(invocation, result);
                break;
            case 'WebFetch':
                this.afterWebFetch(invocation, result);
                break;
            default:
                break;
        }
    }
    cancelInvocation(invocationId) {
        this.pendingSearches.delete(invocationId);
        this.pendingReads.delete(invocationId);
        this.pendingFetches.delete(invocationId);
    }
    beforeWebSearch(invocation) {
        const query = String(invocation.input.query ?? '').trim();
        const fingerprint = normalizeSearchQuery(query);
        const normalized = fingerprint.normalized || query.toLowerCase().trim();
        const cached = this.searchCache.get(normalized);
        if (cached) {
            const reason = cached.noSignal
                ? 'That same WebSearch already returned no useful signal earlier in this session.'
                : 'That same WebSearch already ran earlier in this session.';
            return {
                output: `${reason} Reuse the prior result already in context instead of searching again.\n\n` +
                    `Previous search: ${cached.query}\n` +
                    `Summary:\n${cached.preview}`,
            };
        }
        if (this.webSearchesThisTurn >= MAX_WEBSEARCHES_PER_TURN) {
            return {
                output: `WebSearch budget reached for this turn (${MAX_WEBSEARCHES_PER_TURN} searches). ` +
                    'Stop searching and synthesize the results already collected.',
            };
        }
        let bestFamily = null;
        let bestSimilarity = 0;
        const tokenSet = new Set(fingerprint.tokens);
        for (const family of this.searchFamilies) {
            const similarity = jaccardSimilarity(tokenSet, family.tokens);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestFamily = family;
            }
        }
        if (bestFamily && bestSimilarity >= SEARCH_FAMILY_SIMILARITY) {
            if (bestFamily.noSignalSearches >= MAX_NO_SIGNAL_SEARCHES_PER_FAMILY) {
                return {
                    output: `Search stopped: ${bestFamily.noSignalSearches} similar WebSearch queries for this topic ` +
                        `already returned empty or low-signal results.\n\n` +
                        `Topic exemplar: ${bestFamily.exemplarQuery}\n` +
                        'Present what you have instead of rephrasing the same search.',
                };
            }
            if (bestFamily.turnSearches >= MAX_SIMILAR_SEARCHES_PER_TURN) {
                return {
                    output: `Search stopped: you already ran ${bestFamily.turnSearches} similar WebSearch queries ` +
                        `for this topic in the current turn.\n\n` +
                        `Topic exemplar: ${bestFamily.exemplarQuery}\n` +
                        'Synthesize or switch to a materially different angle.',
                };
            }
        }
        const family = bestFamily && bestSimilarity >= SEARCH_FAMILY_SIMILARITY
            ? bestFamily
            : {
                exemplarQuery: query,
                tokens: tokenSet,
                totalSearches: 0,
                turnSearches: 0,
                noSignalSearches: 0,
            };
        if (family === bestFamily) {
            family.tokens = new Set([...family.tokens, ...tokenSet]);
        }
        else {
            this.searchFamilies.push(family);
        }
        family.totalSearches++;
        family.turnSearches++;
        this.webSearchesThisTurn++;
        this.pendingSearches.set(invocation.id, { normalized, family });
        return null;
    }
    beforeRead(invocation, scope) {
        const filePath = String(invocation.input.file_path ?? '');
        if (!filePath)
            return null;
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(scope.workingDir, filePath);
        let stat;
        try {
            stat = fs.statSync(resolved);
        }
        catch {
            return null;
        }
        if (stat.isDirectory())
            return null;
        const offset = Number(invocation.input.offset ?? 1);
        const limit = Number(invocation.input.limit ?? 2000);
        const key = readKey(resolved, offset, limit);
        const pending = [...this.pendingReads.values()].find((snapshot) => snapshot.key === key);
        if (pending && pending.mtimeMs === stat.mtimeMs && pending.size === stat.size) {
            return {
                output: `Skipped duplicate Read of ${resolved}. The same file and line range is already being read ` +
                    'in this turn, so reuse that content instead of reading it again.',
            };
        }
        const previous = this.recentReads.get(key);
        if (previous &&
            this.turn - previous.turn <= DUPLICATE_READ_TURN_WINDOW &&
            previous.mtimeMs === stat.mtimeMs &&
            previous.size === stat.size) {
            return {
                output: `Skipped duplicate Read of ${resolved}. Same file and line range were already read ` +
                    `${previous.turn === this.turn ? 'this turn' : 'in the previous turn'}, and the file has not changed.`,
            };
        }
        this.pendingReads.set(invocation.id, {
            key,
            resolved,
            offset,
            limit,
            turn: this.turn,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        });
        return null;
    }
    beforeWebFetch(invocation) {
        const url = String(invocation.input.url ?? '').trim();
        if (!url)
            return null;
        const maxLength = Number(invocation.input.max_length ?? 12288);
        const key = fetchKey(url, maxLength);
        const pending = [...this.pendingFetches.values()].find((snapshot) => snapshot.key === key);
        if (pending) {
            return {
                output: `Skipped duplicate WebFetch of ${url}. The same URL is already being fetched in this turn, ` +
                    'so reuse that result instead of fetching it again.',
            };
        }
        const previous = this.recentFetches.get(key);
        if (previous && this.turn - previous.turn <= DUPLICATE_FETCH_TURN_WINDOW) {
            return {
                output: `Skipped duplicate WebFetch of ${url}. The same URL was already fetched recently in this session; ` +
                    'reuse that content already in context instead of fetching it again.',
            };
        }
        this.pendingFetches.set(invocation.id, {
            key,
            url,
            maxLength,
            turn: this.turn,
        });
        return null;
    }
    afterWebSearch(invocation, result) {
        const pending = this.pendingSearches.get(invocation.id);
        if (!pending)
            return;
        this.pendingSearches.delete(invocation.id);
        const query = String(invocation.input.query ?? '').trim();
        const noSignal = isNoSignalSearchResult(result.output, result.isError);
        if (noSignal) {
            pending.family.noSignalSearches++;
        }
        this.searchCache.set(pending.normalized, {
            query,
            preview: summarizeOutput(result.output),
            noSignal,
        });
    }
    afterRead(invocation, result) {
        const pending = this.pendingReads.get(invocation.id);
        if (!pending)
            return;
        this.pendingReads.delete(invocation.id);
        if (result.isError)
            return;
        this.recentReads.set(pending.key, pending);
    }
    afterWebFetch(invocation, result) {
        const pending = this.pendingFetches.get(invocation.id);
        if (!pending)
            return;
        this.pendingFetches.delete(invocation.id);
        if (result.isError)
            return;
        this.recentFetches.set(pending.key, pending);
    }
}
