/**
 * Interactive model picker for Franklin.
 * Shows categorized model list, supports shortcuts and arrow-key selection.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import { getGatewayModels, type GatewayModel } from '../gateway-models.js';

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
  // Anthropic — `claude` follows Opus; `fable` is the Mythos-class tier above it.
  fable: 'anthropic/claude-fable-5',
  'fable-5': 'anthropic/claude-fable-5',
  sonnet: 'anthropic/claude-sonnet-5',
  claude: 'anthropic/claude-opus-5',
  'sonnet-5': 'anthropic/claude-sonnet-5',
  'sonnet-4.6': 'anthropic/claude-sonnet-4.6',
  'sonnet-4.5': 'anthropic/claude-sonnet-4.5',
  opus: 'anthropic/claude-opus-5',
  'opus-5': 'anthropic/claude-opus-5',
  'opus-4.8': 'anthropic/claude-opus-4.8',
  'opus-4.7': 'anthropic/claude-opus-4.7',
  'opus-4.6': 'anthropic/claude-opus-4.6',
  'opus-4.5': 'anthropic/claude-opus-4.5',
  haiku: 'anthropic/claude-haiku-4.5',
  'haiku-4.5': 'anthropic/claude-haiku-4.5',
  // OpenAI
  // `gpt` / `gpt5` / `gpt-5` follow the gateway's flagship — currently 5.6 Sol.
  gpt: 'openai/gpt-5.6-sol',
  gpt5: 'openai/gpt-5.6-sol',
  'gpt-5': 'openai/gpt-5.6-sol',
  'gpt-5.6': 'openai/gpt-5.6-sol',
  'gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  // GPT-5.6 pro reasoning tier (gateway, 2026-08). Same base models with pro
  // reasoning mode on: Sol Pro matches Sol at $5/$30, while Terra Pro ($1/$6)
  // and Luna Pro ($0.1/$0.6) come in UNDER their own base tiers — so the pro
  // ids are the better pick for anything reasoning-shaped. `gpt` stays pinned
  // to Sol: bare aliases track the gateway's flagship, not the cheapest
  // sibling.
  'gpt-5.6-sol-pro': 'openai/gpt-5.6-sol-pro',
  'sol-pro': 'openai/gpt-5.6-sol-pro',
  'gpt-5.6-terra-pro': 'openai/gpt-5.6-terra-pro',
  'terra-pro': 'openai/gpt-5.6-terra-pro',
  'gpt-5.6-luna-pro': 'openai/gpt-5.6-luna-pro',
  'luna-pro': 'openai/gpt-5.6-luna-pro',
  'gpt-5.5': 'openai/gpt-5.5',
  'gpt-5.5-pro': 'openai/gpt-5.5-pro',
  // The rolling `chat-latest` alias — whatever ChatGPT currently serves as its
  // default (GPT-5.5 Instant today), tuned for speed and concision. Priced
  // like GPT-5.5 but capped at 128K context.
  'chat-latest': 'openai/chat-latest',
  chatgpt: 'openai/chat-latest',
  instant: 'openai/chat-latest',
  'gpt-5.4': 'openai/gpt-5.4',
  'gpt-5.4-pro': 'openai/gpt-5.4-pro',
  'gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'gpt-5.3': 'openai/gpt-5.3',
  'gpt-5.2': 'openai/gpt-5.2',
  'gpt-5.2-pro': 'openai/gpt-5.2-pro',
  'gpt-4.1': 'openai/gpt-4.1',
  'gpt-4.1-mini': 'openai/gpt-4.1-mini',
  'gpt-4.1-nano': 'openai/gpt-4.1-nano',
  '4o': 'openai/gpt-4o',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  codex: 'openai/gpt-5.3-codex',
  nano: 'openai/gpt-5-nano',
  mini: 'openai/gpt-5-mini',
  o3: 'openai/o3',
  'o3-mini': 'openai/o3-mini',
  o4: 'openai/o4-mini',
  'o4-mini': 'openai/o4-mini',
  o1: 'openai/o1',
  // Google
  // `gemini` follows the flagship Pro build (3.1 since 2026-08), matching the
  // bare-alias-tracks-flagship rule `gpt`, `grok` and `glm` already use. 2.5
  // Pro stays reachable as `gemini-2.5` — it is cheaper on input but a
  // generation behind.
  gemini: 'google/gemini-3.1-pro',
  'gemini-2.5': 'google/gemini-2.5-pro',
  'gemini-2.5-pro': 'google/gemini-2.5-pro',
  // `flash` follows the newest Flash generation (3.6 since 2026-08). 3.5 stays
  // reachable by its explicit id — it is dearer on output ($9 vs $7.5) with no
  // capability edge, so nothing should be pinned to it deliberately.
  flash: 'google/gemini-3.6-flash',
  'gemini-flash': 'google/gemini-3.6-flash',
  'gemini-3.6': 'google/gemini-3.6-flash',
  'gemini-3.6-flash': 'google/gemini-3.6-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
  'gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  // Flash Lite — thinking-mode Gemini for high-throughput work. `flash-lite`
  // follows the newest (3.5); 3.1 is cheaper still and stays explicit.
  'flash-lite': 'google/gemini-3.5-flash-lite',
  'gemini-3.5-flash-lite': 'google/gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite': 'google/gemini-2.5-flash-lite',
  'gemini-3': 'google/gemini-3.1-pro',
  'gemini-3.1': 'google/gemini-3.1-pro',
  // xAI — grok-4.5 is the public flagship since 2026-07-14; `grok` follows it
  // per the bare-alias-tracks-flagship convention. 4.3 stays pinned: it's
  // cheaper ($1.5/$4 vs $2.5/$9) and carries 1M context to 4.5's 500K, so it's
  // the better pick for long-context work. (grok-3 and the fast families are
  // hidden on the gateway; explicit IDs still resolve.)
  grok: 'xai/grok-4.5',
  'grok-4.5': 'xai/grok-4.5',
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
  'deepseek-v4': 'nvidia/nemotron-nano-9b-v2',
  'deepseek-v4-flash': 'nvidia/nemotron-nano-9b-v2',
  dsv4: 'nvidia/nemotron-nano-9b-v2',
  'deepseek-v3.2': 'nvidia/nemotron-nano-9b-v2',
  'deepseek-v3': 'nvidia/nemotron-nano-9b-v2',
  // Free (agent-tested BlockRun gateway free tier — refreshed 2026-08-12 after
  // qwen3-next-80b-a3b-instruct hit NVIDIA's EOL, 410). `free` follows the
  // current free default (nemotron-nano-9b-v2: the one free model that
  // verifiably serves itself on the streaming path — mistral-nemotron is
  // DEGRADED upstream and 400s on stream). The qwen3-next / qwen3.5 aliases
  // follow the retired-free-id pattern and resolve here too. NOTE: every free
  // alias resolves to a $0 nvidia model — the free tier NEVER falls back to a
  // paid model.
  free: 'nvidia/nemotron-nano-9b-v2',
  qwen: 'nvidia/nemotron-nano-9b-v2',
  qwen3: 'nvidia/nemotron-nano-9b-v2',
  'qwen3-next': 'nvidia/nemotron-nano-9b-v2',
  'qwen3.5': 'nvidia/nemotron-nano-9b-v2',
  glm4: 'nvidia/nemotron-nano-9b-v2',
  'deepseek-free': 'nvidia/nemotron-nano-9b-v2',
  'qwen-coder': 'nvidia/nemotron-nano-9b-v2',
  'qwen-think': 'nvidia/nemotron-nano-9b-v2',
  'gpt-oss': 'nvidia/nemotron-nano-9b-v2',
  'gpt-oss-small': 'nvidia/nemotron-nano-9b-v2',
  'mistral-small': 'nvidia/mistral-nemotron',
  'mistral-nemotron': 'nvidia/mistral-nemotron',
  // Verified-self-serving free secondaries (2026-08-12): the nano line answers
  // as itself on live probes, unlike the pooled 30B omni model.
  'nano-9b': 'nvidia/nemotron-nano-9b-v2',
  'nano-vl': 'nvidia/nemotron-nano-12b-v2-vl',
  'free-vision': 'nvidia/nemotron-nano-12b-v2-vl',
  // Nemotron 3 Nano Omni started answering as ITSELF (re-probed 2026-08-19,
  // stream and non-stream) — it was pooled behind gpt-oss-120b when it was
  // last checked, which is why it had no alias until now. 31B/3.2B MoE,
  // text + image + video + audio in, 256K context.
  omni: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'free-omni': 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nano-omni': 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  // Deliberately NOT aliased: nvidia/step-3.7-flash. It is in the catalog and
  // billed at $0, but live probes (2026-08-19) come back served by
  // nvidia/nemotron-3-super-120b — pointing users at it would promise a model
  // they don't get. Same rule that retired the maverick and qwen3-next ids.
  // Maverick left the gateway catalog on/before 2026-07-14. The id still
  // answers, but only because the free pool silently substitutes another model
  // for it — so pointing users at it would be promising a model they don't get.
  // Follow the established retired-free-id pattern instead: resolve to the
  // current free default so muscle memory keeps working.
  llama: 'nvidia/nemotron-nano-9b-v2',
  'llama-4': 'nvidia/nemotron-nano-9b-v2',
  'llama-4-maverick': 'nvidia/nemotron-nano-9b-v2',
  maverick: 'nvidia/nemotron-nano-9b-v2',
  // Backward-compatibility aliases for models the gateway retired or exposes
  // unreliably on /v1/messages. Map to agent-tested free models so shortcuts
  // keep working without silent paid fallback or empty tool-use turns.
  // Map to the closest current free model so old session records + user
  // muscle memory keep working.
  // `nemotron` resolves to the real Mistral Nemotron (in-catalog; currently
  // DEGRADED upstream, non-stream calls ride a disclosed gateway fallback).
  nemotron: 'nvidia/mistral-nemotron',
  devstral: 'nvidia/nemotron-nano-9b-v2',
  // Others
  minimax: 'minimax/minimax-m3',
  'm3': 'minimax/minimax-m3',
  'm2.7': 'minimax/minimax-m2.7',
  // Qwen (paid). NOTE: bare `qwen` stays pinned to the FREE nvidia default
  // above — never repoint a free alias at a paid model.
  'qwen-max': 'qwen/qwen3.7-max',
  'qwen3.7-max': 'qwen/qwen3.7-max',
  'qwen-3.7-max': 'qwen/qwen3.7-max',
  // Plus and Flash round out the paid Qwen line — both 1M context with
  // reasoning. Flash at $0.03/$0.13 is the cheapest paid model on the gateway.
  'qwen-plus': 'qwen/qwen3.7-plus',
  'qwen3.7-plus': 'qwen/qwen3.7-plus',
  'qwen-flash': 'qwen/qwen3.7-flash',
  'qwen3.7-flash': 'qwen/qwen3.7-flash',
  // GLM-5.3 (2026-08) is Z.AI's flagship — same $1.4/$4.4 as 5.2 with 1M
  // context and always-on reasoning, so `glm` follows it. 5.2 stays pinned.
  glm: 'zai/glm-5.3',
  'glm-5': 'zai/glm-5',
  'glm-5.3': 'zai/glm-5.3',
  'glm-5.2': 'zai/glm-5.2',
  // GLM-5.1 demoted to a back-compat pin 2026-06 (flagship is 5.2) — still
  // routes for anyone who wants the 200K-context build explicitly.
  'glm-5.1': 'zai/glm-5.1',
  'glm-turbo': 'zai/glm-5-turbo',
  'glm5': 'zai/glm-5.3',
  // Tencent + Xiaomi joined the gateway in 2026-08 — cheap reasoning at long
  // context, below the frontier tier.
  hy3: 'tencent/hy3',
  tencent: 'tencent/hy3',
  mimo: 'xiaomi/mimo-v2.5-pro',
  'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro',
  xiaomi: 'xiaomi/mimo-v2.5-pro',
  kimi: 'moonshot/kimi-k3',
  k3: 'moonshot/kimi-k3',
  // The K2.x line was retired by the gateway (2026-07, replaced by K3).
  // These pins stay so muscle memory keeps working but resolve to the
  // current Kimi flagship (K3).
  'k2.7': 'moonshot/kimi-k3',
  'k2.6': 'moonshot/kimi-k3',
  'kimi-k2.5': 'moonshot/kimi-k3',
  'k2.5': 'moonshot/kimi-k3',
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

const PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'zai',
  'moonshot',
  'minimax',
  'qwen',
  'deepseek',
  'tencent',
  'xiaomi',
  'nvidia',
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic / Claude',
  openai: 'OpenAI / GPT',
  google: 'Google / Gemini',
  xai: 'xAI / Grok',
  zai: 'Z.AI / GLM',
  moonshot: 'Moonshot / Kimi',
  minimax: 'MiniMax',
  qwen: 'Qwen / Alibaba',
  deepseek: 'DeepSeek',
  tencent: 'Tencent / Hunyuan',
  xiaomi: 'Xiaomi / MiMo',
  nvidia: 'Free / NVIDIA',
};

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
      // Opus 5 supersedes 4.8 at the same $5/$25 — 4.8 drops out of the visible
      // list (its `opus-4.8` shortcut stays live) rather than sitting next to a
      // strictly-better entry at an identical price.
      { id: 'anthropic/claude-opus-5',     shortcut: 'opus',      label: 'Claude Opus 5',     price: '$5/$25', highlight: true },
      { id: 'anthropic/claude-sonnet-5',   shortcut: 'sonnet',    label: 'Claude Sonnet 5',   price: '$3/$15' },
      { id: 'qwen/qwen3.7-max',            shortcut: 'qwen-max',  label: 'Qwen3.7 Max',       price: '$1.475/$4.425', highlight: true },
      { id: 'openai/gpt-5.6-sol',          shortcut: 'gpt',       label: 'GPT-5.6 Sol',       price: '$5/$30', highlight: true },
      // Gemini 2.5 Pro's row retired here the same way Opus 4.8's did: a
      // superseded sibling listed directly under its successor is choice
      // paralysis, not choice. `gemini-2.5` still resolves to it.
      { id: 'google/gemini-3.1-pro',       shortcut: 'gemini',    label: 'Gemini 3.1 Pro',    price: '$2/$12' },
      { id: 'xai/grok-4.5',                shortcut: 'grok',      label: 'Grok 4.5',          price: '$2.5/$9' },
      // Kimi K3 (2026-07): 2.8T open MoE, 1M context, multimodal + reasoning.
      // Replaced the budget K2.7 line — now premium-priced ($3/$15).
      { id: 'moonshot/kimi-k3',            shortcut: 'kimi',      label: 'Kimi K3',           price: '$3/$15' },
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
      // Terra Pro took the row grok-4-1-fast-reasoning used to hold: the xAI
      // fast family is hidden from /v1/models, so reconcilePicker dropped that
      // row on every live render anyway (`grok-fast` still resolves). Terra
      // Pro is GPT-5.6 Terra with pro reasoning on, at HALF Terra's price.
      { id: 'openai/gpt-5.6-terra-pro',      shortcut: 'terra-pro',    label: 'GPT-5.6 Terra Pro',     price: '$1/$6', highlight: true },
      // GLM-5.3: Z.AI's flagship — 1M context, always-on reasoning, strong on
      // long-horizon coding. `glm`/`glm5` shortcuts pin it.
      { id: 'zai/glm-5.3',                   shortcut: 'glm',          label: 'GLM-5.3',               price: '$1.4/$4.4' },
    ],
  },
  {
    category: '💰 Budget',
    models: [
      { id: 'anthropic/claude-haiku-4.5',          shortcut: 'haiku',    label: 'Claude Haiku 4.5',    price: '$1/$5' },
      { id: 'openai/gpt-5-mini',                   shortcut: 'mini',     label: 'GPT-5 Mini',          price: '$0.25/$2' },
      // `flash` now follows Gemini 3.6; this row keeps the cheap 2.5 build and
      // labels itself with the explicit shortcut so the two can't drift apart.
      { id: 'google/gemini-2.5-flash',             shortcut: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', price: '$0.3/$2.5' },
      // Re-aliased to V4 Flash Chat upstream — context 1M, price 30% lower.
      { id: 'deepseek/deepseek-chat',              shortcut: 'deepseek', label: 'DeepSeek V4 Flash Chat', price: '$0.14/$0.28' },
      // Cheapest paid model on the gateway, and it still carries 1M context
      // with reasoning — the budget slot GLM-5 used to hold (its flat-rate
      // promo ended 2026-06-06 and it now lists at $1/$3.2, no longer a budget
      // number; the `glm-5` shortcut stays live).
      { id: 'qwen/qwen3.7-flash',                  shortcut: 'qwen-flash', label: 'Qwen3.7 Flash',     price: '$0.03/$0.13', highlight: true },
      // Minimax M2.7 hidden to make room for V4 Pro in Reasoning + V4 Flash
      // (free) without exceeding the picker's 24-entry cap. Shortcut `minimax`
      // still resolves to it.
    ],
  },
  {
    category: '🆓 Free (no USDC needed)',
    models: [
      // Nemotron Nano 9B leads: it's what the `free` shortcut + free routing
      // profile resolve to, promoted 2026-08-12 when qwen3-next-80b-a3b-instruct
      // hit NVIDIA's EOL (410). All rows are $0 — the free tier never falls
      // back to paid.
      //
      // Caveat worth knowing before editing this list: the NVIDIA free pool
      // silently substitutes or degrades, so every row here is re-probed
      // before it ships. Re-probed 2026-08-19: the nano pair and the 30B omni
      // model all answer as THEMSELVES on both the streaming and non-streaming
      // paths (omni was pooled behind gpt-oss-120b in August and has since
      // been fixed upstream — hence its new row). mistral-nemotron still
      // comes back served by `nvidia/nemotron-3-super-120b`; it keeps its row
      // and its `nemotron` alias but must never lead a chain. The catalog's
      // fifth free id, nvidia/step-3.7-flash, is substituted the same way and
      // is deliberately absent from both this list and MODEL_SHORTCUTS.
      { id: 'nvidia/nemotron-nano-9b-v2',     shortcut: 'free',     label: 'Nemotron Nano 9B',   price: 'FREE', highlight: true },
      { id: 'nvidia/nemotron-nano-12b-v2-vl', shortcut: 'nano-vl',  label: 'Nemotron Nano VL',   price: 'FREE' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', shortcut: 'omni', label: 'Nemotron 3 Nano Omni', price: 'FREE' },
      { id: 'nvidia/mistral-nemotron',        shortcut: 'nemotron', label: 'Mistral Nemotron',   price: 'FREE' },
    ],
  },
];

/** Flat list of all picker models (for index-based navigation). */
export const PICKER_MODELS_FLAT: ModelEntry[] = PICKER_CATEGORIES.flatMap(c => c.models);

