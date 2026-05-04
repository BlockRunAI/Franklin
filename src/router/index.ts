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
import { MODEL_PRICING, OPUS_PRICING } from '../pricing.js';
import { BLOCKRUN_DIR } from '../config.js';
import { detectCategory, mapCategoryToTier, type Category } from './categories.js';
import { selectModel } from './selector.js';
import type { LearnedWeights } from './selector.js';
import { computeLocalElo, blendElo } from './local-elo.js';

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
// at $0.50/$1.00 (launch promo) covering SIMPLE+MEDIUM and Opus covering
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
}

// ─── Tier Model Configs ───

// Auto-routing strategy (post-DeepSeek-V4-Pro launch promo, 2026-05-03):
// V4 Pro at $0.50/$1.00 with 1M context is the new sweet spot for SIMPLE +
// MEDIUM agent work — Sonnet-quality reasoning at ~1/6 the price. Reserve
// Opus only for genuinely complex multi-file/multi-decision tasks where
// the model's wider context handling and tighter tool-use discipline still
// pay for themselves. Sonnet drops to fallback because V4 Pro covers most
// of what users were calling Sonnet for, at a fraction of the cost.
const AUTO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'deepseek/deepseek-v4-pro',
    fallback: ['google/gemini-2.5-flash', 'moonshot/kimi-k2.6', 'deepseek/deepseek-chat'],
  },
  MEDIUM: {
    primary: 'deepseek/deepseek-v4-pro',
    fallback: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5', 'google/gemini-3.1-pro'],
  },
  COMPLEX: {
    // Hard tasks — multi-file refactors, ambiguous specs, dense reasoning
    // chains — still go to Opus. V4 Pro is great but not a Sonnet/Opus
    // replacement at the high end of difficulty per recent agent-bench runs.
    primary: 'anthropic/claude-opus-4.7',
    fallback: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4.6', 'deepseek/deepseek-v4-pro'],
  },
  REASONING: {
    // Opus 4.7: step-change improvement in agentic coding over 4.6 per
    // Anthropic. 4.6 stays in the fallback chain in case of rollout delays.
    primary: 'anthropic/claude-opus-4.7',
    fallback: [
      'anthropic/claude-opus-4.6',
      'openai/o3',
      'deepseek/deepseek-v4-pro',
      'xai/grok-4-1-fast-reasoning',
      'deepseek/deepseek-reasoner',
    ],
  },
};


// ─── Keywords for Classification ───

const CODE_KEYWORDS = [
  'function', 'class', 'import', 'def', 'SELECT', 'async', 'await',
  'const', 'let', 'var', 'return', '```', '函数', '类', '导入',
];

const REASONING_KEYWORDS = [
  'prove', 'theorem', 'derive', 'step by step', 'chain of thought',
  'formally', 'mathematical', 'proof', 'logically', '证明', '定理', '推导',
];

const SIMPLE_KEYWORDS = [
  // True simple intents: greeting, definition lookup, translation. Factual
  // lookups ("who is", "when was", "capital of") were moved to RESEARCH below
  // because they look easy but require external recall — sending them to
  // SIMPLE-tier models reliably produces hallucinated subscriber counts,
  // birth years, etc. that the post-hoc grounding check then has to flag.
  'define', 'translate', 'hello', 'yes or no', '翻译', '你好',
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
  '最好的', '最新', '最近', '现在', '当前', '排名', '对比',
];

const TECHNICAL_KEYWORDS = [
  'algorithm', 'optimize', 'architecture', 'distributed', 'kubernetes',
  'microservice', 'database', 'infrastructure', '算法', '架构', '优化',
];

