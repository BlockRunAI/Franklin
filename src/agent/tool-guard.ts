import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityInvocation, CapabilityResult, ExecutionScope } from './types.js';

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

interface SearchFamily {
  exemplarQuery: string;
  tokens: Set<string>;
  totalSearches: number;
  turnSearches: number;
  noSignalSearches: number;
}

interface SearchRecord {
  query: string;
  preview: string;
  noSignal: boolean;
}

interface PendingSearch {
  normalized: string;
  family: SearchFamily;
}

interface FileSnapshot {
  key: string;
  resolved: string;
  offset: number;
  limit: number;
  turn: number;
  mtimeMs: number;
  size: number;
}

interface FetchSnapshot {
  key: string;
  url: string;
  maxLength: number;
  turn: number;
}

function stemToken(token: string): string {
  let result = token.toLowerCase();
  if (/^\d{4}$/.test(result)) return '';
  if (result.endsWith('ing') && result.length > 6) result = result.slice(0, -3);
  else if (result.endsWith('ers') && result.length > 5) result = result.slice(0, -3);
  else if (result.endsWith('er') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('ed') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('es') && result.length > 4) result = result.slice(0, -2);
  else if (result.endsWith('s') && result.length > 4) result = result.slice(0, -1);
  return result;
}

export function normalizeSearchQuery(query: string): { normalized: string; tokens: string[] } {
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

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function summarizeOutput(output: string): string {
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

function isNoSignalSearchResult(output: string, isError?: boolean): boolean {
  const lower = output.toLowerCase();
  return Boolean(
    isError ||
    lower.startsWith('no results found for:') ||
    lower.startsWith('no candidate posts found') ||
    lower.startsWith('search timed out') ||
    lower.startsWith('search error:') ||
    lower.startsWith('searchx error:')
  );
}

function readKey(resolved: string, offset?: number, limit?: number): string {
  return `${resolved}::${offset ?? 1}::${limit ?? 2000}`;
}

function fetchKey(url: string, maxLength?: number): string {
  return `${url}::${maxLength ?? 12288}`;
}

export class SessionToolGuard {
  private turn = 0;
  private webSearchesThisTurn = 0;
  private searchFamilies: SearchFamily[] = [];
  private searchCache = new Map<string, SearchRecord>();
  private pendingSearches = new Map<string, PendingSearch>();
  private recentReads = new Map<string, FileSnapshot>();
  private pendingReads = new Map<string, FileSnapshot>();
  private recentFetches = new Map<string, FetchSnapshot>();
  private pendingFetches = new Map<string, FetchSnapshot>();

  startTurn(): void {
    this.turn++;
    this.webSearchesThisTurn = 0;
    for (const family of this.searchFamilies) {
      family.turnSearches = 0;
    }
  }

  async beforeExecute(
    invocation: CapabilityInvocation,
    scope: ExecutionScope
  ): Promise<CapabilityResult | null> {
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

  afterExecute(invocation: CapabilityInvocation, result: CapabilityResult): void {
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

  cancelInvocation(invocationId: string): void {
    this.pendingSearches.delete(invocationId);
    this.pendingReads.delete(invocationId);
    this.pendingFetches.delete(invocationId);
  }

  private beforeWebSearch(invocation: CapabilityInvocation): CapabilityResult | null {
    const query = String(invocation.input.query ?? '').trim();
    const fingerprint = normalizeSearchQuery(query);
    const normalized = fingerprint.normalized || query.toLowerCase().trim();

    const cached = this.searchCache.get(normalized);
    if (cached) {
      const reason = cached.noSignal
        ? 'That same WebSearch already returned no useful signal earlier in this session.'
        : 'That same WebSearch already ran earlier in this session.';
      return {
        output:
          `${reason} Reuse the prior result already in context instead of searching again.\n\n` +
          `Previous search: ${cached.query}\n` +
          `Summary:\n${cached.preview}`,
      };
    }

    if (this.webSearchesThisTurn >= MAX_WEBSEARCHES_PER_TURN) {
      return {
        output:
          `WebSearch budget reached for this turn (${MAX_WEBSEARCHES_PER_TURN} searches). ` +
          'Stop searching and synthesize the results already collected.',
      };
    }

    let bestFamily: SearchFamily | null = null;
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
          output:
            `Search stopped: ${bestFamily.noSignalSearches} similar WebSearch queries for this topic ` +
            `already returned empty or low-signal results.\n\n` +
            `Topic exemplar: ${bestFamily.exemplarQuery}\n` +
            'Present what you have instead of rephrasing the same search.',
        };
      }
      if (bestFamily.turnSearches >= MAX_SIMILAR_SEARCHES_PER_TURN) {
        return {
          output:
            `Search stopped: you already ran ${bestFamily.turnSearches} similar WebSearch queries ` +
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
    } else {
      this.searchFamilies.push(family);
    }

    family.totalSearches++;
    family.turnSearches++;
    this.webSearchesThisTurn++;
    this.pendingSearches.set(invocation.id, { normalized, family });
    return null;
  }

  private beforeRead(
    invocation: CapabilityInvocation,
    scope: ExecutionScope
  ): CapabilityResult | null {
    const filePath = String(invocation.input.file_path ?? '');
    if (!filePath) return null;

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(scope.workingDir, filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (stat.isDirectory()) return null;

    const offset = Number(invocation.input.offset ?? 1);
    const limit = Number(invocation.input.limit ?? 2000);
    const key = readKey(resolved, offset, limit);

    const pending = [...this.pendingReads.values()].find((snapshot) => snapshot.key === key);
    if (pending && pending.mtimeMs === stat.mtimeMs && pending.size === stat.size) {
      return {
        output:
          `Skipped duplicate Read of ${resolved}. The same file and line range is already being read ` +
          'in this turn, so reuse that content instead of reading it again.',
      };
    }

    const previous = this.recentReads.get(key);
    if (
      previous &&
      this.turn - previous.turn <= DUPLICATE_READ_TURN_WINDOW &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.size === stat.size
    ) {
      return {
        output:
          `Skipped duplicate Read of ${resolved}. Same file and line range were already read ` +
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

  private beforeWebFetch(invocation: CapabilityInvocation): CapabilityResult | null {
    const url = String(invocation.input.url ?? '').trim();
    if (!url) return null;
    const maxLength = Number(invocation.input.max_length ?? 12288);
    const key = fetchKey(url, maxLength);

    const pending = [...this.pendingFetches.values()].find((snapshot) => snapshot.key === key);
    if (pending) {
      return {
        output:
          `Skipped duplicate WebFetch of ${url}. The same URL is already being fetched in this turn, ` +
          'so reuse that result instead of fetching it again.',
      };
    }

    const previous = this.recentFetches.get(key);
    if (previous && this.turn - previous.turn <= DUPLICATE_FETCH_TURN_WINDOW) {
      return {
        output:
          `Skipped duplicate WebFetch of ${url}. The same URL was already fetched recently in this session; ` +
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

  private afterWebSearch(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingSearches.get(invocation.id);
    if (!pending) return;
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

  private afterRead(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingReads.get(invocation.id);
    if (!pending) return;
    this.pendingReads.delete(invocation.id);
    if (result.isError) return;
    this.recentReads.set(pending.key, pending);
  }

  private afterWebFetch(invocation: CapabilityInvocation, result: CapabilityResult): void {
    const pending = this.pendingFetches.get(invocation.id);
    if (!pending) return;
    this.pendingFetches.delete(invocation.id);
    if (result.isError) return;
    this.recentFetches.set(pending.key, pending);
  }
}
