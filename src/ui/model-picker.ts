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
  // Anthropic — `sonnet`/`claude` follow the newest Sonnet (5); `fable` is the
  // Mythos-class tier above Opus.
  fable: 'anthropic/claude-fable-5',
  'fable-5': 'anthropic/claude-fable-5',
  sonnet: 'anthropic/claude-sonnet-5',
  claude: 'anthropic/claude-sonnet-5',
  'sonnet-5': 'anthropic/claude-sonnet-5',
  'sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  'sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  opus: 'anthropic/claude-opus-4.8',
  'opus-4.8': 'anthropic/claude-opus-4.8',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  'opus-4.5': 'anthropic/claude-opus-4.5',
  haiku: 'anthropic/claude-haiku-4.5-20251001',
  'haiku-4.5': 'anthropic/claude-haiku-4.5-20251001',
  // OpenAI
  // `gpt` / `gpt5` / `gpt-5` follow the gateway's flagship — currently 5.6 Sol.
  gpt: 'openai/gpt-5.6-sol',
  gpt5: 'openai/gpt-5.6-sol',
  'gpt-5': 'openai/gpt-5.6-sol',
  'gpt-5.6': 'openai/gpt-5.6-sol',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.4-nano': 'openai/gpt-5.4-nano',
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
  flash: 'google/gemini-3.5-flash',
  'gemini-flash': 'google/gemini-3.5-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  'gemini-3': 'google/gemini-3.1-pro',
  'gemini-3.1': 'google/gemini-3.1-pro',
  // xAI — grok-4.3 is the public flagship since 2026-06-04 (grok-3 and the
  // fast families are hidden on the gateway; explicit IDs still resolve).
  grok: 'xai/grok-4.3',
  'grok-4.3': 'xai/grok-4.3',
  'grok-build': 'xai/grok-build-0.1',
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
  // The free nvidia/deepseek-v4-flash SKU was EOL'd by the gateway (410).
  // Point the deepseek-free aliases at the current free default so muscle
  // memory keeps working without handing back a dead id.
  'deepseek-v4': 'nvidia/qwen3-next-80b-a3b-instruct',
  'deepseek-v4-flash': 'nvidia/qwen3-next-80b-a3b-instruct',
  dsv4: 'nvidia/qwen3-next-80b-a3b-instruct',
  'deepseek-v3.2': 'nvidia/qwen3-next-80b-a3b-instruct',
  'deepseek-v3': 'nvidia/qwen3-next-80b-a3b-instruct',
  // Free (agent-tested BlockRun gateway free tier — refreshed 2026-07-11).
  // `free` follows the current free default (qwen3-next-instruct: cleanest
  // free instruction-follower). NOTE: every free alias resolves to a $0 nvidia
  // model — the free tier NEVER falls back to a paid model.
  free: 'nvidia/qwen3-next-80b-a3b-instruct',
  qwen: 'nvidia/qwen3-next-80b-a3b-instruct',
  qwen3: 'nvidia/qwen3-next-80b-a3b-instruct',
  'qwen3-next': 'nvidia/qwen3-next-80b-a3b-instruct',
  'qwen3.5': 'nvidia/qwen3.5-122b-a10b',
  maverick: 'nvidia/llama-4-maverick',
  glm4: 'nvidia/qwen3-next-80b-a3b-instruct',
  'deepseek-free': 'nvidia/qwen3-next-80b-a3b-instruct',
  'qwen-coder': 'nvidia/qwen3-next-80b-a3b-instruct',
  'qwen-think': 'nvidia/qwen3-next-80b-a3b-instruct',
  'gpt-oss': 'nvidia/qwen3-next-80b-a3b-instruct',
  'gpt-oss-small': 'nvidia/qwen3-next-80b-a3b-instruct',
  'mistral-small': 'nvidia/qwen3-next-80b-a3b-instruct',
  'mistral-nemotron': 'nvidia/mistral-nemotron',
  // llama shortcuts point at the still-live free maverick model (not the free
  // default — that's qwen3-next above). Kept as explicit aliases so the name
  // resolves for users who type it.
  llama: 'nvidia/llama-4-maverick',
  'llama-4': 'nvidia/llama-4-maverick',
  'llama-4-maverick': 'nvidia/llama-4-maverick',
  // Backward-compatibility aliases for models the gateway retired or exposes
  // unreliably on /v1/messages. Map to agent-tested free models so shortcuts
  // keep working without silent paid fallback or empty tool-use turns.
  // Map to the closest current free model so old session records + user
  // muscle memory keep working.
  nemotron: 'nvidia/llama-4-maverick',
  devstral: 'nvidia/llama-4-maverick',
  // Others
  minimax: 'minimax/minimax-m3',
  'm3': 'minimax/minimax-m3',
  'm2.7': 'minimax/minimax-m2.7',
  glm: 'zai/glm-5.2',
  'glm-5': 'zai/glm-5',
  'glm-5.2': 'zai/glm-5.2',
  // GLM-5.1 demoted to a back-compat pin 2026-06 (flagship is 5.2) — still
  // routes for anyone who wants the 200K-context build explicitly.
  'glm-5.1': 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5-turbo',
  'glm5': 'zai/glm-5.2',
  kimi: 'moonshot/kimi-k2.7',
  'k2.7': 'moonshot/kimi-k2.7',
  // K2.6 demoted 2026-06 (gateway flagship is K2.7) but still routes — the
  // `k2.6` pin keeps working for anyone who wants it explicitly.
  'k2.6': 'moonshot/kimi-k2.6',
  // K2.5 was retired by the gateway. Aliases stay so muscle memory keeps
  // working but resolve to the current Kimi flagship (K2.7).
  'kimi-k2.5': 'moonshot/kimi-k2.7',
  'k2.5': 'moonshot/kimi-k2.7',
};