const AGENTIC_KEYWORDS = [
  'read file', 'edit', 'modify', 'update', 'create file', 'execute',
  'deploy', 'install', 'npm', 'pip', 'fix', 'debug', 'verify',
  'commit', 'push', 'pull', 'merge', 'rename', 'replace', 'delete',
  'remove', 'add', 'change', 'move', 'refactor', 'migrate',
  '编辑', '修改', '部署', '安装', '修复', '调试',
  '更新', '替换', '删除', '添加', '提交', '改',
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
    'generate', 'construct', '构建', '创建', '实现', '设计', '开发'
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
  const tierConfigs = AUTO_TIERS;

  const model = tierConfigs[tier].primary;
  const savings = computeSavings(model);
  const category = detectCategory(prompt, loadLearnedWeights()?.category_keywords).category;

  return { model, tier, confidence, signals, savings, category };
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

// llama-4-maverick: clean one-word classification output. glm-4.7 + qwen-
// thinking emit reasoning into thinking blocks and leave text empty under
// tight max_tokens — fine for chat, wrong shape for single-word dispatch.
const CLASSIFIER_MODEL = process.env.FRANKLIN_ROUTER_MODEL || 'nvidia/llama-4-maverick';
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
 * Async router — LLM classifier first, keyword classifier as fallback.
 * Profile-specific tier tables (AUTO / ECO / PREMIUM / FREE) still pick
 * the concrete model; the classifier only picks the TIER.
 */
export async function routeRequestAsync(
  prompt: string,
  profile: RoutingProfile = 'auto',
  classify: TierClassifier = llmClassifyRequest,
): Promise<RoutingResult> {
  // Free / short-circuit profiles — no classifier needed.
  if (profile === 'free') return routeRequest(prompt, profile);

  const tier = await classify(prompt).catch(() => null);
  if (!tier) {
    // Classifier miss or disabled — fall through to the sync keyword router.
    return routeRequest(prompt, profile);
  }

  // Build a RoutingResult from the LLM-picked tier using the same tier
  // tables the keyword path uses. Keeps downstream code path-identical.
  const tierConfigs = AUTO_TIERS;
  const model = tierConfigs[tier].primary;
  const category = detectCategory(prompt, loadLearnedWeights()?.category_keywords).category;
  return {
    model,
    tier,
    confidence: 0.85, // LLM classification — medium-high confidence
    signals: ['llm-classified'],
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
export function resolveTierToModel(tier: Tier, profile: RoutingProfile = 'auto'): RoutingResult {
  // Free profile short-circuits — everything routes to a single free model.
  if (profile === 'free') {
    return {
      model: 'nvidia/qwen3-coder-480b',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: ['free-profile'],
      savings: 1.0,
    };
  }
  const tierConfigs = AUTO_TIERS;
  const model = tierConfigs[tier].primary;
  return {
    model,
    tier,
    confidence: 0.85,
    signals: ['pre-classified'],
    savings: computeSavings(model),
  };
}

// ─── Main Router ───

export function routeRequest(
  prompt: string,
  profile: RoutingProfile = 'auto'
): RoutingResult {
  // Free profile — always use free model
  if (profile === 'free') {
    return {
      model: 'nvidia/qwen3-coder-480b',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: ['free-profile'],
      savings: 1.0,
    };
  }

  // Auto profile bypasses learned routing. The learned Elo scores grow with
  // usage volume rather than pure quality, which biased the router toward
  // cheap/weak models on agentic work. Classic AUTO_TIERS defaults are
  // agent-tuned (Sonnet-tier backbone) and more predictable for users.
  if (profile === 'auto') {
    return classicRouteRequest(prompt, profile);
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
  return classicRouteRequest(prompt, profile);
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
// Coding goes to qwen3-coder; everything else (chat / trading / research /
// reasoning / creative) prefers general-purpose free models that aren't
// coder-tuned. Without this split, a BTC question that exhausted paid
// models was being handed to qwen3-coder-480b — a coder model trying to
// do technical analysis. Reported 2026-05-03 with a markets question
// routed to a coder model on Sonnet failure.
const FREE_MODELS_BY_CATEGORY: Record<Category, string[]> = {
  coding:    ['nvidia/qwen3-coder-480b', 'nvidia/glm-4.7', 'nvidia/llama-4-maverick'],
  trading:   ['nvidia/glm-4.7', 'nvidia/llama-4-maverick', 'nvidia/qwen3-coder-480b'],
  research:  ['nvidia/glm-4.7', 'nvidia/llama-4-maverick', 'nvidia/qwen3-coder-480b'],
  reasoning: ['nvidia/glm-4.7', 'nvidia/qwen3-coder-480b', 'nvidia/llama-4-maverick'],
  chat:      ['nvidia/llama-4-maverick', 'nvidia/glm-4.7', 'nvidia/qwen3-coder-480b'],
  creative:  ['nvidia/llama-4-maverick', 'nvidia/glm-4.7', 'nvidia/qwen3-coder-480b'],
};

const DEFAULT_FREE_CHAIN: string[] = [
  'nvidia/glm-4.7',
  'nvidia/llama-4-maverick',
  'nvidia/qwen3-coder-480b',
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
