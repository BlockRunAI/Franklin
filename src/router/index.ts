/**
 * Smart Router for Franklin
 *
 * Two routing modes:
 *   1. Learned — uses Elo scores from 2M+ gateway requests (router-weights.json)
 *   2. Classic — 15-dimension keyword scoring (fallback when no weights)
 *
 * The learned router detects request category (coding, trading, reasoning, etc.)
 * and picks the model with the best quality-to-cost ratio for that category.
 * Local Elo adjustments personalize routing per user over time.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ROUTING_CONFIG as SHARED_ROUTING_CONFIG,
  route as routeWithSharedCore,
  type TaskType,
} from '@blockrun/router-core';
import { MODEL_PRICING, OPUS_PRICING } from '../pricing.js';
import { BLOCKRUN_DIR } from '../config.js';
import { detectCategory, mapCategoryToTier, type Category } from './categories.js';
import { selectModel } from './selector.js';
import type { LearnedWeights } from './selector.js';
import { computeLocalElo, blendElo } from './local-elo.js';
import { isVisionModel } from './vision.js';

export { isVisionModel, messageNeedsVision, messagesNeedVision, pickVisionSibling } from './vision.js';

// ─── Learned Weights Loading ───

const WEIGHTS_FILE = path.join(BLOCKRUN_DIR, 'router-weights.json');
let cachedWeights: LearnedWeights | null | undefined; // undefined = not loaded yet

function loadLearnedWeights(): LearnedWeights | null {
  if (cachedWeights !== undefined) return cachedWeights;
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      cachedWeights = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf-8')) as LearnedWeights;
      return cachedWeights;
    }
  } catch { /* fall through */ }
  cachedWeights = null;
  return null;
}

export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
// 2026-05-03: collapsed Eco / Premium routing profiles into Auto. With V4 Pro
// at $0.435/$0.87 (the launch promo became permanent list) covering SIMPLE+MEDIUM and Opus covering
// COMPLEX, separate Eco ("free models everywhere") and Premium ("Opus
// everywhere") profiles became redundant — Auto already spans the cost/
// quality spectrum. `blockrun/eco` and `blockrun/premium` still parse to
// 'auto' below so existing configs keep working.
export type RoutingProfile = 'auto' | 'free';

export interface RoutingResult {
  model: string;
  tier: Tier;
  confidence: number;
  signals: string[];
  savings: number;
  category?: Category;
  /** Ordered capability-eligible recovery chain. The selected model is first. */
  candidates?: string[];
  /** Explainable task class produced by the shared Router core. */
  taskType?: TaskType;
  /** Shared Router implementation that made this decision. */
  routerVersion?: 'v2-rules' | 'v3-portfolio' | 'franklin-legacy';
  reasoning?: string;
}

/** Request capabilities known by the Franklin host at routing time. */
export interface RoutingContext {
  needsVision?: boolean;
  maxOutputTokens?: number;
  hasTools?: boolean;
  toolNames?: readonly string[];
  requiresTools?: boolean;
  requiresStructuredOutput?: boolean;
  systemPrompt?: string;
  /**
   * Extra model ids to treat as dead for this call only, on top of the
   * process-wide set (see markModelUnavailable). Tests use this; hosts
   * normally let the runtime observation feed the process-wide set.
   */
  unavailableModels?: readonly string[];
}

const SHARED_MODEL_PRICING = new Map(
  Object.entries(MODEL_PRICING).map(([model, pricing]) => [
    model,
    {
      inputPrice: pricing.input,
      outputPrice: pricing.output,
      ...(pricing.perCall !== undefined ? { flatPrice: pricing.perCall } : {}),
    },
  ]),
);

// ─── Dead-rung kill-switch ───
//
// router-core ships its tier chains as committed config, so a model that
// leaves the gateway keeps its rung until a core release and a consumer
// repin land — weeks, historically (the free/gpt-oss rungs 400'd for two
// weeks before d7bc10c retired them). `options.unavailableModels` is the
// core's answer: ids the host has observed dead are hard-removed from every
// chain before selection, effective on the next request. Franklin feeds it
// from three sources:
//
//   1. KNOWN_UNAVAILABLE_MODELS — ids the committed core config still
//      references that the gateway has been observed to REJECT. Absence from
//      GET /v1/models is NOT evidence: on 2026-08-29 every catalog-absent id
//      the core config names (Opus 4.6, the K2.x line, the xAI 3.x / 4-0709 /
//      4-fast family, gpt-5-nano) was probed through the binary and every one
//      answered and was charged — the gateway hides them from the catalog
//      but still serves them. Only add an id here after a real 400/404/410,
//      and drop it once the core config itself stops naming it.
//   2. QUARANTINED_MODELS — ids the catalog DOES list but Franklin refuses to
//      route to, because the free pool answers for them with a substitute
//      (the response's `model` field names a different model) and leaks
//      thinking prose into content. Same "never promise a model the user
//      doesn't get" rule the picker applies; see FREE_MODELS_BY_CATEGORY.
//   3. Runtime observations — markModelUnavailable() is called by the agent
//      loop when the gateway rejects a routed model id (400 "Unknown model",
//      404, 410 — see AgentErrorInfo.modelUnavailable). Process-scoped: the
//      next routing decision in this session never picks that id again.
//
// The core treats this as distinct from user-preference exclusion: a chain
// whose every rung is dead keeps its config (the outage stays visible)
// instead of fail-opening to something the host said is gone.
const KNOWN_UNAVAILABLE_MODELS: readonly string[] = [
  // Empty as of 2026-08-29 — see the probe note above. The free/gpt-oss and
  // free/deepseek-v4-flash rungs that would have lived here were retired in
  // the core itself (d7bc10c), which is the steady state this list waits for.
];