/**
 * Resolve a model name — supports shortcuts. Returns the canonical model id.
 *
 * If the input matches a shortcut, the shortcut's target is returned. If the
 * input is already a fully-qualified `provider/model` id (contains a `/`), it
 * is returned verbatim so the gateway can validate it. Bare, unknown aliases
 * (e.g. `llama3`, `foo`) resolve to themselves too, but the gateway will
 * reject them — callers that care about a clean error should branch on
 * {@link resolveModelStrict} instead.
 */
export function resolveModel(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  return MODEL_SHORTCUTS[lower] || trimmed;
}

/**
 * Strict variant of {@link resolveModel} — used by the `/model` handler so
 * an unknown bare alias surfaces a clean error in the UI instead of
 * forwarding `llama` to the gateway and getting back `HTTP 400: Unknown
 * model: llama` two turns later.
 *
 * Recognised:
 *   - Any entry in {@link MODEL_SHORTCUTS} (case-insensitive).
 *   - Any id of the form `provider/model` (e.g. `anthropic/claude-sonnet-4.6`).
 */
export function resolveModelStrict(
  input: string,
): { ok: true; id: string; viaShortcut: boolean } | { ok: false; suggestion: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, suggestion: 'Empty model name. Try /model sonnet or /model free.' };
  }
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_SHORTCUTS, lower)) {
    return { ok: true, id: MODEL_SHORTCUTS[lower]!, viaShortcut: true };
  }
  if (trimmed.includes('/')) {
    return { ok: true, id: trimmed, viaShortcut: false };
  }
  const known = Object.keys(MODEL_SHORTCUTS).sort();
  const head = known.slice(0, 6).join(', ');
  return {
    ok: false,
    suggestion:
      `Unknown model alias: "${trimmed}". Use a shortcut like ${head}, ` +
      `or a full id like anthropic/claude-sonnet-4.6.`,
  };
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
    category: '🧠 Smart routing (auto-pick)',
    models: [
      // Auto is the only routing profile surfaced in the picker. Eco and
      // Premium are kept as shortcut aliases (`eco`, `premium`) and resolve
      // through the router for back-compat with older configs/sessions, but
      // they're hidden from new users — Auto already covers the cheap end
      // (V4 Pro at $0.435/$0.87 for SIMPLE/MEDIUM) and the quality end (Opus
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
      { id: 'anthropic/claude-fable-5',    shortcut: 'fable',     label: 'Claude Fable 5',    price: '$10/$50' },
      { id: 'anthropic/claude-opus-4.8',   shortcut: 'opus',      label: 'Claude Opus 4.8',   price: '$5/$25', highlight: true },
      { id: 'anthropic/claude-sonnet-5',   shortcut: 'sonnet',    label: 'Claude Sonnet 5',   price: '$3/$15' },
      { id: 'openai/gpt-5.6-sol',          shortcut: 'gpt',       label: 'GPT-5.6 Sol',       price: '$5/$30', highlight: true },
      { id: 'google/gemini-3.1-pro',       shortcut: 'gemini-3',  label: 'Gemini 3.1 Pro',    price: '$2/$12' },
      { id: 'google/gemini-2.5-pro',       shortcut: 'gemini',    label: 'Gemini 2.5 Pro',    price: '$1.25/$10' },
      { id: 'xai/grok-4.3',                shortcut: 'grok',      label: 'Grok 4.3',          price: '$1.5/$4' },
    ],
  },
  {
    category: '🔬 Reasoning',
    models: [
      { id: 'openai/o3',                     shortcut: 'o3',           label: 'O3',                    price: '$2/$8' },
      { id: 'openai/gpt-5.3-codex',          shortcut: 'codex',        label: 'GPT-5.3 Codex',         price: '$1.75/$14' },
      // V4 Pro: the 75% launch promo became DeepSeek's permanent list price
      // after 2026-05-31. 1M context, 1.6T MoE → punches up to GPT-5.5/Opus
      // on hard tasks at <1/10 the price.
      { id: 'deepseek/deepseek-v4-pro',      shortcut: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro',    price: '$0.435/$0.87', highlight: true },
      { id: 'deepseek/deepseek-reasoner',    shortcut: 'r1',           label: 'DeepSeek V4 Flash R.',  price: '$0.2/$0.4' },
      { id: 'xai/grok-4-1-fast-reasoning',   shortcut: 'grok-fast',    label: 'Grok 4.1 Fast R.',      price: '$0.2/$0.5' },
      // GLM-5.2: Z.AI's new flagship — 1M context, top open-source on
      // long-horizon coding. `glm`/`glm5` shortcuts pin it.
      { id: 'zai/glm-5.2',                   shortcut: 'glm',          label: 'GLM-5.2',               price: '$1.4/$4.4' },
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
      { id: 'moonshot/kimi-k2.7',                  shortcut: 'kimi',     label: 'Kimi K2.7',           price: '$0.95/$4' },
      // GLM flat-rate promos fully ended 2026-06-06 — whole family per-token
      // now (glm-5 $0.60/$1.92; `glm` shortcut pins flagship glm-5.2, listed
      // in Reasoning above).
      { id: 'zai/glm-5',                           shortcut: 'glm-5',    label: 'GLM-5',               price: '$0.6/$1.92' },
      // Minimax M2.7 hidden to make room for V4 Pro in Reasoning + V4 Flash
      // (free) without exceeding the picker's 24-entry cap. Shortcut `minimax`
      // still resolves to it.
    ],
  },
  {
    category: '🆓 Free (no USDC needed)',
    models: [
      // Qwen3-Next 80B leads: cleanest free instruction-follower (no thinking
      // leak / markdown fences — verified live 2026-07-11) and the default the
      // `free` shortcut + free routing profile resolve to. Llama 4 Maverick is
      // the diverse-family secondary. (nvidia/deepseek-v4-flash removed
      // 2026-07-11: the gateway 410s on it.) Both are $0 — the free tier never
      // falls back to a paid model.
      { id: 'nvidia/qwen3-next-80b-a3b-instruct', shortcut: 'free',     label: 'Qwen3-Next 80B',   price: 'FREE', highlight: true },
      { id: 'nvidia/llama-4-maverick',            shortcut: 'maverick', label: 'Llama 4 Maverick', price: 'FREE' },
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
