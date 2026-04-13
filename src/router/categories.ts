/**
 * Request category detection for the learned router.
 * Classifies requests into categories (coding, trading, reasoning, etc.)
 * using keyword matching from router weights or built-in defaults.
 */

export type Category = 'coding' | 'trading' | 'reasoning' | 'chat' | 'creative' | 'research';

// Built-in category keywords (used when no learned weights available)
const DEFAULT_CATEGORY_KEYWORDS: Record<Category, string[]> = {
  coding: [
    'function', 'class', 'import', 'def', 'SELECT', 'async', 'await',
    'const', 'let', 'var', 'return', '```', 'bug', 'error', 'fix',
    'refactor', 'implement', 'test', 'npm', 'pip', 'git', 'deploy',
    'API', 'endpoint', 'database', 'query', 'migration', 'lint',
    '函数', '类', '导入', '修复', '调试', '部署',
  ],
  trading: [
    'BTC', 'ETH', 'SOL', 'bitcoin', 'ethereum', 'solana', 'crypto',
    'price', 'market', 'signal', 'trade', 'buy', 'sell', 'RSI',
    'MACD', 'volume', 'bullish', 'bearish', 'support', 'resistance',
    'portfolio', 'risk', 'leverage', 'DeFi', 'token', 'swap',
    '比特币', '以太坊', '价格', '市场', '交易', '信号',
  ],
  reasoning: [
    'prove', 'theorem', 'derive', 'step by step', 'chain of thought',
    'formally', 'mathematical', 'proof', 'logically', 'analyze',
    'compare', 'evaluate', 'trade-off', 'pros and cons', 'why',
    'explain why', 'reasoning', 'logic', 'deduce', 'infer',
    '证明', '定理', '推导', '分析', '比较',
  ],
  creative: [
    'write a story', 'poem', 'creative', 'brainstorm', 'imagine',
    'generate an image', 'design', 'logo', 'illustration', 'art',
    'narrative', 'fiction', 'song', 'lyrics', 'slogan', 'tagline',
    '写一个故事', '诗', '创意', '设计', '头脑风暴',
  ],
  research: [
    'search', 'find', 'look up', 'what is', 'who is', 'when was',
    'summarize', 'report', 'overview', 'comparison', 'review',
    'article', 'paper', 'study', 'data', 'statistics', 'trend',
    '搜索', '查找', '什么是', '总结', '报告',
  ],
  chat: [
    'hello', 'hi', 'thanks', 'thank you', 'how are you', 'help',
    'translate', 'yes', 'no', 'ok', 'sure', 'good',
    '你好', '谢谢', '帮我', '翻译',
  ],
};

interface CategoryResult {
  category: Category;
  confidence: number;
  scores: Partial<Record<Category, number>>;
}

/**
 * Detect the primary category of a request.
 * Uses provided keywords (from learned weights) or built-in defaults.
 */
export function detectCategory(
  prompt: string,
  categoryKeywords?: Record<string, string[]>,
): CategoryResult {
  const keywords = (categoryKeywords ?? DEFAULT_CATEGORY_KEYWORDS) as Record<Category, string[]>;
  const lower = prompt.toLowerCase();
  const scores: Partial<Record<Category, number>> = {};
  let maxScore = 0;
  let maxCategory: Category = 'chat'; // default fallback

  for (const [cat, kws] of Object.entries(keywords) as Array<[Category, string[]]>) {
    let score = 0;
    for (const kw of kws) {
      if (lower.includes(kw.toLowerCase())) score++;
    }
    // Bonus for code blocks (strong coding signal)
    if (cat === 'coding') {
      const codeBlocks = (prompt.match(/```/g) || []).length / 2;
      score += codeBlocks * 3;
    }
    if (score > 0) scores[cat] = score;
    if (score > maxScore) {
      maxScore = score;
      maxCategory = cat;
    }
  }

  // Confidence: how much the winner leads the runner-up
  const sortedScores = Object.values(scores).sort((a, b) => b - a);
  const gap = sortedScores.length >= 2
    ? (sortedScores[0] - sortedScores[1]) / Math.max(sortedScores[0], 1)
    : sortedScores.length === 1 ? 0.8 : 0;
  const confidence = Math.min(0.95, 0.5 + gap * 0.5);

  return { category: maxCategory, confidence, scores };
}

/**
 * Map a learned category to the legacy tier system (backward compat).
 */
export function mapCategoryToTier(category: Category): 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING' {
  switch (category) {
    case 'chat': return 'SIMPLE';
    case 'research': return 'MEDIUM';
    case 'creative': return 'MEDIUM';
    case 'coding': return 'COMPLEX';
    case 'trading': return 'COMPLEX';
    case 'reasoning': return 'REASONING';
    default: return 'MEDIUM';
  }
}