const QUARANTINED_MODELS: readonly string[] = [
  // Catalogued free id; live probe 2026-08-29 answered as
  // nvidia/nemotron-3-super-120b with the reasoning trace duplicated into
  // `content`. The core uses it as the free backstop rung of every Auto
  // chain — Franklin's chains end one rung earlier instead.
  'nvidia/step-3.7-flash',
];

const observedUnavailable = new Set<string>();

/**
 * Record that the gateway rejected a model id outright (400 "Unknown model",
 * 404, 410). Every later routing decision in this process removes it from
 * the shared Router's chains. Idempotent; returns true the first time.
 */
export function markModelUnavailable(model: string | undefined | null): boolean {
  if (!model || observedUnavailable.has(model)) return false;
  observedUnavailable.add(model);
  return true;
}

/** Ids the shared Router must not select: static, quarantined, and observed. */
export function getUnavailableModels(extra?: readonly string[]): string[] {
  return [...new Set([
    ...KNOWN_UNAVAILABLE_MODELS,
    ...QUARANTINED_MODELS,
    ...observedUnavailable,
    ...(extra ?? []),
  ])];
}

export function isModelUnavailable(model: string | undefined | null): boolean {
  if (!model) return false;
  return observedUnavailable.has(model)
    || KNOWN_UNAVAILABLE_MODELS.includes(model)
    || QUARANTINED_MODELS.includes(model);
}

/** Test hook: forget runtime observations (the static lists stay). */
export function resetUnavailableModels(): void {
  observedUnavailable.clear();
}

function normalizeRoutingContext(context: boolean | RoutingContext): RoutingContext {
  return typeof context === 'boolean' ? { needsVision: context } : context;
}

// ─── Tier Model Configs ───

// Auto-routing strategy (post-DeepSeek-V4-Pro launch promo, 2026-05-03):
// V4 Pro at $0.435/$0.87 with 1M context is the new sweet spot for SIMPLE +
// MEDIUM agent work — Sonnet-quality reasoning at ~1/6 the price. Reserve
// Opus only for genuinely complex multi-file/multi-decision tasks where
// the model's wider context handling and tighter tool-use discipline still
// pay for themselves. Sonnet drops to fallback because V4 Pro covers most
// of what users were calling Sonnet for, at a fraction of the cost.
const AUTO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'deepseek/deepseek-v4-pro',
    // Cheap-tier fallbacks only. Kimi dropped here 2026-07: the K2.x line was
    // retired and its replacement K3 is premium-priced ($3/$15) — it doesn't
    // belong in a cost-saving fallback chain.
    fallback: ['google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
  },
  MEDIUM: {
    primary: 'deepseek/deepseek-v4-pro',
    fallback: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5', 'google/gemini-3.1-pro'],
  },
  COMPLEX: {
    // Hard tasks — multi-file refactors, ambiguous specs, dense reasoning
    // chains — still go to Opus. V4 Pro is great but not a Sonnet/Opus
    // replacement at the high end of difficulty per recent agent-bench runs.
    primary: 'anthropic/claude-opus-5',
    fallback: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5', 'anthropic/claude-sonnet-4.6', 'deepseek/deepseek-v4-pro'],
  },
  REASONING: {
    // Opus 5: latest flagship, most capable for agentic coding, same $5/$25 as
    // the 4.x Opus line. 4.8 and 4.7 stay in the fallback chain in case of
    // rollout delays.
    primary: 'anthropic/claude-opus-5',
    fallback: [
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-4.7',
      'openai/o3',
      'deepseek/deepseek-v4-pro',
      // Hidden from /v1/models but still served (probed 2026-08-29).
      'xai/grok-4-1-fast-reasoning',
      'deepseek/deepseek-reasoner',
    ],
  },
};


