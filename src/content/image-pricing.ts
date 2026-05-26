/**
 * Best-effort pricing estimate for image generation models Franklin routes
 * through the BlockRun gateway. Numbers are drawn from published model
 * pricing and should be treated as *estimates* — the x402 micropayment is
 * what actually debits the wallet. The purpose of this table is to attach a
 * USD cost to a generated asset so budget tracking on a Content piece has
 * something to count against, not to promise an exact price.
 *
 * Kept in `content/` (not `tools/`) because the table is content-budget
 * business logic, not an image-generation implementation detail. If the
 * gateway ever exposes the realized payment amount on the response, that
 * should be preferred — fall back to this estimate when it's missing.
 */

/**
 * Per-image base price by model + size. Mirrors the gateway's IMAGE_MODELS.sizes
 * (blockrun src/lib/models.ts). These are base prices — the realized x402 charge
 * adds a small markup — but they're close enough for budget tracking. Sizes not
 * listed for a model fall back to that model's 1024x1024 tier.
 */
const PRICE_TABLE: Record<string, { sizes: Record<string, number>; base: number }> = {
  'openai/dall-e-3': {
    base: 0.04,
    sizes: { '1024x1024': 0.04, '1792x1024': 0.08, '1024x1792': 0.08 },
  },
  'openai/gpt-image-1': {
    base: 0.02,
    sizes: { '1024x1024': 0.02, '1536x1024': 0.04, '1024x1536': 0.04 },
  },
  'openai/gpt-image-2': {
    base: 0.06,
    sizes: { '1024x1024': 0.06, '1536x1024': 0.12, '1024x1536': 0.12 },
  },
  'google/nano-banana': {
    base: 0.05,
    sizes: { '1024x1024': 0.05 },
  },
  'google/nano-banana-pro': {
    base: 0.1,
    sizes: { '1024x1024': 0.1, '2048x2048': 0.1, '4096x4096': 0.15 },
  },
};

/**
 * Estimate the USD cost of `n` images for a model + size. `n` defaults to 1.
 * Unknown models return 0 rather than a guess — a free/custom model should not
 * carry a phantom charge against the Content budget, and surprise overcharging
 * from a wrong guess is worse than under-counting.
 */
export function estimateImageCostUsd(model: string, size: string, n: number = 1): number {
  const entry = PRICE_TABLE[model.toLowerCase()];
  if (!entry) return 0;
  const s = size.replace(/\s+/g, '');
  const perImage = entry.sizes[s] ?? entry.base;
  return perImage * Math.max(1, n);
}
