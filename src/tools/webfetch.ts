/**
 * WebFetch capability — fetch web page content.
 */

import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { USER_AGENT } from '../config.js';

interface WebFetchInput {
  url: string;
  max_length?: number;
}

const MAX_BODY_BYTES = 256 * 1024; // 256KB
const DEFAULT_MAX_LENGTH = 12_288;
const HTML_READ_AHEAD_BYTES = 8_192;

// ─── Session cache ──────────────────────────────────────────────────────────
// Avoids re-fetching the same URL within a session (common in research tasks).
// 15-min TTL, max 50 entries.

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
  output: string;
  expiresAt: number;
}

const fetchCache = new Map<string, CacheEntry>();

function cacheKey(url: string, maxLength: number): string {
  return `${url}::${maxLength}`;
}

function getCached(key: string): string | null {
  const entry = fetchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    fetchCache.delete(key);
    return null;
  }
  return entry.output;
}

function setCached(key: string, output: string): void {
  // Evict oldest entry if at capacity
  if (fetchCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = fetchCache.keys().next().value;
    if (firstKey) fetchCache.delete(firstKey);
  }
  fetchCache.set(key, { output, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Drop every cached fetch so a fresh session doesn't serve stale content
 * that was fetched under the previous session's intent. The 15-minute TTL
 * would eventually catch this, but we'd rather start clean.
 */
export function clearSessionState(): void {
  fetchCache.clear();
}

// ─── Execute ────────────────────────────────────────────────────────────────

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
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

  const maxLen = Math.min(max_length ?? DEFAULT_MAX_LENGTH, MAX_BODY_BYTES);

  // ── YouTube special case ──
  // Plain HTML fetch on a youtube.com URL returns the SPA bundle (a wall of
  // minified JS), which is useless to the model and was the failure mode
  // behind "I can't access YouTube" responses. Auto-redirect to the caption
  // track so the model gets the actual spoken content. Transparent to
  // callers — same WebFetch tool, the right thing happens for video URLs.
  const videoId = extractYouTubeVideoId(parsed);
  if (videoId) {
    const ytKey = cacheKey(`youtube-transcript:${videoId}`, maxLen);
    const ytCached = getCached(ytKey);
    if (ytCached) return { output: ytCached + '\n\n(cached)' };
    const transcript = await fetchYouTubeTranscript(videoId, ctx.abortSignal);
    if (transcript.ok) {
      const truncated = transcript.text.length > maxLen
        ? transcript.text.slice(0, maxLen) + '\n\n... (transcript truncated)'
        : transcript.text;
      const output = `URL: ${url}\nSource: YouTube auto-captions (videoId=${videoId}, lang=${transcript.lang})\n\n${truncated}`;
      setCached(ytKey, output);
      return { output };
    }
    // Fall through to raw HTML fetch only if transcript path failed entirely;
    // surface why so the model can decide what to do (e.g., suggest a manual
    // step) instead of silently scraping JS.
    return {
      output: `YouTube transcript unavailable for ${url} — ${transcript.reason}. The video may have captions disabled or be region-locked.`,
      isError: true,
    };
  }

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

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    const readBudget = contentType.includes('html')
      ? Math.min(maxLen + HTML_READ_AHEAD_BYTES, MAX_BODY_BYTES)
      : maxLen;

    try {
      while (totalBytes < readBudget) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
      }
    } finally {
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
      } catch { /* leave as-is if not valid JSON */ }
    } else if (contentType.includes('html')) {
      body = stripHtml(rawBody).slice(0, maxLen);
    } else {
      body = rawBody.slice(0, maxLen);
    }

    let output = `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${body}`;

    if (totalBytes >= readBudget || rawBody.length > maxLen) {
      output += '\n\n... (content truncated)';
    }

    // Cache successful responses
    setCached(key, output);

    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.abortSignal.aborted) {
      return { output: `Error: request aborted for ${url}`, isError: true };
    }
    if (msg.includes('abort')) {
      return { output: `Error: request timed out after 30s for ${url}`, isError: true };
    }
    return { output: `Error fetching ${url}: ${msg}`, isError: true };
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