/**
 * If this turn carries an image, the picked tier model must be able to see it.
 * Walks the tier's primary+fallback chain for the first vision-capable model;
 * if none of them have vision, escalates to COMPLEX (Opus is always vision).
 *
 * Note: only applied when the caller signals needsVision=true. Without that
 * hint the classic per-tier defaults still rule — V4 Pro's $0.435/$0.87 price
 * is the right SIMPLE/MEDIUM pick for text-only turns and we don't want to
 * blanket-upgrade everyone to a vision model.
 */
function pickVisionTierModel(tier: Tier): { model: string; tier: Tier; signal: string } {
  const chain = [AUTO_TIERS[tier].primary, ...AUTO_TIERS[tier].fallback];
  const visionInTier = chain.find(isVisionModel);
  if (visionInTier) return { model: visionInTier, tier, signal: 'vision-required' };
  // Tier chain is fully text-only (unusual but possible if cheap tiers get
  // re-tuned). Escalate to COMPLEX whose primary (Opus) is always vision.
  const escalated = [AUTO_TIERS.COMPLEX.primary, ...AUTO_TIERS.COMPLEX.fallback]
    .find(isVisionModel) ?? AUTO_TIERS.COMPLEX.primary;
  return { model: escalated, tier: 'COMPLEX', signal: 'vision-escalated' };
}

// ─── Keywords for Classification ───
//
// Keyword fast-path uses English only by policy (English-only-source rule).
// Non-English user queries route through the LLM-level classifier above this
// fast-path, which is multilingual and handles intent correctly without
// needing per-language keyword lists here.

const CODE_KEYWORDS = [
  'function', 'class', 'import', 'def', 'SELECT', 'async', 'await',
  'const', 'let', 'var', 'return', '```',
];

const REASONING_KEYWORDS = [
  'prove', 'theorem', 'derive', 'step by step', 'chain of thought',
  'formally', 'mathematical', 'proof', 'logically',
];

const SIMPLE_KEYWORDS = [
  // True simple intents: greeting, definition lookup, translation. Factual
  // lookups ("who is", "when was", "capital of") were moved to RESEARCH below
  // because they look easy but require external recall — sending them to
  // SIMPLE-tier models reliably produces hallucinated subscriber counts,
  // birth years, etc. that the post-hoc grounding check then has to flag.
  'define', 'translate', 'hello', 'yes or no',
];

// Research / fact-retrieval intent: questions whose correct answer depends
// on data the model can't reliably recall from weights — current statistics,
// latest news, comparisons, "best" rankings, identities of people/orgs.
// Bumping tier here pushes them to a MEDIUM/COMPLEX model that has
// WebSearch in its toolset, instead of letting a cheap text-only model
// fabricate plausible-looking numbers.
const RESEARCH_KEYWORDS = [
  'who is', 'who was', 'when was', 'when did', 'what is the capital',
  'how old', 'how many', 'how much',
  'best', 'top ', 'most popular', 'compare', 'vs ', ' vs.',
  'latest', 'current', 'recent', 'today', 'now',
  'subscribers', 'members', 'followers', 'market cap', 'price of',
];

const TECHNICAL_KEYWORDS = [
  'algorithm', 'optimize', 'architecture', 'distributed', 'kubernetes',
  'microservice', 'database', 'infrastructure',
];

const AGENTIC_KEYWORDS = [
  'read file', 'edit', 'modify', 'update', 'create file', 'execute',
  'deploy', 'install', 'npm', 'pip', 'fix', 'debug', 'verify',
  'commit', 'push', 'pull', 'merge', 'rename', 'replace', 'delete',
  'remove', 'add', 'change', 'move', 'refactor', 'migrate',
];

// URL patterns that signal agentic/coding tasks
const AGENTIC_URL_PATTERNS = [
  /github\.com/i, /gitlab\.com/i, /bitbucket\.org/i,
  /npmjs\.com/i, /pypi\.org/i, /crates\.io/i,
  /stackoverflow\.com/i, /docs\.\w+/i,
  // Media URLs need the model to actually fetch+understand content,
  // not just regurgitate from weights. Bumping these prevents the
  // "user pastes 3 YouTube links → SIMPLE-tier model gives up" path.
  /youtube\.com/i, /youtu\.be/i,
  /twitter\.com/i, /x\.com/i,
];

// ─── Classifier ───

interface ClassifyResult {
  tier: Tier;
  confidence: number;
  signals: string[];
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
}

