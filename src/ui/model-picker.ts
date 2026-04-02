/**
 * Interactive model picker for 0xcode.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */

import readline from 'node:readline';
import chalk from 'chalk';

// ─── Model Shortcuts (same as proxy) ───────────────────────────────────────

export const MODEL_SHORTCUTS: Record<string, string> = {
  // Routing
  auto: 'blockrun/auto',
  smart: 'blockrun/auto',
  eco: 'blockrun/eco',
  premium: 'blockrun/premium',
  // Anthropic
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI
  gpt: 'openai/gpt-5.4',
  gpt5: 'openai/gpt-5.4',
  'gpt-5.4': 'openai/gpt-5.4',
  codex: 'openai/gpt-5.3-codex',
  nano: 'openai/gpt-5-nano',
  mini: 'openai/gpt-5-mini',
  o3: 'openai/o3',
  o4: 'openai/o4-mini',
  // Google
  gemini: 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  // xAI
  grok: 'xai/grok-3',
  // DeepSeek
  deepseek: 'deepseek/deepseek-chat',
  r1: 'deepseek/deepseek-reasoner',
  // Free
  free: 'nvidia/nemotron-ultra-253b',
  nemotron: 'nvidia/nemotron-ultra-253b',
  devstral: 'nvidia/devstral-2-123b',
  'qwen-coder': 'nvidia/qwen3-coder-480b',
  maverick: 'nvidia/llama-4-maverick',
  // Others
  minimax: 'minimax/minimax-m2.7',
  glm: 'zai/glm-5',
  kimi: 'moonshot/kimi-k2.5',
};

/**
 * Resolve a model name — supports shortcuts.
 */
export function resolveModel(input: string): string {
  const lower = input.trim().toLowerCase();
  return MODEL_SHORTCUTS[lower] || input.trim();
}

// ─── Curated Model List for Picker ─────────────────────────────────────────

interface ModelEntry {
  id: string;
  shortcut: string;
  label: string;
  price: string; // display string
}

const PICKER_MODELS: { category: string; models: ModelEntry[] }[] = [
  {
    category: 'Popular',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', shortcut: 'sonnet', label: 'Claude Sonnet 4.6', price: '$3/$15' },
      { id: 'anthropic/claude-opus-4.6', shortcut: 'opus', label: 'Claude Opus 4.6', price: '$5/$25' },
      { id: 'openai/gpt-5.4', shortcut: 'gpt', label: 'GPT-5.4', price: '$2.5/$15' },
      { id: 'google/gemini-2.5-pro', shortcut: 'gemini', label: 'Gemini 2.5 Pro', price: '$1.25/$10' },
      { id: 'deepseek/deepseek-chat', shortcut: 'deepseek', label: 'DeepSeek V3', price: '$0.28/$0.42' },
    ],
  },
  {
    category: 'Budget',
    models: [
      { id: 'google/gemini-2.5-flash', shortcut: 'flash', label: 'Gemini 2.5 Flash', price: '$0.15/$0.6' },
      { id: 'openai/gpt-5-mini', shortcut: 'mini', label: 'GPT-5 Mini', price: '$0.25/$2' },
      { id: 'anthropic/claude-haiku-4.5-20251001', shortcut: 'haiku', label: 'Claude Haiku 4.5', price: '$0.8/$4' },
      { id: 'openai/gpt-5-nano', shortcut: 'nano', label: 'GPT-5 Nano', price: '$0.05/$0.4' },
    ],
  },
  {
    category: 'Reasoning',
    models: [
      { id: 'deepseek/deepseek-reasoner', shortcut: 'r1', label: 'DeepSeek R1', price: '$0.28/$0.42' },
      { id: 'openai/o4-mini', shortcut: 'o4', label: 'O4 Mini', price: '$1.1/$4.4' },
      { id: 'openai/o3', shortcut: 'o3', label: 'O3', price: '$2/$8' },
    ],
  },
  {
    category: 'Free (no USDC needed)',
    models: [
      { id: 'nvidia/nemotron-ultra-253b', shortcut: 'free', label: 'Nemotron Ultra 253B', price: 'FREE' },
      { id: 'nvidia/qwen3-coder-480b', shortcut: 'qwen-coder', label: 'Qwen3 Coder 480B', price: 'FREE' },
      { id: 'nvidia/devstral-2-123b', shortcut: 'devstral', label: 'Devstral 2 123B', price: 'FREE' },
      { id: 'nvidia/llama-4-maverick', shortcut: 'maverick', label: 'Llama 4 Maverick', price: 'FREE' },
    ],
  },
];

/**
 * Show interactive model picker. Returns the selected model ID.
 * Falls back to text input if terminal doesn't support raw mode.
 */
export async function pickModel(currentModel?: string): Promise<string | null> {
  // Flatten for numbering
  const allModels: ModelEntry[] = [];
  for (const cat of PICKER_MODELS) {
    allModels.push(...cat.models);
  }

  // Display
  console.error('');
  console.error(chalk.bold('  Select a model:\n'));

  let idx = 1;
  for (const cat of PICKER_MODELS) {
    console.error(chalk.dim(`  ── ${cat.category} ──`));
    for (const m of cat.models) {
      const current = m.id === currentModel ? chalk.green(' ←') : '';
      const priceStr = m.price === 'FREE' ? chalk.green(m.price) : chalk.dim(m.price);
      console.error(
        `  ${chalk.cyan(String(idx).padStart(2))}. ${m.label.padEnd(24)} ${chalk.dim(m.shortcut.padEnd(12))} ${priceStr}${current}`
      );
      idx++;
    }
    console.error('');
  }

  console.error(chalk.dim('  Enter number, shortcut, or full model ID:'));

  // Read input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  return new Promise<string | null>((resolve) => {
    let answered = false;
    rl.question(chalk.bold('  model> '), (answer) => {
      answered = true;
      rl.close();
      const trimmed = answer.trim();

      if (!trimmed) {
        resolve(null); // Keep current
        return;
      }

      // Try number
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= allModels.length) {
        resolve(allModels[num - 1].id);
        return;
      }

      // Try shortcut or full ID
      resolve(resolveModel(trimmed));
    });

    rl.on('close', () => {
      if (!answered) resolve(null);
    });
  });
}
