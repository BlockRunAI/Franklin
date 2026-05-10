/**
 * Vision capability + image-attachment detection.
 *
 * Two jobs:
 *   1. isVisionModel(id)        — does this gateway model accept image input?
 *   2. messageNeedsVision(text) — does this user message reference an image?
 *
 * Source of truth: a hand-curated allowlist below. The gateway exposes a
 * 'vision' category on /v1/models, but resolving it at routing time would
 * make routeRequest async and gate sync proxy paths on a network call. The
 * allowlist is small (~18 entries) and changes only when models do, which
 * already touches the router + pricing tables — updating one more file is
 * the right tradeoff vs. async fan-out across every routing callsite.
 *
 * Background: prior to this module, Auto routing could pick a text-only model
 * (e.g. deepseek-v4-pro) on an image-bearing turn. The Read tool would still
 * inline image bytes, the gateway would tokenize the base64 as text, and the
 * model — having no vision pathway — would hallucinate based on the
 * `Image file: <path>` description string. Expensive AND wrong.
 */

const VISION_MODELS = new Set<string>([
  // Anthropic — native vision across the line
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5-20251001',
  // OpenAI — multimodal flagships + o3 (Codex 5.3 is text-only, excluded)
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.2',
  'openai/gpt-5.2-pro',
  'openai/gpt-5-mini',
  'openai/gpt-4.1',
  'openai/o3',
  // Google — vision baked into every Gemini SKU we surface
  'google/gemini-3.1-pro',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  // xAI — only Grok 4 base supports vision; grok-4-1-fast-reasoning is text-only
  'xai/grok-4-0709',
  'xai/grok-3',
  // Moonshot — K2.6 added vision + reasoning when it replaced K2.5
  'moonshot/kimi-k2.6',
  // NVIDIA inference — Llama 4 Maverick is multimodal; deepseek/qwen-coder are not
  'nvidia/llama-4-maverick',
]);

/** Does this concrete gateway model accept image input? */
export function isVisionModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  return VISION_MODELS.has(modelId);
}

/** Lower-cased copy used for prefix family matching in pickVisionSibling. */
const VISION_MODELS_LIST = Array.from(VISION_MODELS);

/**
 * Pick a vision-capable replacement closest to the user's chosen model.
 * Prefers same provider family (so the user's intent — "I want Claude" vs
 * "I want Gemini" — survives the swap), then falls back to a sensible
 * vision default (Sonnet 4.6 — agent-tuned, mid-tier price).
 */
export function pickVisionSibling(modelId: string): string {
  const family = modelId.split('/')[0]?.toLowerCase();
  if (family) {
    const sibling = VISION_MODELS_LIST.find(m => m.startsWith(`${family}/`));
    if (sibling) return sibling;
  }
  return 'anthropic/claude-sonnet-4.6';
}

// Image file extensions Franklin's Read tool inlines as vision content. Keep
// this in sync with IMAGE_MEDIA_TYPES in src/tools/read.ts — if Read learns a
// new format (e.g. .avif), this regex needs to learn it too or routing will
// silently miss it.
//
// We match the basename only ("foo.png"), preceded by any path separator or
// punctuation. Trying to match full path prefixes ("./", "/", "~/", "C:\")
// in one regex produced false negatives on Windows-style paths because of
// the `:` and `\` separators. The basename anchor is enough — a bare
// `foo.png` reference is what the Read tool actually needs to inline bytes.
const IMAGE_PATH_RE =
  /(?:^|[\s"'`(<\[\\/])[\w@%+-]+\.(?:png|jpe?g|gif|webp)(?=$|[\s"'`)>\],.?!:;])/i;

/**
 * Does this user-typed message reference an image file? Used by the router
 * to bump Auto mode to a vision-capable tier, and by the manual-mode guard
 * to swap a text-only model for one turn.
 *
 * Detection is intentionally a regex over file extensions rather than a
 * filesystem stat — the user may type a path that doesn't yet exist
 * (about to wget it) or a glob; what we care about is "does the model need
 * eyes for this turn?" The false-positive risk is benign (we route to a
 * slightly stronger model than strictly needed).
 */
export function messageNeedsVision(text: string | undefined | null): boolean {
  if (!text) return false;
  return IMAGE_PATH_RE.test(text);
}

interface ContentPart {
  type?: string;
  text?: string;
}

/**
 * Messages-array variant: scans OpenAI- and Anthropic-format content blocks
 * for explicit image parts (image / image_url / input_image) and for image
 * paths embedded in text parts. Used by the proxy router which receives a
 * fully-formed messages[] payload, not a single string.
 */
export function messagesNeedVision(
  messages: Array<{ role?: string; content?: unknown }> | undefined | null,
): boolean {
  if (!messages || messages.length === 0) return false;
  for (const msg of messages) {
    if (msg.role && msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') {
      if (messageNeedsVision(content)) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content as ContentPart[]) {
      const t = part?.type;
      if (t === 'image' || t === 'image_url' || t === 'input_image') return true;
      if (t === 'text' && messageNeedsVision(part.text)) return true;
    }
  }
  return false;
}
