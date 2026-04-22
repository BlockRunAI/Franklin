/**
 * Turn analyzer — one LLM call per turn that answers every routing-adjacent
 * question the harness needs to make BEFORE the main model runs.
 *
 * Why this exists:
 * Prior versions called separate classifiers for routing (what tier?) and
 * prefetch (is there a ticker?). Each additional harness decision tempted
 * us to add yet another classifier call (pushback? plan? needs-grounding?).
 * Each call adds ~500-800ms of serial latency; stack six of them and the
 * user waits multiple seconds before the main model even starts.
 *
 * This consolidates every LLM-decidable pre-turn question into a single
 * call with a structured JSON response. Net result: 1 classifier call per
 * turn (was 2), replacing multiple keyword rule engines (pushback regex,
 * shouldPlan keyword list, shouldCheckGrounding length gates).
 *
 * Principle: harness orchestrates, models decide. No keyword allowlists,
 * no length thresholds, no regex heuristics encoded in TypeScript.
 *
 * Budget discipline:
 * - Input capped at ~1500 chars across three anchors (current, prev reply,
 *   session goal). Never the full history.
 * - Output capped at 128 tokens (compact single-line JSON).
 * - 2.5s hard timeout; on any failure, conservative default returned so
 *   the main flow never blocks.
 * - 30s in-memory cache keyed on the three anchors so back-to-back near-
 *   identical turns don't re-pay the latency.
 */

import type { ModelClient } from './llm.js';
import type { MarketCode } from '../trading/providers/standard-models.js';
import type { Tier } from '../router/index.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TurnIntent {
  kind: 'ticker';
  symbol: string;
  assetClass: 'stock' | 'crypto';
  market?: MarketCode;
  wantNews: boolean;
}

export interface TurnAnalysis {
  tier: Tier;
  intent: TurnIntent | null;
  /** True for substantive multi-step engineering tasks worth a plan-then-execute split. */
  needsPlanning: boolean;
  /** True when the user is correcting the previous assistant turn. */
  isPushback: boolean;
  /** True when the user asks for current prices / today's state / recent news. */
  asksForLiveData: boolean;
}

/**
 * Safe default returned when the analyzer call fails (timeout, parse error,
 * gateway down). Chosen to be neutral:
 *   - MEDIUM tier → router picks a capable mid-tier model, not the cheapest
 *   - no intent → prefetch skips
 *   - all booleans false → downstream gates don't fire speculatively
 * The main-flow still runs; the harness just loses its per-turn pre-decisions.
 */
const CONSERVATIVE_DEFAULT: TurnAnalysis = {
  tier: 'MEDIUM',
  intent: null,
  needsPlanning: false,
  isPushback: false,
  asksForLiveData: false,
};

// ─── Input budget ───────────────────────────────────────────────────────

const MAX_CURRENT_CHARS = 800;
const MAX_PREV_REPLY_CHARS = 300;
const MAX_GOAL_CHARS = 200;
const TIMEOUT_MS = 2_500;
const MAX_ANALYZER_TOKENS = 128;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 64;

// ─── Analyzer prompt ────────────────────────────────────────────────────
//
// Design: one compact prompt, a few precise examples, instruct the model to
// emit a single-line JSON. Maverick (the classifier backbone since v3.8.23)
// reliably produces plain-text structured output under tight max_tokens,
// unlike thinking-first models that leave text empty.

const ANALYZER_MODEL_DEFAULT = process.env.FRANKLIN_ANALYZER_MODEL || 'nvidia/llama-4-maverick';

