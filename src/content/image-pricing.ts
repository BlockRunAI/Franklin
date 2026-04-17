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

export function estimateImageCostUsd(model: string, size: string): number {
  const m = model.toLowerCase();
  const s = size.replace(/\s+/g, '');

  if (m === 'openai/dall-e-3') {
    if (s === '1792x1024' || s === '1024x1792') return 0.08;
    // All other sizes fall back to the standard 1024x1024 tier.
    return 0.04;
  }

  if (m === 'openai/gpt-image-1') {
    // gpt-image-1 standard tier; larger sizes would tier up but Franklin
    // sends 1024x1024 as default.
    return 0.042;
  }

  // Unknown model: return 0 rather than a guess. A free/custom model should
  // not have a phantom charge against the Content budget, and surprise
  // overcharging from a wrong guess is worse than under-counting.
  return 0;
}