// ─── YouTube transcript fetcher ─────────────────────────────────────────────
// Fetches auto-generated or uploaded captions for a YouTube video by parsing
// the watch-page's `ytInitialPlayerResponse` JSON. Pure HTTP, no deps. Saves
// us from the alternative (shelling out to yt-dlp, which the user may not
// have installed) and from leaving the model to guess at JS bundles.

function extractYouTubeVideoId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    return parsed.pathname.slice(1).split('/')[0] || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v');
    }
    // /shorts/{id}, /live/{id}, /embed/{id}
    const shortsMatch = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/);
    if (shortsMatch) return shortsMatch[1];
  }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string; // "asr" = auto-generated
}

interface PlayerResponseShape {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

async function fetchYouTubeTranscript(
  videoId: string,
  abortSignal: AbortSignal,
): Promise<{ ok: true; text: string; lang: string } | { ok: false; reason: string }> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const onAbort = () => ctrl.abort();
  abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(watchUrl, {
      signal: ctrl.signal,
      headers: {
        // Pretend to be a desktop browser so YouTube serves the watch page
        // with the player config inlined. The default Node fetch UA gets a
        // consent-redirect HTML stub that has no caption metadata.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      return { ok: false, reason: `watch page HTTP ${res.status}` };
    }
    const html = await res.text();

    // ytInitialPlayerResponse can be assigned in two shapes; both occur in
    // practice across mobile vs desktop responses.
    const match =
      html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*var\s+meta/s) ||
      html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!match) {
      return { ok: false, reason: 'could not locate ytInitialPlayerResponse in watch page' };
    }
    let player: PlayerResponseShape;
    try {
      player = JSON.parse(match[1]) as PlayerResponseShape;
    } catch {
      return { ok: false, reason: 'ytInitialPlayerResponse JSON parse failed' };
    }
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) {
      return { ok: false, reason: 'no caption tracks (video has captions disabled)' };
    }
    // Prefer English; fall back to first available; auto-captions are fine.
    const track =
      tracks.find(t => (t.languageCode || '').startsWith('en')) ||
      tracks[0];
    if (!track?.baseUrl) {
      return { ok: false, reason: 'caption track has no baseUrl' };
    }

    // Request the JSON3 format — easier to parse than the default XML and
    // YouTube serves it on the same endpoint with a query flag.
    const captionUrl = track.baseUrl + (track.baseUrl.includes('fmt=') ? '' : '&fmt=json3');
    const capRes = await fetch(captionUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!capRes.ok) {
      return { ok: false, reason: `caption fetch HTTP ${capRes.status}` };
    }
    const capRaw = await capRes.text();
    const text = parseJson3Captions(capRaw) || parseXmlCaptions(capRaw);
    if (!text) {
      return { ok: false, reason: 'caption response had no readable text segments' };
    }
    return { ok: true, text, lang: track.languageCode || 'unknown' };
  } catch (err) {
    if (abortSignal.aborted) {
      return { ok: false, reason: 'request aborted' };
    }
    return {
      ok: false,
      reason: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', onAbort);
  }
}

function parseJson3Captions(raw: string): string {
  try {
    const obj = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    if (!obj.events) return '';
    const out: string[] = [];
    for (const ev of obj.events) {
      if (!ev.segs) continue;
      for (const seg of ev.segs) {
        if (seg.utf8) out.push(seg.utf8);
      }
    }
    // Collapse the per-word fragments YouTube emits into readable lines.
    return out.join('').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  } catch {
    return '';
  }
}

function parseXmlCaptions(raw: string): string {
  // Fallback for older XML format. Regex-only parse — captions text is
  // simple enough that pulling in xml2js for this would be overkill.
  const matches = [...raw.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  if (matches.length === 0) return '';
  return matches
    .map(m => m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join(' ');
}

function stripHtml(html: string): string {
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

export const webFetchCapability: CapabilityHandler = {
  spec: {
    name: 'WebFetch',
    description: 'Fetch a web page and return its content as text. For searching the web, use WebSearch instead. Cannot access X.com (use SearchX). Large pages are truncated. Prefer WebSearch for discovery, WebFetch for reading a specific known URL.',
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