const ANALYZER_SYSTEM = `You analyze ONE user message for Franklin's routing + prefetch harness. Output ONE LINE of compact JSON — no explanation, no markdown, no code fences.

## Fields

tier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING"
  SIMPLE    — greetings, arithmetic, trivia, short factual Q
  MEDIUM    — targeted code edits, simple lookups, summaries, single-tool tasks
  COMPLEX   — analysis, recommendations, research questions needing live data, multi-step tool use
  REASONING — formal proofs, derivations, deep logic, multi-variable optimization
  NEVER route ticker / price / stock / "should I" / "why did" questions below COMPLEX.

intent: null OR {"kind":"ticker","symbol":"...","assetClass":"stock"|"crypto","market":"us"|"hk"|"jp"|"kr"|"gb"|"de"|"fr"|"nl"|"ie"|"lu"|"cn"|"ca","wantNews":true|false}
  Set when the user names a ticker, a publicly-traded company, or a cryptocurrency.
  Omit "market" for crypto; default "us" for stocks if unclear.
  wantNews: true if the user asks why / what happened / analyze. false for plain price lookup.

needsPlanning: true | false
  true only for substantive multi-step engineering tasks (build X, refactor Y across many files).

isPushback: true | false
  true when the user is correcting / disagreeing with the previous assistant turn.

asksForLiveData: true | false
  true when the user asks for a current price, today's news, or any live-world state.

## Context anchors in input

[CURRENT]    user's message this turn (primary signal)
[PREV_REPLY] last assistant reply, first ~300 chars (for follow-up references: "那 AAPL 呢", "and that one?", "the other ticker")
[GOAL]       original session prompt, first ~200 chars

If [CURRENT] uses a deictic ("it", "that", "那", "这个"), resolve intent/tier from [PREV_REPLY] or [GOAL].

## Examples

Input:
[CURRENT] hi
Output: {"tier":"SIMPLE","intent":null,"needsPlanning":false,"isPushback":false,"asksForLiveData":false}

Input:
[CURRENT] should I sell CRCL and why did it drop
Output: {"tier":"COMPLEX","intent":{"kind":"ticker","symbol":"CRCL","assetClass":"stock","market":"us","wantNews":true},"needsPlanning":false,"isPushback":false,"asksForLiveData":true}

Input:
[CURRENT] 那 AAPL 呢
[PREV_REPLY] CRCL 当前价格 $96.18，最近因 Drift 诉讼下跌...
Output: {"tier":"COMPLEX","intent":{"kind":"ticker","symbol":"AAPL","assetClass":"stock","market":"us","wantNews":false},"needsPlanning":false,"isPushback":false,"asksForLiveData":true}

Input:
[CURRENT] BTC 为什么跌了
Output: {"tier":"COMPLEX","intent":{"kind":"ticker","symbol":"BTC","assetClass":"crypto","wantNews":true},"needsPlanning":false,"isPushback":false,"asksForLiveData":true}

Input:
[CURRENT] 不对，你应该看 NVDA 不是 AAPL
[PREV_REPLY] AAPL 当前价格 $186.42
Output: {"tier":"COMPLEX","intent":{"kind":"ticker","symbol":"NVDA","assetClass":"stock","market":"us","wantNews":false},"needsPlanning":false,"isPushback":true,"asksForLiveData":true}

Input:
[CURRENT] refactor the wallet module to use typed errors across all call sites
Output: {"tier":"MEDIUM","intent":null,"needsPlanning":true,"isPushback":false,"asksForLiveData":false}

Input:
[CURRENT] prove that sqrt(2) is irrational
Output: {"tier":"REASONING","intent":null,"needsPlanning":false,"isPushback":false,"asksForLiveData":false}

Output the JSON only. One line. No trailing text.`;

// ─── Cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  value: TurnAnalysis;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Simple deterministic string hash for cache keys — no crypto, just bucketing. */
function hashKey(parts: string[]): string {
  const joined = parts.join('');
  let h = 0;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) - h + joined.charCodeAt(i)) | 0;
  }
  return String(h);
}

function cacheGet(key: string): TurnAnalysis | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: TurnAnalysis): void {
  if (cache.size >= CACHE_MAX_SIZE) {
    // Evict oldest by insertion order (Map preserves it).
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test / reset helper. */
export function clearAnalyzerCache(): void {
  cache.clear();
}

// ─── Parsing ────────────────────────────────────────────────────────────

const VALID_TIERS: ReadonlySet<Tier> = new Set<Tier>(['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING']);
const VALID_MARKETS: ReadonlySet<MarketCode> = new Set<MarketCode>([
  'us', 'hk', 'jp', 'kr', 'gb', 'de', 'fr', 'nl', 'ie', 'lu', 'cn', 'ca',
]);

function validateIntent(raw: unknown): TurnIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'ticker') return null;
  const symbol = typeof o.symbol === 'string' ? o.symbol.trim().toUpperCase() : '';
  if (!symbol || !/^[A-Z0-9.\-]+$/.test(symbol)) return null;
  const assetClass = o.assetClass === 'stock' || o.assetClass === 'crypto' ? o.assetClass : null;
  if (!assetClass) return null;
  let market: MarketCode | undefined;
  if (assetClass === 'stock') {
    const m = typeof o.market === 'string' ? o.market.toLowerCase() : 'us';
    market = VALID_MARKETS.has(m as MarketCode) ? (m as MarketCode) : 'us';
  }
  return {
    kind: 'ticker',
    symbol,
    assetClass,
    ...(market ? { market } : {}),
    wantNews: Boolean(o.wantNews),
  };
}