// ─── Live hydration against the gateway catalog ────────────────────────────

/**
 * Synthetic ids that are Franklin concepts, not gateway models (`blockrun/auto`
 * is a routing profile resolved client-side). They never appear in the catalog,
 * so they're exempt from the drop-if-absent rule below.
 */
function isSyntheticId(id: string): boolean {
  return id.startsWith('blockrun/');
}

function providerOf(id: string): string {
  return id.split('/', 1)[0] || 'other';
}

function providerRank(provider: string): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index >= 0 ? index : PROVIDER_ORDER.length;
}

function providerHeading(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

function modelSuffix(id: string): string {
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
}

function versionScoreFrom(match: RegExpMatchArray | null): number {
  if (!match) return 0;
  const parts = match[1].split('.').map(part => Number.parseInt(part, 10) || 0);
  return parts.slice(0, 3).reduce((score, part, index) => score + part * [1_000_000, 100_000, 1_000][index], 0);
}

function providerVersionScore(provider: string, suffix: string): number {
  switch (provider) {
    case 'anthropic':
      return versionScoreFrom(suffix.match(/claude-(?:fable|opus|sonnet|haiku)-(\d+(?:\.\d+)*)/));
    case 'openai':
      if (suffix.startsWith('gpt-4o')) return versionScoreFrom(['', '4.0'] as RegExpMatchArray);
      return versionScoreFrom(suffix.match(/(?:gpt-|o)(\d+(?:\.\d+)*)/));
    case 'google':
      return versionScoreFrom(suffix.match(/gemini-(\d+(?:\.\d+)*)/));
    case 'xai':
      return versionScoreFrom(suffix.match(/grok-(\d+(?:\.\d+)*)/));
    case 'zai':
      return versionScoreFrom(suffix.match(/glm-(\d+(?:\.\d+)*)/));
    case 'moonshot':
      return versionScoreFrom(suffix.match(/kimi-k(\d+(?:\.\d+)*)/));
    case 'minimax':
      return versionScoreFrom(suffix.match(/minimax-m(\d+(?:\.\d+)*)/));
    case 'deepseek':
      return versionScoreFrom(suffix.match(/deepseek-v(\d+(?:\.\d+)*)/));
    case 'nvidia':
      return versionScoreFrom(
        suffix.match(/deepseek-v(\d+(?:\.\d+)*)/) ??
        suffix.match(/qwen(\d+(?:\.\d+)*)/) ??
        suffix.match(/step-(\d+(?:\.\d+)*)/) ??
        suffix.match(/nemotron-(\d+(?:\.\d+)*)/) ??
        suffix.match(/mistral-large-(\d+(?:\.\d+)*)/) ??
        suffix.match(/v(\d+(?:\.\d+)*)/),
      );
    default:
      return versionScoreFrom(suffix.match(/(?:^|[^\d])(\d+(?:\.\d+)*)(?:[^\d]|$)/));
  }
}

function expandedModelRank(model: GatewayModel): number {
  const suffix = modelSuffix(model.id).toLowerCase();
  const provider = providerOf(model.id);
  let score = providerVersionScore(provider, suffix);

  switch (provider) {
    case 'anthropic':
      score += suffix.includes('fable') ? 90_000 : suffix.includes('opus') ? 80_000 : suffix.includes('sonnet') ? 70_000 : suffix.includes('haiku') ? 40_000 : 0;
      break;
    case 'openai':
      score += suffix.startsWith('gpt-') ? 80_000 : suffix.startsWith('o') ? 65_000 : 0;
      if (suffix.includes('codex')) score += 8_000;
      if (suffix.includes('pro') || suffix.includes('sol')) score += 3_000;
      if (suffix.includes('terra')) score += 2_000;
      if (suffix.includes('luna')) score += 1_000;
      if (suffix.includes('mini')) score -= 8_000;
      if (suffix.includes('nano')) score -= 12_000;
      break;
    case 'google':
      score += suffix.includes('gemini') ? 80_000 : 0;
      if (suffix.includes('pro')) score += 5_000;
      if (suffix.includes('flash')) score -= 5_000;
      break;
    case 'xai':
      score += suffix.includes('grok') ? 80_000 : 0;
      if (suffix.includes('fast')) score -= 4_000;
      if (suffix.includes('build')) score -= 8_000;
      break;
    case 'zai':
      score += suffix.includes('glm') ? 80_000 : 0;
      if (suffix.includes('turbo')) score -= 5_000;
      break;
    case 'moonshot':
      score += suffix.includes('kimi') ? 80_000 : 0;
      break;
    case 'minimax':
      score += suffix.includes('minimax') ? 80_000 : 0;
      break;
    case 'deepseek':
      score += suffix.includes('v4-pro') ? 90_000 : suffix.includes('reasoner') ? 75_000 : suffix.includes('chat') ? 70_000 : 0;
      break;
    case 'nvidia':
      score += suffix.includes('qwen3-next') ? 80_000 : suffix.includes('qwen') ? 70_000 : suffix.includes('nemotron') ? 60_000 : 0;
      break;
  }

  return score;
}

function cleanGatewayLabel(model: GatewayModel): string {
  return (model.name || modelSuffix(model.id))
    .replace(/\s*\((?:free|paid)\)\s*$/i, '')
    .trim();
}

function buildShortcutById(): Map<string, string> {
  const preferred = new Map<string, string>();
  for (const row of PICKER_CATEGORIES.flatMap(category => category.models)) {
    preferred.set(row.id, row.shortcut);
  }
  for (const [shortcut, id] of Object.entries(MODEL_SHORTCUTS)) {
    const existing = preferred.get(id);
    if (!existing || shortcut.length < existing.length) preferred.set(id, shortcut);
  }
  return preferred;
}

/** Render a gateway price object into the picker's display format. */
function formatPrice(m: GatewayModel): string {
  const p = m.pricing as unknown as Record<string, number | undefined>;
  switch (m.billing_mode) {
    case 'free':
      return 'FREE';
    case 'paid':
      return `$${p.input ?? 0}/$${p.output ?? 0}`;
    case 'flat':
      return `$${p.flat ?? 0} flat`;
    default:
      // Non-chat billing modes (per_image/per_second/…) shouldn't reach the
      // picker, but don't invent a number if one does.
      return '—';
  }
}

export interface HydratedPicker {
  categories: ModelCategory[];
  /** Chat models live on the gateway that aren't curated into the picker. */
  moreCount: number;
  /** False when the gateway was unreachable and this is the static fallback. */
  live: boolean;
}

/**
 * The picker list, reconciled against the live gateway catalog.
 *
 * {@link PICKER_CATEGORIES} stays the editorial layer — which models are worth
 * featuring, in what order, under which heading, with which shortcut. The
 * gateway is the source of truth for everything factual: whether a model still
 * exists and its price. Ctrl+A uses {@link getExpandedPickerCategories} when the
 * user explicitly wants the full gateway chat catalog.
 *
 * Reconciliation rules:
 *   - Curated row present in the catalog → keep its label/shortcut/highlight and
 *     refresh its price from the gateway.
 *   - Curated row absent → drop it. This is the self-healing half: an id the
 *     gateway retired (the `claude-haiku-4.5-20251001` case) stops being
 *     offered without waiting on a Franklin release. Its MODEL_SHORTCUTS alias
 *     survives, matching the long-standing "hide the row, keep the shortcut"
 *     pattern.
 *   - Gateway unreachable → serve the static list verbatim (`live: false`).
 *     An offline picker showing a slightly stale list beats an empty one.
 *
 * Note the catalog hides some models that still resolve (grok-3 and the xAI
 * fast family, for instance). Hidden-but-working ids are therefore dropped from
 * the *visible* list while remaining reachable by typing the shortcut — which
 * is the intended behavior, not a bug.
 */
export async function getPickerCategories(): Promise<HydratedPicker> {
  try {
    return reconcilePicker(await getGatewayModels());
  } catch {
    return { categories: PICKER_CATEGORIES, moreCount: 0, live: false };
  }
}

/**
 * Pure reconciliation step behind {@link getPickerCategories} — exported so the
 * rules can be tested against a synthetic catalog without touching the network.
 */
export function reconcilePicker(catalog: GatewayModel[]): HydratedPicker {
  const byId = new Map(catalog.map(m => [m.id, m]));
  const categories: ModelCategory[] = [];
  const curated = new Set<string>();

  for (const cat of PICKER_CATEGORIES) {
    const models: ModelEntry[] = [];
    for (const row of cat.models) {
      curated.add(row.id);
      if (isSyntheticId(row.id)) {
        models.push(row);
        continue;
      }
      const live = byId.get(row.id);
      if (!live) continue; // retired upstream — drop the row, keep the alias
      // Price comes from the gateway (it's factual, it drifts, and it's the
      // user's money). The label stays curated: gateway names are longer than
      // the picker's tuned columns and often carry redundant suffixes.
      models.push({ ...row, price: formatPrice(live) });
    }
    if (models.length > 0) categories.push({ ...cat, models });
  }

  const moreCount = catalog.filter(
    m => m.categories?.includes('chat') && !curated.has(m.id),
  ).length;

  return { categories, moreCount, live: true };
}

export async function getExpandedPickerCategories(): Promise<HydratedPicker> {
  try {
    return reconcileExpandedPicker(await getGatewayModels());
  } catch {
    return { categories: PICKER_CATEGORIES, moreCount: 0, live: false };
  }
}

export function reconcileExpandedPicker(catalog: GatewayModel[]): HydratedPicker {
  const categories: ModelCategory[] = [{ ...PICKER_CATEGORIES[0], models: [...PICKER_CATEGORIES[0].models] }];
  const curated = new Set<string>();
  const curatedRows = new Map<string, ModelEntry>();

  for (const cat of PICKER_CATEGORIES) {
    for (const row of cat.models) {
      curated.add(row.id);
      if (!isSyntheticId(row.id)) curatedRows.set(row.id, row);
    }
  }

  const shortcutById = buildShortcutById();
  const chatModels = catalog
    .filter(m => m.categories?.includes('chat'))
    .sort((a, b) => {
      const providerDelta = providerRank(providerOf(a.id)) - providerRank(providerOf(b.id));
      if (providerDelta !== 0) return providerDelta;
      const rankDelta = expandedModelRank(b) - expandedModelRank(a);
      if (rankDelta !== 0) return rankDelta;
      const curatedDelta = Number(!curated.has(a.id)) - Number(!curated.has(b.id));
      if (curatedDelta !== 0) return curatedDelta;
      return modelSuffix(a.id).localeCompare(modelSuffix(b.id));
    });

  const byProvider = new Map<string, ModelEntry[]>();
  for (const model of chatModels) {
    const provider = providerOf(model.id);
    const curatedRow = curatedRows.get(model.id);
    const row: ModelEntry = curatedRow
      ? { ...curatedRow, price: formatPrice(model) }
      : {
          id: model.id,
          shortcut: shortcutById.get(model.id) || model.id,
          label: cleanGatewayLabel(model),
          price: formatPrice(model),
        };
    const rows = byProvider.get(provider) ?? [];
    rows.push(row);
    byProvider.set(provider, rows);
  }

  for (const [provider, models] of [...byProvider.entries()].sort((a, b) => {
    const rankDelta = providerRank(a[0]) - providerRank(b[0]);
    return rankDelta !== 0 ? rankDelta : a[0].localeCompare(b[0]);
  })) {
    categories.push({ category: providerHeading(provider), models });
  }

  return { categories, moreCount: 0, live: true };
}

/**
 * Show interactive model picker. Returns the selected model ID.
 * Falls back to text input if terminal doesn't support raw mode.
 */
export async function pickModel(currentModel?: string): Promise<string | null> {
  // Same gateway reconciliation the Ink picker gets — falls back to the static
  // curation when the catalog is unreachable.
  const { categories: PICKER_MODELS, moreCount } = await getPickerCategories();

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

  if (moreCount > 0) {
    console.error(
      chalk.dim(`  + ${moreCount} more on gateway — run \`franklin models\` to list them.\n`)
    );
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