function classifyRequest(prompt: string, tokenCount: number): ClassifyResult {
  const signals: string[] = [];
  let score = 0;

  // Token count scoring (reduced weight - don't penalize short prompts too much)
  if (tokenCount < 30) {
    score -= 0.15;
    signals.push('short');
  } else if (tokenCount > 500) {
    score += 0.2;
    signals.push('long');
  }

  // Code detection (weight: 0.20) - increased weight
  const codeMatches = countMatches(prompt, CODE_KEYWORDS);
  // Extra weight for code blocks (triple backticks)
  const codeBlockCount = (prompt.match(/```/g) || []).length / 2; // pairs
  if (codeBlockCount >= 1 || codeMatches >= 2) {
    score += 0.5;
    signals.push(codeBlockCount >= 1 ? 'code-block' : 'code');
  } else if (codeMatches >= 1) {
    score += 0.25;
    signals.push('code-light');
  }

  // Reasoning detection (weight: 0.18)
  const reasoningMatches = countMatches(prompt, REASONING_KEYWORDS);
  if (reasoningMatches >= 2) {
    // Direct reasoning override
    return { tier: 'REASONING', confidence: 0.9, signals: [...signals, 'reasoning'] };
  } else if (reasoningMatches >= 1) {
    score += 0.4;
    signals.push('reasoning-light');
  }

  // Simple detection (weight: -0.12) - only trigger on strong simple signals
  const simpleMatches = countMatches(prompt, SIMPLE_KEYWORDS);
  if (simpleMatches >= 2) {
    score -= 0.4;
    signals.push('simple');
  } else if (simpleMatches >= 1 && codeMatches === 0 && tokenCount < 50) {
    // Only mark as simple if no code and very short
    score -= 0.25;
    signals.push('simple');
  }

  // Research / fact-lookup detection (weight: +0.30). Bumps tier upward so
  // questions like "best subreddit", "current price of X", "how many members"
  // route to a model that can actually call WebSearch instead of guessing
  // from weights. Capped at one keyword's worth — research questions
  // typically signal with one phrase, and stacking would push trivial
  // questions into REASONING.
  const researchMatches = countMatches(prompt, RESEARCH_KEYWORDS);
  if (researchMatches >= 1) {
    score += 0.30;
    signals.push('research');
  }

  // Technical complexity (weight: 0.15) - increased
  const techMatches = countMatches(prompt, TECHNICAL_KEYWORDS);
  if (techMatches >= 2) {
    score += 0.4;
    signals.push('technical');
  } else if (techMatches >= 1) {
    score += 0.2;
    signals.push('technical-light');
  }

  // Agentic detection — lowered thresholds (real tasks often have just 1-2 action words)
  const agenticMatches = countMatches(prompt, AGENTIC_KEYWORDS);
  const hasAgenticUrl = AGENTIC_URL_PATTERNS.some(p => p.test(prompt));
  const agenticScore = agenticMatches + (hasAgenticUrl ? 1 : 0);
  if (agenticScore >= 3) {
    score += 0.35;
    signals.push('agentic');
  } else if (agenticScore >= 2) {
    score += 0.25;
    signals.push('agentic-light');
  } else if (agenticScore >= 1) {
    score += 0.15;
    signals.push('agentic-hint');
  }

  // Multi-step patterns
  if (/first.*then|step \d|\d\.\s/i.test(prompt)) {
    score += 0.2;
    signals.push('multi-step');
  }

  // Question complexity
  const questionCount = (prompt.match(/\?/g) || []).length;
  if (questionCount > 3) {
    score += 0.15;
    signals.push(`${questionCount} questions`);
  }

  // Imperative verbs (build, create, implement, etc.)
  const imperativeMatches = countMatches(prompt, [
    'build', 'create', 'implement', 'design', 'develop', 'write', 'make',
    'generate', 'construct',
  ]);
  if (imperativeMatches >= 1) {
    score += 0.15;
    signals.push('imperative');
  }

  // Map score to tier (adjusted boundaries)
  let tier: Tier;
  if (score < -0.1) {
    tier = 'SIMPLE';
  } else if (score < 0.25) {
    tier = 'MEDIUM';
  } else if (score < 0.45) {
    tier = 'COMPLEX';
  } else {
    tier = 'REASONING';
  }

  // Calculate confidence based on distance from boundary
  const confidence = Math.min(0.95, 0.7 + Math.abs(score) * 0.3);

  return { tier, confidence, signals };
}

// ─── Classic Router (keyword-based fallback) ───

function classicRouteRequest(
  prompt: string,
  profile: RoutingProfile,
  needsVision = false,
): RoutingResult {
  // Estimate token count (use byte length / 4 for better accuracy with non-ASCII)
  const byteLen = Buffer.byteLength(prompt, 'utf-8');
  const tokenCount = Math.ceil(byteLen / 4);

  // Classify the request
  const { tier, confidence, signals } = classifyRequest(prompt, tokenCount);

  // Auto is the only routing profile now (Eco/Premium were retired
  // 2026-05-03 — see comment on RoutingProfile above). 'free' is handled
  // earlier by the caller path; if it ever reaches here, fall through to
  // AUTO_TIERS rather than crashing.
  let model: string;
  let finalTier: Tier = tier;
  const finalSignals = [...signals];
  if (needsVision) {
    const v = pickVisionTierModel(tier);
    model = v.model;
    finalTier = v.tier;
    finalSignals.push(v.signal);
  } else {
    model = AUTO_TIERS[tier].primary;
  }
  const savings = computeSavings(model);
  const category = detectCategory(prompt, loadLearnedWeights()?.category_keywords).category;

  return { model, tier: finalTier, confidence, signals: finalSignals, savings, category };
}

// ─── LLM-based classifier ───
//
// Historical router was a 15-dimension keyword scorer — every new failure
// mode needed another KEYWORD list (CODE, REASONING, ANALYSIS, ...). Cheap
// to run but structurally wrong: keywords always lag reality, and users
// phrase the same intent fifty different ways. A free model can just
// *read* the prompt and tell us the tier.
//
// Design:
//   - Classification prompt is one word answer: SIMPLE | MEDIUM | COMPLEX | REASONING
//   - Runs on a free NVIDIA model — $0/call, so we can afford it on every turn
//   - 2s hard timeout + strict parse; any failure falls through to the
//     keyword classifier so we always have a routing answer
//   - Exposed via async `routeRequestAsync(prompt, profile, classify?)`. Callers
//     that can't be async (proxy, LLM-client bootstrap) keep using the sync
//     `routeRequest`, which silently does keyword-only routing.

// The classifier needs a free model that answers with ONE BARE WORD under a
// tight max_tokens. That is a narrower requirement than "is a good free chat
// model", and most of the free pool fails it by streaming chain-of-thought
// into `content` (glm-4.7 and the qwen-thinking builds emit reasoning and
// leave text empty; nemotron-nano-9b-v2 opens with "Okay, let's see. The user
// wants to…" and never reaches a verdict inside the budget).
//
// 2026-08-19: the previous default, nvidia/qwen3-next-80b-a3b-instruct, was
// EOL'd by NVIDIA (410 on 2026-07-27) — the gateway now rides its calls on
// nemotron-3-super-120b, which leaks prose. Every classification has been
// failing the strict parse and falling through to keyword-only routing ever
// since, silently, because the fallback is by design invisible.
//
// nemotron-3-nano-omni is the replacement: live-probed on this exact prompt
// shape it returns "MEDIUM" and nothing else, and it verifiably serves itself
// rather than riding a pooled substitute.
const CLASSIFIER_MODEL = process.env.FRANKLIN_ROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const CLASSIFIER_TIMEOUT_MS = 2_500;

const CLASSIFIER_SYSTEM = `You classify a user's message into ONE routing tier for a CLI agent. Reply with EXACTLY ONE WORD from the allowed set. No explanation, no punctuation, no quotes.

Tiers:
- SIMPLE    — greetings, trivia, arithmetic, short definitions, yes/no questions. A single memory-based reply is acceptable.
- MEDIUM    — multi-turn code edits, targeted bug fixes, lookups, summaries. Some tool use expected.
- COMPLEX   — substantive engineering, analysis, recommendations, research questions that depend on current-world data (stock prices, current events, live market state). Multiple tool calls + synthesis.
- REASONING — formal proofs, derivations, deep chains of logic, multi-variable optimization.

If the message names a ticker, asks for a recommendation, or asks "why did X happen", it is COMPLEX or REASONING — never SIMPLE.

Answer format: a single word. SIMPLE or MEDIUM or COMPLEX or REASONING.`;

export type TierClassifier = (prompt: string) => Promise<Tier | null>;

/**
 * Parse a one-word classifier reply into a Tier. Returns null on junk so
 * the caller can fall back to keyword classification.
 */
function parseTierWord(reply: string): Tier | null {
  const m = reply.trim().toUpperCase().match(/\b(SIMPLE|MEDIUM|COMPLEX|REASONING)\b/);
  return m ? (m[1] as Tier) : null;
}

/**
 * Default LLM classifier — lazy-imports the ModelClient to avoid a hard
 * cycle with agent/llm.ts (which itself imports routing helpers for virtual
 * profile resolution). Callers can substitute their own classifier for
 * tests by passing one to `routeRequestAsync`.
 */
export async function llmClassifyRequest(prompt: string): Promise<Tier | null> {
  if (!prompt || prompt.trim().length === 0) return null;
  // Very short messages: skip the classifier call, let keyword path decide.
  // Saves ~500ms on "hi" / "thanks" / slash commands.
  if (prompt.trim().length < 10) return null;

  let ModelClientCtor: typeof import('../agent/llm.js').ModelClient;
  let chain: import('../config.js').Chain;
  let apiUrl: string;
  try {
    const llmMod = await import('../agent/llm.js');
    const cfgMod = await import('../config.js');
    ModelClientCtor = llmMod.ModelClient;
    chain = cfgMod.loadChain();
    apiUrl = cfgMod.API_URLS[chain];
  } catch {
    return null;
  }
  const client = new ModelClientCtor({ apiUrl, chain });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const result = await client.complete(
      {
        model: CLASSIFIER_MODEL,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: prompt.slice(0, 2000) }],
        tools: [],
        max_tokens: 8,
      },
      ctrl.signal,
    );
    let text = '';
    for (const part of result.content) {
      if (typeof part === 'object' && part.type === 'text' && part.text) text += part.text;
    }
    return parseTierWord(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compatibility async router. Production Auto routing is local and delegates
 * directly to the shared Router core, so it adds no classifier round trip.
 * Tests and third-party integrations may still inject an explicit classifier;
 * that legacy path remains available during the migration window.
 */
export async function routeRequestAsync(
  prompt: string,
  profile: RoutingProfile = 'auto',
  classify?: TierClassifier,
  context: boolean | RoutingContext = false,
): Promise<RoutingResult> {
  // The production path intentionally has no extra model call. Keeping the
  // function async avoids breaking existing callers while removing router
  // latency and classifier spend.
  if (!classify || profile === 'free') return routeRequest(prompt, profile, context);

  const normalizedContext = normalizeRoutingContext(context);

  const tier = await classify(prompt).catch(() => null);
  if (!tier) {
    return routeRequest(prompt, profile, normalizedContext);
  }

  // Build a RoutingResult from the LLM-picked tier using the same tier
  // tables the keyword path uses. Keeps downstream code path-identical.
  let model: string;
  let finalTier: Tier = tier;
  const signals: string[] = ['llm-classified'];
  if (normalizedContext.needsVision) {
    const v = pickVisionTierModel(tier);
    model = v.model;
    finalTier = v.tier;
    signals.push(v.signal);
  } else {
    model = AUTO_TIERS[tier].primary;
  }
  const category = detectCategory(prompt, loadLearnedWeights()?.category_keywords).category;
  return {
    model,
    tier: finalTier,
    confidence: 0.85, // LLM classification — medium-high confidence
    signals,
    savings: computeSavings(model),
    category,
  };
}

/**
 * Map a pre-classified tier to a concrete model + savings using the profile's
 * tier table. No classifier call — assumes the caller already decided the
 * tier (typically via the turn-analyzer, which rolls tier classification in
 * with intent / pushback / planning decisions in one LLM call).
 *
 * Use this when you have a tier already. Use `routeRequestAsync` when you
 * need the classifier to produce the tier.
 */
export function resolveTierToModel(
  tier: Tier,
  profile: RoutingProfile = 'auto',
  needsVision = false,
): RoutingResult {
  // Free profile short-circuits — everything routes to a single free model.
  // Vision turns go to nemotron-nano-12b-v2-vl: the one vision-capable free
  // model that verifiably serves itself (the 30B omni line is pooled onto a
  // text-only substitute upstream, verified live 2026-08-12).
  if (profile === 'free') {
    return {
      model: needsVision ? 'nvidia/nemotron-nano-12b-v2-vl' : 'nvidia/nemotron-nano-9b-v2',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: needsVision ? ['free-profile', 'free-vision'] : ['free-profile'],
      savings: 1.0,
    };
  }
  let model: string;
  let finalTier: Tier = tier;
  const signals: string[] = ['pre-classified'];
  if (needsVision) {
    const v = pickVisionTierModel(tier);
    model = v.model;
    finalTier = v.tier;
    signals.push(v.signal);
  } else {
    model = AUTO_TIERS[tier].primary;
  }
  return {
    model,
    tier: finalTier,
    confidence: 0.85,
    signals,
    savings: computeSavings(model),
  };
}

// ─── Main Router ───

export function routeRequest(
  prompt: string,
  profile: RoutingProfile = 'auto',
  context: boolean | RoutingContext = false,
): RoutingResult {
  const normalizedContext = normalizeRoutingContext(context);

  // Free profile — always use free model (vision turns get the free VL model;
  // see resolveTierToModel for the rationale).
  if (profile === 'free') {
    return {
      model: normalizedContext.needsVision ? 'nvidia/nemotron-nano-12b-v2-vl' : 'nvidia/nemotron-nano-9b-v2',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: normalizedContext.needsVision ? ['free-profile', 'free-vision'] : ['free-profile'],
      savings: 1.0,
      candidates: FREE_MODELS_BY_CATEGORY.chat,
    };
  }

  // Emergency rollback for operators. This keeps the former Franklin rules
  // available without making them the default or mixing their Elo state into
  // the shared Router decision.
  if (process.env.FRANKLIN_ROUTER_STRATEGY === 'legacy') {
    return {
      ...classicRouteRequest(prompt, profile, normalizedContext.needsVision),
      routerVersion: 'franklin-legacy',
    };
  }

  // Auto now uses the same local, deterministic Router core as ClawRouter.
  // Hard capability requirements filter candidates before portfolio scoring;
  // no network request, wallet access, benchmark grader or settlement adapter
  // runs in this path.
  if (profile === 'auto') {
    const toolNames = normalizedContext.toolNames ?? [];
    const decision = routeWithSharedCore(
      prompt,
      normalizedContext.systemPrompt,
      Math.max(1, normalizedContext.maxOutputTokens ?? 4_096),
      {
        config: {
          ...SHARED_ROUTING_CONFIG,
          strategy: process.env.FRANKLIN_ROUTER_STRATEGY === 'rules' ? 'rules' : 'portfolio',
        },
        modelPricing: SHARED_MODEL_PRICING,
        routingProfile: 'auto',
        hasTools: normalizedContext.hasTools ?? toolNames.length > 0,
        toolCount: toolNames.length,
        toolNames,
        ...(normalizedContext.requiresTools !== undefined
          ? { requiresTools: normalizedContext.requiresTools }
          : {}),
        hasVision: normalizedContext.needsVision ?? false,
        requiresStructuredOutput: normalizedContext.requiresStructuredOutput ?? false,
        unavailableModels: getUnavailableModels(normalizedContext.unavailableModels),
      },
    );
    const category = detectCategory(prompt, loadLearnedWeights()?.category_keywords).category;
    return {
      model: decision.model,
      tier: decision.tier,
      confidence: decision.confidence,
      signals: [decision.routerVersion ?? decision.method, ...(decision.taskType ? [decision.taskType] : [])],
      savings: decision.savings,
      category,
      candidates: decision.candidates ?? [decision.model],
      taskType: decision.taskType,
      routerVersion: decision.routerVersion,
      reasoning: decision.reasoning,
    };
  }

  // ── Learned routing (if weights available) ──
  const weights = loadLearnedWeights();
  if (weights) {
    const { category, confidence } = detectCategory(prompt, weights.category_keywords);

    // Apply local Elo adjustments
    const localElo = computeLocalElo();
    const localCatMap = localElo.get(category);

    // Create adjusted weights with blended Elo scores
    const adjustedWeights: LearnedWeights = localCatMap
      ? {
          ...weights,
          model_scores: {
            ...weights.model_scores,
            [category]: (weights.model_scores[category] || []).map(s => ({
              ...s,
              elo: blendElo(s.elo, localCatMap.get(s.model) ?? 0),
            })),
          },
        }
      : weights;

    const selected = selectModel(category, profile, adjustedWeights);
    if (selected) {
      const tier = mapCategoryToTier(category);
      // Vision-aware substitution: if the Elo-picked model is text-only but
      // the turn needs vision, swap to the tier's first vision-capable model.
      // We deliberately don't blend Elo with vision capability — vision is a
      // hard requirement, not a quality dimension.
      if (normalizedContext.needsVision && !isVisionModel(selected.model)) {
        const v = pickVisionTierModel(tier);
        return {
          model: v.model,
          tier: v.tier,
          confidence,
          signals: [category, v.signal],
          savings: computeSavings(v.model),
          category,
        };
      }
      const savings = computeSavings(selected.model);
      return {
        model: selected.model,
        tier,
        confidence,
        signals: [category],
        savings,
        category,
      };
    }
    // Fall through to classic if selectModel returns null (no candidates for category)
  }

  // ── Classic routing (keyword-based fallback) ──
  return classicRouteRequest(prompt, profile, normalizedContext.needsVision);
}

function computeSavings(model: string): number {
  const opusCostPer1K = (OPUS_PRICING.input + OPUS_PRICING.output) / 2 / 1000;
  const modelPricing = MODEL_PRICING[model];
  const modelCostPer1K = modelPricing
    ? (modelPricing.input + modelPricing.output) / 2 / 1000
    : 0.005;
  return Math.max(0, (opusCostPer1K - modelCostPer1K) / opusCostPer1K);
}

/**
 * Get fallback models for a tier
 */
export function getFallbackChain(
  tier: Tier,
  profile: RoutingProfile = 'auto'
): string[] {
  if (profile === 'free') return FREE_MODELS_BY_CATEGORY.chat;
  const config = AUTO_TIERS[tier];
  return [config.primary, ...config.fallback];
}

// ─── Free-tier fallback (used when paid models 402 / rate-limit) ───

// Free fallback chains by question category. Used when a paid model fails
// mid-turn (402 payment, rate-limit) and we need a zero-cost replacement
// to keep the user moving without waiting for funding.
//
// The lists are ordered: best-fit free model first, then degraded fallbacks.
// llama-4-maverick leads every category — it's the only reliably-healthy free
// model and covers chat / coding / reasoning. deepseek-v4-flash (1M ctx) is the
// secondary; it occasionally times out on the NVIDIA NIM upstream, so it sits
// behind maverick rather than leading.
// 2026-06-07: nvidia/glm-4.7 dropped from every chain — NVIDIA NIM hung, the
// gateway redirected it to a now-dead model, so routing to it just wasted a slot.
// 2026-07-11: nvidia/deepseek-v4-flash removed — the gateway no longer serves
// it (410). Free tier is now led by nvidia/qwen3-next-80b-a3b-instruct (cleanest
// free instruction-follower — no thinking leak / markdown fences, verified live).
// 2026-07-14: nvidia/llama-4-maverick replaced by nvidia/mistral-nemotron as the
// different-family fallback. Maverick left the gateway catalog, and the free
// pool silently substitutes for it — a live probe showed both maverick and
// qwen3-next answering as `nvidia/nemotron-3-super-120b-a12b-free`. Two chain
// entries backed by the same pooled model is fake resilience: the fallback
// couldn't rescue a turn the primary had already failed. mistral-nemotron
// verifiably serves itself, so the chain is genuinely two families again.
// 2026-08-12: nvidia/qwen3-next-80b-a3b-instruct removed — NVIDIA EOL'd it
// (410 on 2026-07-27; the gateway hid it and rides its calls on a fallback).
// nemotron-nano-9b-v2 promoted to lead: it is the only free text model that
// verifiably serves ITSELF on the streaming path Franklin uses (verified live
// through the binary today). mistral-nemotron is DEGRADED at NVIDIA — stream
// calls 400 ("DEGRADED function cannot be invoked") and non-stream calls ride
// the gateway's disclosed fallback.
// 2026-08-19: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning promoted to
// second. When it was last probed it came back served as gpt-oss-120b — the
// pooled-substitute trap this comment warns about — but NVIDIA has since
// fixed it: it now answers as ITSELF on both the streaming and non-streaming
// paths, and it returns clean single-word output under tight max_tokens (it
// is also the router's classifier for that reason). mistral-nemotron drops to
// third: still DEGRADED at NVIDIA, kept as a genuinely different family for
// the case where both Nemotron nano builds are down. The catalog's fifth free
// id, step-3.7-flash, stays out of every chain — it leaks thinking prose into
// content AND comes back served by nemotron-3-super-120b (re-probed
// 2026-08-29, unchanged). It is also QUARANTINED for the shared Router above,
// which would otherwise use it as the free backstop rung of every Auto chain.
const OMNI = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

const FREE_MODELS_BY_CATEGORY: Record<Category, string[]> = {
  coding:    ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
  trading:   ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
  research:  ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
  reasoning: ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
  chat:      ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
  creative:  ['nvidia/nemotron-nano-9b-v2', OMNI, 'nvidia/mistral-nemotron'],
};

const DEFAULT_FREE_CHAIN: string[] = [
  'nvidia/nemotron-nano-9b-v2',
  OMNI,
  'nvidia/mistral-nemotron',
];

/**
 * Pick the next free model to try given the question category and which
 * free models have already failed this turn. Returns undefined when every
 * candidate has been exhausted (caller should surface an error to user).
 */
export function pickFreeFallback(
  category: string,
  alreadyFailed: Set<string>
): string | undefined {
  const chain = (FREE_MODELS_BY_CATEGORY as Record<string, string[]>)[category]
    ?? DEFAULT_FREE_CHAIN;
  return chain.find(m => !alreadyFailed.has(m));
}

/**
 * Parse routing profile from model string
 */
export function parseRoutingProfile(model: string): RoutingProfile | null {
  const lower = model.toLowerCase();
  if (lower === 'blockrun/auto' || lower === 'auto') return 'auto';
  if (lower === 'blockrun/free' || lower === 'free') return 'free';
  // Back-compat: Eco / Premium routing profiles were retired 2026-05-03.
  // Existing configs / sessions that still pass these values get silently
  // promoted to Auto so nothing breaks; new code should use 'auto' directly.
  if (lower === 'blockrun/eco' || lower === 'eco') return 'auto';
  if (lower === 'blockrun/premium' || lower === 'premium') return 'auto';
  return null;
}
