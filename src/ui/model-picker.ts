/**
 * Interactive model picker for Franklin.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */

import readline from 'node:readline';
import chalk from 'chalk';

// ─── Model Shortcuts (same as proxy) ───────────────────────────────────────

export const MODEL_SHORTCUTS: Record<string, string> = {
  // Routing profiles — Auto is the only profile surfaced in the picker.
  // `eco` / `premium` were retired 2026-05-03 (V4 Pro launch made Auto cheap
  // enough that separate profiles for "cheap" and "best" were redundant).
  // The shortcuts still resolve through parseRoutingProfile() for back-compat
  // with old configs/sessions, which silently promotes them to Auto.
  auto: 'blockrun/auto',
  smart: 'blockrun/auto',
  eco: 'blockrun/auto',
  premium: 'blockrun/auto',
  // Anthropic
  sonnet: 'anthropic/claude-sonnet-4.6',
  claude: 'anthropic/claude-sonnet-4.6',
  'sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  opus: 'anthropic/claude-opus-4.7',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  'haiku-4.5': 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI
  // `gpt` / `gpt5` / `gpt-5` follow the gateway's flagship — currently 5.5.
  gpt: 'openai/gpt-5.5',
  gpt5: 'openai/gpt-5.5',
  'gpt-5': 'openai/gpt-5.5',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.3': 'openai/gpt-5.3',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-pro': 'openai/gpt-5.2-pro',
  'gpt-4.1': 'openai/gpt-4.1',
  codex: 'openai/gpt-5.3-codex',
  nano: 'openai/gpt-5-nano',
  mini: 'openai/gpt-5-mini',
  o3: 'openai/o3',
  o4: 'openai/o4-mini',
  'o4-mini': 'openai/o4-mini',
  o1: 'openai/o1',
  // Google
  gemini: 'google/gemini-2.5-pro',
  'gemini-2.5': 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  'gemini-3': 'google/gemini-3.1-pro',
  'gemini-3.1': 'google/gemini-3.1-pro',
  // xAI
  grok: 'xai/grok-3',
  'grok-3': 'xai/grok-3',
  'grok-4': 'xai/grok-4-0709',
  'grok-fast': 'xai/grok-4-1-fast-reasoning',
  'grok-4.1': 'xai/grok-4-1-fast-reasoning',
  // DeepSeek — paid SKUs route through deepseek/* (gateway aliases serve V4
  // Flash modes upstream); free tier routes through nvidia/*.
  deepseek: 'deepseek/deepseek-chat',     // V4 Flash Chat (paid, $0.20/$0.40)
  r1: 'deepseek/deepseek-reasoner',       // V4 Flash Reasoner (paid)
  // V4 Pro: paid flagship, 1.6T MoE / 49B active, 1M ctx, 75% launch promo.
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'dsv4-pro': 'deepseek/deepseek-v4-pro',
  'v4-pro': 'deepseek/deepseek-v4-pro',
  // V4 Flash: free on NVIDIA inference. Bare `deepseek-v4` resolves here
  // since the paid V4 Flash SKU was dropped (overlapped with this free one).
  'deepseek-v4': 'nvidia/deepseek-v4-flash',
  'deepseek-v4-flash': 'nvidia/deepseek-v4-flash',
  dsv4: 'nvidia/deepseek-v4-flash',
  // V3.2 free fallback for users who specifically want the older Terminus
  // checkpoint instead of the V4 Flash default.
  'deepseek-v3.2': 'nvidia/deepseek-v3.2',
  'deepseek-v3': 'nvidia/deepseek-v3.2',
  // Free (agent-tested BlockRun gateway free tier — refreshed 2026-04)
  free: 'nvidia/qwen3-coder-480b',
  glm4: 'nvidia/qwen3-coder-480b',
  'deepseek-free': 'nvidia/qwen3-coder-480b',
  'qwen-coder': 'nvidia/qwen3-coder-480b',
  'qwen-think': 'nvidia/qwen3-coder-480b',
  maverick: 'nvidia/llama-4-maverick',
  'gpt-oss': 'nvidia/qwen3-coder-480b',
  'gpt-oss-small': 'nvidia/qwen3-coder-480b',
  'mistral-small': 'nvidia/llama-4-maverick',
  // Backward-compatibility aliases for models the gateway retired or exposes
  // unreliably on /v1/messages. Map to agent-tested free models so shortcuts
  // keep working without silent paid fallback or empty tool-use turns.
  // Map to the closest current free model so old session records + user
  // muscle memory keep working.
  nemotron: 'nvidia/qwen3-coder-480b',
  devstral: 'nvidia/qwen3-coder-480b',
  // Others
  minimax: 'minimax/minimax-m2.7',
  'm2.7': 'minimax/minimax-m2.7',
  glm: 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5-turbo',
  'glm5': 'zai/glm-5.1',
  kimi: 'moonshot/kimi-k2.6',
  'k2.6': 'moonshot/kimi-k2.6',
  // K2.5 was retired by the gateway in favor of K2.6 (256K ctx, vision +
  // reasoning, $0.95 in / $4 out — strictly better in every dimension).
  // The aliases stay so muscle memory keeps working but resolve to K2.6.
  'kimi-k2.5': 'moonshot/kimi-k2.6',
  'k2.5': 'moonshot/kimi-k2.6',
};

