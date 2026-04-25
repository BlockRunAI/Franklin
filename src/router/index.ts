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
export type RoutingProfile = 'auto' | 'eco' | 'premium' | 'free';

export interface RoutingResult {
  model: string;
  tier: Tier;
  confidence: number;
  signals: string[];
  savings: number;
  category?: Category;
}

// ─── Tier Model Configs ───

// Agent-first defaults. Sonnet-tier models are the current sweet spot for
// multi-step tool-use agent work; cheap models keep derailing on simple agent
// loops. Each tier's fallback ends with a cheaper option so payment/quota
// failures don't strand users on equally expensive alternatives.
const AUTO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'google/gemini-2.5-flash',
    fallback: ['moonshot/kimi-k2.6', 'deepseek/deepseek-chat'],
  },
  MEDIUM: {
    primary: 'anthropic/claude-sonnet-4.6',
    fallback: ['openai/gpt-5.5', 'google/gemini-3.1-pro', 'moonshot/kimi-k2.6'],
  },
  COMPLEX: {
    primary: 'anthropic/claude-sonnet-4.6',
    fallback: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'moonshot/kimi-k2.6'],
  },
  REASONING: {
    // Opus 4.7: step-change improvement in agentic coding over 4.6 per
    // Anthropic. Same price, same 200k ctx in Franklin's baseline, so
    // swap is cost-neutral. 4.6 stays in the fallback chain in case of
    // rollout delays on the gateway side.
    primary: 'anthropic/claude-opus-4.7',
    fallback: [
      'anthropic/claude-opus-4.6',
      'openai/o3',
      'xai/grok-4-1-fast-reasoning',
      'deepseek/deepseek-reasoner',
    ],
  },
};

const ECO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'nvidia/glm-4.7',
    fallback: ['nvidia/gpt-oss-120b', 'nvidia/deepseek-v3.2'],
  },
  MEDIUM: {
    primary: 'google/gemini-2.5-flash-lite',
    fallback: ['nvidia/glm-4.7', 'nvidia/qwen3-coder-480b'],
  },
  COMPLEX: {
    primary: 'google/gemini-2.5-flash-lite',
    fallback: ['deepseek/deepseek-chat', 'nvidia/glm-4.7'],
  },
  REASONING: {
    primary: 'xai/grok-4-1-fast-reasoning',
    fallback: ['deepseek/deepseek-reasoner', 'nvidia/qwen3-next-80b-a3b-thinking'],
  },
};

const PREMIUM_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'moonshot/kimi-k2.6',
    fallback: ['anthropic/claude-haiku-4.5'],
  },
  MEDIUM: {
    primary: 'openai/gpt-5.3-codex',
    fallback: ['anthropic/claude-sonnet-4.6'],
  },
  COMPLEX: {
    primary: 'anthropic/claude-opus-4.7',
    fallback: ['anthropic/claude-opus-4.6', 'openai/gpt-5.5', 'anthropic/claude-sonnet-4.6'],
  },
  REASONING: {
    primary: 'anthropic/claude-opus-4.7',
    fallback: ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6', 'openai/o3'],
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
  'what is', 'define', 'translate', 'hello', 'yes or no', 'capital of',
  'how old', 'who is', 'when was', '什么是', '翻译', '你好',
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

  // Select tier config based on profile
  let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
  switch (profile) {
    case 'eco':
      tierConfigs = ECO_TIERS;
      break;
    case 'premium':
      tierConfigs = PREMIUM_TIERS;
      break;
    default:
      tierConfigs = AUTO_TIERS;
  }

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
  let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
  switch (profile) {
    case 'eco':     tierConfigs = ECO_TIERS; break;
    case 'premium': tierConfigs = PREMIUM_TIERS; break;
    default:        tierConfigs = AUTO_TIERS;
  }
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
      model: 'nvidia/glm-4.7',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: ['free-profile'],
      savings: 1.0,
    };
  }
  let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
  switch (profile) {
    case 'eco':     tierConfigs = ECO_TIERS; break;
    case 'premium': tierConfigs = PREMIUM_TIERS; break;
    default:        tierConfigs = AUTO_TIERS;
  }
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
      model: 'nvidia/glm-4.7',
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
  let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
  switch (profile) {
    case 'eco':
      tierConfigs = ECO_TIERS;
      break;
    case 'premium':
      tierConfigs = PREMIUM_TIERS;
      break;
    case 'free':
      return ['nvidia/glm-4.7'];
    default:
      tierConfigs = AUTO_TIERS;
  }

  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}

/**
 * Parse routing profile from model string
 */
export function parseRoutingProfile(model: string): RoutingProfile | null {
  const lower = model.toLowerCase();
  if (lower === 'blockrun/auto' || lower === 'auto') return 'auto';
  if (lower === 'blockrun/eco' || lower === 'eco') return 'eco';
  if (lower === 'blockrun/premium' || lower === 'premium') return 'premium';
  if (lower === 'blockrun/free' || lower === 'free') return 'free';
  return null;
}
