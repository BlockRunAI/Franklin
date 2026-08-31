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

import { freeVisionModel } from '../free-models.js';

const VISION_MODELS = new Set<string>([
  // Anthropic — native vision across the line
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.7',
  // Hidden from /v1/models since 2026-08 but still served (probed through
  // the binary 2026-08-29) — a pinned `opus-4.6` image turn must not be
  // rerouted to a sibling the user didn't ask for.
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  // OpenAI — multimodal flagships + o3 (Codex 5.3 is text-only, excluded).
  // GPT-5.6 family + 5.4-mini are vision; 5.4-nano is text-only.
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  // The pro reasoning tier is the same multimodal base with thinking on.
  'openai/gpt-5.6-sol-pro',
  'openai/gpt-5.6-terra-pro',
  'openai/gpt-5.6-luna-pro',
  'openai/gpt-5.5',
  'openai/gpt-5.5-pro',
  // The rolling ChatGPT default — vision-tagged in the catalog.
  'openai/chat-latest',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.2',
  'openai/gpt-5.2-pro',
  'openai/gpt-5-mini',
  'openai/gpt-5.3',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/o3',
  // Google — vision baked into every Gemini SKU we surface (flash-lite excepted)
  'google/gemini-3.1-pro',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  // xAI — grok-4-1-fast-reasoning stays out (text-only). Grok 4.5 and 4.3 are
  // both vision-capable in the catalog and were missing here until 2026-08-20:
  // `grok` resolves to 4.5, so every image turn on the xAI flagship was being
  // rerouted to a "vision sibling" the user never asked for. grok-4-0709 and
  // grok-3 are hidden from /v1/models but still served (probed 2026-08-29).
  'xai/grok-4.5',
  'xai/grok-4.3',
  'xai/grok-4-0709',
  'xai/grok-3',
  // Moonshot — K3 is the flagship; the K2.x line is hidden from /v1/models
  // but still served (probed 2026-08-29) and is catalogued as multimodal.
  'moonshot/kimi-k3',
  'moonshot/kimi-k2.7',
  'moonshot/kimi-k2.6',
  'moonshot/kimi-k2.5',
  // Z.AI — GLM-5.3 Flash is the one GLM SKU the catalog tags as vision
  // (2026-08-29 sync); GLM-5.3 / 5.2 / 5.1 are text + reasoning only.
  'zai/glm-5.3-flash',
  // ── The free vision model is NOT here, on purpose ──
  // isVisionModel() consults freeVisionModel() instead of this static set,
  // because that answer depends on gateway deploy state and an env override
  // rather than on a fixed capability. See the note below and free-models.ts.
  //
  // ── Why no free vision id is listed (2026-08-31) ──
  // Listing an id here is a promise isVisionModel() callers act on: the agent
  // loop and the proxy both use it to decide whether an image can be sent at
  // all. Neither free vision id earns that promise, for two DIFFERENT reasons:
  //
  //   nemotron-3-nano-omni    — sees the image 6/10 on /v1/messages, and on
  //                             /chat/completions is substituted 7/10 by a
  //                             model with no vision at all.
  //   llama-3.2-11b-vision    — reads the image reliably as a bare call
  //                             (30/30) but only 1/5 end-to-end through the
  //                             agent loop, which is Franklin's own wiring
  //                             problem, not the model's.
  //
  // Full measurement history and the acceptance bar for re-adding either:
  // freeVisionModel() in src/free-models.ts.
  //
  // nvidia/nemotron-nano-12b-v2-vl held this slot until it left the catalog on
  // 2026-08-30; Llama 4 Maverick before that (dropped 2026-07-14).
]);

/** Does this concrete gateway model accept image input? */
export function isVisionModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false;
  if (VISION_MODELS.has(modelId)) return true;
  // The free tier's vision model is resolved at runtime, not fixed: it depends
  // on gateway deploy state and on FRANKLIN_FREE_VISION_MODEL. freeVisionModel()
  // returns null when no free model can be trusted with an image, and this
  // stays false there.
  return modelId === freeVisionModel();
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