/**
 * Resolve a model name — supports shortcuts.
 */
export function resolveModel(input: string): string {
  const lower = input.trim().toLowerCase();
  return MODEL_SHORTCUTS[lower] || input.trim();
}

// ─── Curated Model List for Picker ─────────────────────────────────────────

export interface ModelEntry {
  id: string;
  shortcut: string;
  label: string;
  price: string;       // display string
  highlight?: boolean; // gold-tinted promo row
}

export interface ModelCategory {
  category: string;
  models: ModelEntry[];
}

/**
 * Single source of truth for the /model picker.
 * ~30 models across 6 categories. Every ID here is present in src/pricing.ts
 * and every shortcut is in MODEL_SHORTCUTS above.
 *
 * Both the Ink UI picker (src/ui/app.tsx) and the readline picker
 * (pickModel() below) import from this array. To add or remove models,
 * edit this one place.
 */
export const PICKER_CATEGORIES: ModelCategory[] = [
  {
    category: '🔥 Promo (flat $0.001/call)',
    models: [
      { id: 'zai/glm-5.1',       shortcut: 'glm',       label: 'GLM-5.1',       price: '$0.001/call', highlight: true },
      { id: 'zai/glm-5-turbo', shortcut: 'glm-turbo', label: 'GLM-5 Turbo', price: '$0.001/call', highlight: true },
    ],
  },
  {
    category: '🧠 Smart routing (auto-pick)',
    models: [
      // Auto is the only routing profile surfaced in the picker. Eco and
      // Premium are kept as shortcut aliases (`eco`, `premium`) and resolve
      // through the router for back-compat with older configs/sessions, but
      // they're hidden from new users — Auto already covers the cheap end
      // (V4 Pro at $0.50/$1.00 for SIMPLE/MEDIUM) and the quality end (Opus
      // for COMPLEX), so a separate Eco/Premium picker entry just adds
      // choice paralysis without distinct value.
      { id: 'blockrun/auto', shortcut: 'auto', label: 'Auto', price: 'routed' },
    ],
  },
  {
    // Picker trim (v3.9.3): hide superseded / awkward-middle / niche-premium
    // entries to bring choice paralysis down. Their shortcuts (`opus-4.6`,
    // `gpt-5.4`, `gpt-5.4-pro`, `grok`, `o1`, `o4`, `nano`) all stay live in
    // MODEL_SHORTCUTS, so muscle memory keeps working — they just aren't
    // listed in the visible picker. Same pattern v3.9.0 used to retire dead
    // free-tier entries and v3.9.2 used to retire Kimi K2.5.
    category: '✨ Premium frontier',
    models: [
      { id: 'anthropic/claude-opus-4.7',   shortcut: 'opus',      label: 'Claude Opus 4.7',   price: '$5/$25', highlight: true },
      { id: 'anthropic/claude-sonnet-4.6', shortcut: 'sonnet',    label: 'Claude Sonnet 4.6', price: '$3/$15' },
      { id: 'openai/gpt-5.5',              shortcut: 'gpt',       label: 'GPT-5.5',           price: '$5/$30', highlight: true },
      { id: 'google/gemini-3.1-pro',       shortcut: 'gemini-3',  label: 'Gemini 3.1 Pro',    price: '$2/$12' },
      { id: 'google/gemini-2.5-pro',       shortcut: 'gemini',    label: 'Gemini 2.5 Pro',    price: '$1.25/$10' },
      { id: 'xai/grok-4-0709',             shortcut: 'grok-4',    label: 'Grok 4',            price: '$0.2/$1.5' },
    ],
  },
  {
    category: '🔬 Reasoning',
    models: [
      { id: 'openai/o3',                     shortcut: 'o3',           label: 'O3',                    price: '$2/$8' },
      { id: 'openai/gpt-5.3-codex',          shortcut: 'codex',        label: 'GPT-5.3 Codex',         price: '$1.75/$14' },
      // V4 Pro on launch promo (75% off through 2026-05-31). 1M context,
      // 1.6T MoE → punches up to GPT-5.5/Opus on hard tasks at <1/10 the price.
      { id: 'deepseek/deepseek-v4-pro',      shortcut: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro',    price: '$0.5/$1 (promo)', highlight: true },
      { id: 'deepseek/deepseek-reasoner',    shortcut: 'r1',           label: 'DeepSeek V4 Flash R.',  price: '$0.2/$0.4' },
      { id: 'xai/grok-4-1-fast-reasoning',   shortcut: 'grok-fast',    label: 'Grok 4.1 Fast R.',      price: '$0.2/$0.5' },
    ],
  },
  {
    category: '💰 Budget',
    models: [
      { id: 'anthropic/claude-haiku-4.5-20251001', shortcut: 'haiku',    label: 'Claude Haiku 4.5',    price: '$1/$5' },
      { id: 'openai/gpt-5-mini',                   shortcut: 'mini',     label: 'GPT-5 Mini',          price: '$0.25/$2' },
      { id: 'google/gemini-2.5-flash',             shortcut: 'flash',    label: 'Gemini 2.5 Flash',    price: '$0.3/$2.5' },
      // Re-aliased to V4 Flash Chat upstream — context 1M, price 30% lower.
      { id: 'deepseek/deepseek-chat',              shortcut: 'deepseek', label: 'DeepSeek V4 Flash Chat', price: '$0.2/$0.4' },
      { id: 'moonshot/kimi-k2.6',                  shortcut: 'kimi',     label: 'Kimi K2.6',           price: '$0.95/$4' },
      // Minimax M2.7 hidden to make room for V4 Pro in Reasoning + V4 Flash
      // (free) without exceeding the picker's 24-entry cap. Shortcut `minimax`
      // still resolves to it.
    ],
  },
  {
    category: '🆓 Free (no USDC needed)',
    models: [
      // V4 Flash leads the section: newest gateway addition, general-purpose,
      // fast — better default for most users than the coder-specialized Qwen.
      // V3.2 hidden (shortcut `deepseek-v3` still works) since V4 Flash
      // supersedes it; keeping the picker tight.
      { id: 'nvidia/deepseek-v4-flash', shortcut: 'deepseek-v4', label: 'DeepSeek V4 Flash', price: 'FREE', highlight: true },
      { id: 'nvidia/qwen3-coder-480b',  shortcut: 'free',        label: 'Qwen3 Coder 480B', price: 'FREE' },
      { id: 'nvidia/llama-4-maverick',  shortcut: 'maverick',    label: 'Llama 4 Maverick', price: 'FREE' },
    ],
  },
];

/** Flat list of all picker models (for index-based navigation). */
export const PICKER_MODELS_FLAT: ModelEntry[] = PICKER_CATEGORIES.flatMap(c => c.models);

// Kept for backward compatibility with the readline pickModel() below.
const PICKER_MODELS = PICKER_CATEGORIES;

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
