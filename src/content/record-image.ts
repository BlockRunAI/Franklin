/**
 * recordImageAsset — wire an ImageGen result into a Content piece's budget.
 *
 * The ImageGen tool closes the loop between spending USDC and tracking it
 * against a content project. When the agent generates a hero image for a
 * piece of content, this helper:
 *   1. Estimates the USD cost from model + size (see image-pricing.ts).
 *   2. Calls ContentLibrary.addAsset, which enforces the per-piece budget.
 *   3. Returns a structured decision so the caller (imagegen.ts) can format
 *      a human-readable summary without swallowing budget refusals.
 *
 * This lives in `content/` on purpose — it's content-bookkeeping logic that
 * happens to be triggered from the ImageGen tool, not an ImageGen detail.
 */

import type { ContentLibrary } from './library.js';
import { estimateImageCostUsd } from './image-pricing.js';

export interface RecordImageAssetInput {
  contentId: string;
  imagePath: string;
  model: string;
  size: string;
}

export type RecordImageDecision =
  | { ok: true; costUsd: number; spentUsd: number }
  | { ok: false; reason: string };

/**
 * Pre-flight budget check. Run this BEFORE hitting the image-generation
 * endpoint so the agent doesn't spend real USDC on a fill it then can't
 * book against the content's budget. Returns `{ ok: true }` when the
 * estimated cost fits; `{ ok: false, reason }` when it doesn't or the
 * content doesn't exist. Non-mutating.
 */
export function checkImageBudget(
  library: ContentLibrary,
  contentId: string,
  model: string,
  size: string,
): { ok: true } | { ok: false; reason: string } {
  const content = library.get(contentId);
  if (!content) {
    return { ok: false, reason: `Content ${contentId} not found` };
  }
  const cost = estimateImageCostUsd(model, size);
  if (content.spentUsd + cost > content.budgetUsd + 1e-9) {
    return {
      ok: false,
      reason:
        `Would exceed budget: spent $${content.spentUsd.toFixed(2)} + estimated ` +
        `$${cost.toFixed(2)} > cap $${content.budgetUsd.toFixed(2)}`,
    };
  }
  return { ok: true };
}

export function recordImageAsset(
  library: ContentLibrary,
  input: RecordImageAssetInput,
): RecordImageDecision {
  const costUsd = estimateImageCostUsd(input.model, input.size);
  const result = library.addAsset(input.contentId, {
    kind: 'image',
    source: input.model,
    costUsd,
    data: input.imagePath,
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, costUsd, spentUsd: result.spentUsd };
}
