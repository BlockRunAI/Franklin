/**
 * Smart Router for brcc
 * Ported from ClawRouter - 15-dimension weighted scoring for tier classification
 */

export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';
export type RoutingProfile = 'auto' | 'eco' | 'premium' | 'free';

export interface RoutingResult {
  model: string;
  tier: Tier;
  confidence: number;
  signals: string[];
  savings: number;
}

// ─── Tier Model Configs ───

const AUTO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'google/gemini-2.5-flash',
    fallback: ['deepseek/deepseek-chat', 'nvidia/gpt-oss-120b'],
  },
  MEDIUM: {
    primary: 'moonshot/kimi-k2.5',
    fallback: ['google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
  },
  COMPLEX: {
    primary: 'google/gemini-3.1-pro',
    fallback: ['anthropic/claude-sonnet-4.6', 'google/gemini-2.5-pro'],
  },
  REASONING: {
    primary: 'xai/grok-4-1-fast-reasoning',
    fallback: ['deepseek/deepseek-reasoner', 'openai/o4-mini'],
  },
};

const ECO_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'nvidia/gpt-oss-120b',
    fallback: ['google/gemini-2.5-flash-lite'],
  },
  MEDIUM: {
    primary: 'google/gemini-2.5-flash-lite',
    fallback: ['nvidia/gpt-oss-120b'],
  },
  COMPLEX: {
    primary: 'google/gemini-2.5-flash-lite',
    fallback: ['deepseek/deepseek-chat'],
  },
  REASONING: {
    primary: 'xai/grok-4-1-fast-reasoning',
    fallback: ['deepseek/deepseek-reasoner'],
  },
};

const PREMIUM_TIERS: Record<Tier, { primary: string; fallback: string[] }> = {
  SIMPLE: {
    primary: 'moonshot/kimi-k2.5',
    fallback: ['anthropic/claude-haiku-4.5'],
  },
  MEDIUM: {
    primary: 'openai/gpt-5.3-codex',
    fallback: ['anthropic/claude-sonnet-4.6'],
  },
  COMPLEX: {
    primary: 'anthropic/claude-opus-4.6',
    fallback: ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'],
  },
  REASONING: {
    primary: 'anthropic/claude-sonnet-4.6',
    fallback: ['anthropic/claude-opus-4.6', 'openai/o3'],
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
  '编辑', '修改', '部署', '安装', '修复', '调试',
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

  // Token count scoring
  if (tokenCount < 50) {
    score -= 0.3;
    signals.push('short');
  } else if (tokenCount > 500) {
    score += 0.3;
    signals.push('long');
  }

  // Code detection (weight: 0.15)
  const codeMatches = countMatches(prompt, CODE_KEYWORDS);
  if (codeMatches >= 2) {
    score += 0.4;
    signals.push('code');
  } else if (codeMatches >= 1) {
    score += 0.2;
  }

  // Reasoning detection (weight: 0.18)
  const reasoningMatches = countMatches(prompt, REASONING_KEYWORDS);
  if (reasoningMatches >= 2) {
    // Direct reasoning override
    return { tier: 'REASONING', confidence: 0.9, signals: [...signals, 'reasoning'] };
  } else if (reasoningMatches >= 1) {
    score += 0.35;
    signals.push('reasoning-light');
  }

  // Simple detection (weight: -0.12)
  const simpleMatches = countMatches(prompt, SIMPLE_KEYWORDS);
  if (simpleMatches >= 1) {
    score -= 0.4;
    signals.push('simple');
  }

  // Technical complexity (weight: 0.10)
  const techMatches = countMatches(prompt, TECHNICAL_KEYWORDS);
  if (techMatches >= 2) {
    score += 0.3;
    signals.push('technical');
  }

  // Agentic detection (weight: 0.04)
  const agenticMatches = countMatches(prompt, AGENTIC_KEYWORDS);
  if (agenticMatches >= 3) {
    score += 0.2;
    signals.push('agentic');
  }

  // Multi-step patterns
  if (/first.*then|step \d|\d\.\s/i.test(prompt)) {
    score += 0.15;
    signals.push('multi-step');
  }

  // Question complexity
  const questionCount = (prompt.match(/\?/g) || []).length;
  if (questionCount > 3) {
    score += 0.1;
    signals.push(`${questionCount} questions`);
  }

  // Map score to tier
  let tier: Tier;
  if (score < 0.0) {
    tier = 'SIMPLE';
  } else if (score < 0.3) {
    tier = 'MEDIUM';
  } else if (score < 0.5) {
    tier = 'COMPLEX';
  } else {
    tier = 'REASONING';
  }

  // Calculate confidence based on distance from boundary
  const confidence = Math.min(0.95, 0.7 + Math.abs(score) * 0.3);

  return { tier, confidence, signals };
}

// ─── Main Router ───

export function routeRequest(
  prompt: string,
  profile: RoutingProfile = 'auto'
): RoutingResult {
  // Free profile - always use free model
  if (profile === 'free') {
    return {
      model: 'nvidia/gpt-oss-120b',
      tier: 'SIMPLE',
      confidence: 1.0,
      signals: ['free-profile'],
      savings: 1.0,
    };
  }

  // Estimate token count (rough: 4 chars per token)
  const tokenCount = Math.ceil(prompt.length / 4);

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

  // Calculate savings estimate
  // Baseline: Claude Opus at $5/$25 per 1M tokens
  const OPUS_COST_PER_1K = 0.015; // rough average
  const modelCosts: Record<string, number> = {
    'nvidia/gpt-oss-120b': 0,
    'google/gemini-2.5-flash': 0.001,
    'google/gemini-2.5-flash-lite': 0.0003,
    'deepseek/deepseek-chat': 0.0004,
    'moonshot/kimi-k2.5': 0.002,
    'google/gemini-3.1-pro': 0.007,
    'anthropic/claude-sonnet-4.6': 0.009,
    'anthropic/claude-opus-4.6': 0.015,
    'xai/grok-4-1-fast-reasoning': 0.0004,
  };
  const modelCost = modelCosts[model] ?? 0.005;
  const savings = Math.max(0, (OPUS_COST_PER_1K - modelCost) / OPUS_COST_PER_1K);

  return {
    model,
    tier,
    confidence,
    signals,
    savings,
  };
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
      return ['nvidia/gpt-oss-120b'];
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