/**
 * Parse the analyzer's JSON output. Returns null on any structural issue;
 * caller falls back to conservative defaults.
 */
export function parseAnalysis(raw: string): TurnAnalysis | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const tier = typeof parsed.tier === 'string' && VALID_TIERS.has(parsed.tier as Tier)
      ? (parsed.tier as Tier)
      : null;
    if (!tier) return null;
    return {
      tier,
      intent: validateIntent(parsed.intent),
      needsPlanning: Boolean(parsed.needsPlanning),
      isPushback: Boolean(parsed.isPushback),
      asksForLiveData: Boolean(parsed.asksForLiveData),
    };
  } catch {
    return null;
  }
}

// ─── Input assembly ─────────────────────────────────────────────────────

/** Build the bounded input the analyzer sees. Never sends raw history. */
function buildAnalyzerInput(
  userInput: string,
  lastAssistantText: string | undefined,
  sessionGoal: string | undefined,
): string {
  const parts: string[] = [];
  parts.push(`[CURRENT]`);
  parts.push(userInput.trim().slice(0, MAX_CURRENT_CHARS));

  if (lastAssistantText && lastAssistantText.trim().length > 0) {
    // First paragraph is usually the most informative. Strip markdown chrome.
    const cleaned = lastAssistantText.trim()
      .replace(/^#+\s+/gm, '')
      .replace(/\*\*/g, '');
    parts.push('');
    parts.push('[PREV_REPLY]');
    parts.push(cleaned.slice(0, MAX_PREV_REPLY_CHARS));
  }

  if (sessionGoal && sessionGoal.trim().length > 0 && sessionGoal.trim() !== userInput.trim()) {
    parts.push('');
    parts.push('[GOAL]');
    parts.push(sessionGoal.trim().slice(0, MAX_GOAL_CHARS));
  }

  return parts.join('\n');
}

// ─── Main API ───────────────────────────────────────────────────────────

export interface AnalyzeOpts {
  lastAssistantText?: string;
  sessionGoal?: string;
  client: ModelClient;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Analyze one turn. Always returns a TurnAnalysis — never throws. On any
 * failure path (timeout, parse error, empty response, gateway down) the
 * conservative default is returned so the main flow proceeds without the
 * harness's pre-decisions. The analyzer is a quality booster, not a
 * correctness requirement.
 */
export async function analyzeTurn(userInput: string, opts: AnalyzeOpts): Promise<TurnAnalysis> {
  if (process.env.FRANKLIN_NO_ANALYZER === '1') return CONSERVATIVE_DEFAULT;
  const trimmed = userInput.trim();
  if (!trimmed) return CONSERVATIVE_DEFAULT;

  const prevReply = opts.lastAssistantText?.trim().slice(0, MAX_PREV_REPLY_CHARS) || '';
  const goal = opts.sessionGoal?.trim().slice(0, MAX_GOAL_CHARS) || '';
  const key = hashKey([trimmed.slice(0, MAX_CURRENT_CHARS), prevReply, goal]);

  const cached = cacheGet(key);
  if (cached) return cached;

  const input = buildAnalyzerInput(trimmed, prevReply || undefined, goal || undefined);

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
  const signal = opts.signal ? anySignal([opts.signal, timeoutCtrl.signal]) : timeoutCtrl.signal;

  try {
    const result = await opts.client.complete(
      {
        model: opts.model || ANALYZER_MODEL_DEFAULT,
        system: ANALYZER_SYSTEM,
        messages: [{ role: 'user', content: input }],
        tools: [],
        max_tokens: MAX_ANALYZER_TOKENS,
      },
      signal,
    );

    let raw = '';
    for (const part of result.content) {
      if (typeof part === 'object' && part.type === 'text' && part.text) raw += part.text;
    }

    const parsed = parseAnalysis(raw);
    const final = parsed || CONSERVATIVE_DEFAULT;
    if (parsed) cacheSet(key, parsed);
    return final;
  } catch {
    return CONSERVATIVE_DEFAULT;
  } finally {
    clearTimeout(timer);
  }
}

/** Compose two AbortSignals into one — aborts when either source aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
