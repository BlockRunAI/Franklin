/**
 * Image Generation capability — generate images via BlockRun API.
 * Uses x402 payment on Solana or Base.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { loadChain, API_URLS, VERSION } from '../config.js';
import { loadConfig } from '../commands/config.js';
import type { ContentLibrary } from '../content/library.js';
import { checkImageBudget, recordImageAsset } from '../content/record-image.js';
import { ModelClient } from '../agent/llm.js';
import { analyzeMediaRequest, renderProposalForAskUser } from '../agent/media-router.js';

interface ImageGenInput {
  prompt: string;
  output_path?: string;
  size?: string;
  model?: string;
  /**
   * Optional Content id to attach this generation to. When provided:
   *   (1) Budget is checked BEFORE the paid generation — refusing up-front
   *       saves wasting USDC on a fill that couldn't be recorded.
   *   (2) On successful generation, the saved image is recorded as an asset
   *       on that content with the estimated USD cost.
   */
  contentId?: string;
}

export interface ImageGenDeps {
  /** Optional Content library for auto-recording generations into a piece. */
  library?: ContentLibrary;
  /** Invoked after successful content-linked generation; lets callers persist. */
  onContentChange?: () => void | Promise<void>;
}

function buildExecute(deps: ImageGenDeps) {
  return async function execute(
    input: Record<string, unknown>,
    ctx: ExecutionScope,
  ): Promise<CapabilityResult> {
    const { prompt, output_path, size, model, contentId } = input as unknown as ImageGenInput;

    if (!prompt) {
      return { output: 'Error: prompt is required', isError: true };
    }

    // ── Media router + AskUser flow ────────────────────────────────────
    // If the caller explicitly named a model, or the env auto-approves, or
    // no AskUser bridge exists (batch / --prompt mode), skip the proposal
    // step and use the old default. Otherwise: classifier picks a fitting
    // model, cost preview goes to AskUser, user chooses or cancels.
    const userDefaultImage = loadConfig()['default-image-model'];
    let imageModel = model || userDefaultImage || 'openai/gpt-image-1';
    const imageSize = size || '1024x1024';

    // Skip cost preview when the caller named a model explicitly OR the
    // user has set a default-image-model (they've already chosen).
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!model && !userDefaultImage && !autoApprove && ctx.onAskUser) {
      try {
        const chain = loadChain();
        const client = new ModelClient({ apiUrl: API_URLS[chain], chain });
        const proposal = await analyzeMediaRequest({
          kind: 'image',
          prompt,
          quantity: 1,
          client,
          signal: ctx.abortSignal,
        });
        if (proposal) {
          const { question, options } = renderProposalForAskUser(proposal, prompt);
          const labels = options.map(o => o.label);
          const answer = await ctx.onAskUser(question, labels);
          // Map the user's returned label back to an option id
          const chosen = options.find(o => o.label === answer) ?? { id: 'cancel' };
          switch (chosen.id) {
            case 'cheaper':
              imageModel = proposal.cheaper?.model ?? proposal.recommended.model;
              break;
            case 'premium':
              imageModel = proposal.premium?.model ?? proposal.recommended.model;
              break;
            case 'cancel':
              return {
                output: `## Image generation cancelled\n\nNo USDC was spent. Ask again when ready, or pass an explicit \`model\` to skip the confirmation step.`,
              };
            case 'recommended':
            default:
              imageModel = proposal.recommended.model;
          }
        }
      } catch {
        // Router / AskUser failed — fall back to default model silently.
      }
    }
    if (contentId && deps.library) {
      const decision = checkImageBudget(deps.library, contentId, imageModel, imageSize);
      if (!decision.ok) {
        // Normal text output, not isError — the agent should adapt (smaller
        // size, different model, raise budget) rather than trigger retry.
        return {
          output:
            `## Image generation skipped\n` +
            `- ${decision.reason}\n\n` +
            `No USDC was spent. Choose a cheaper model/size or raise the ` +
            `content budget before trying again.`,
        };
      }
    }

  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const endpoint = `${apiUrl}/v1/images/generations`;

  // Default output path
  const outPath = output_path
    ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
    : path.resolve(ctx.workingDir, `generated-${Date.now()}.png`);

  const body = JSON.stringify({
    model: imageModel,
    prompt,
    n: 1,
    size: imageSize,
    response_format: 'b64_json',
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000); // 60s timeout

  try {
    // First request — will get 402
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body,
    });

    // Handle x402 payment
    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        return { output: 'Payment failed. Check wallet balance with: runcode balance', isError: true };
      }

      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
        body,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { output: `Image generation failed (${response.status}): ${errText.slice(0, 200)}`, isError: true };
    }

    const result = await response.json() as {
      data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
    };

    const imageData = result.data?.[0];
    if (!imageData) {
      return { output: 'No image data returned from API', isError: true };
    }

    // Save image
    if (imageData.b64_json) {
      const buffer = Buffer.from(imageData.b64_json, 'base64');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);
    } else if (imageData.url) {
      // Download from URL (with 30s timeout)
      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), 30_000);
      const imgResp = await fetch(imageData.url, { signal: dlCtrl.signal });
      clearTimeout(dlTimeout);
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);
    } else {
      return { output: 'No image data (b64_json or url) in response', isError: true };
    }

    const fileSize = fs.statSync(outPath).size;
    const sizeKB = (fileSize / 1024).toFixed(1);
    const revisedPrompt = imageData.revised_prompt ? `\nRevised prompt: ${imageData.revised_prompt}` : '';

    let contentSummary = '';
    if (contentId && deps.library) {
      const rec = recordImageAsset(deps.library, {
        contentId,
        imagePath: outPath,
        model: imageModel,
        size: imageSize,
      });
      if (rec.ok) {
        if (deps.onContentChange) await deps.onContentChange();
        const c = deps.library.get(contentId);
        contentSummary =
          `\n\n## Content updated\n` +
          `- Attached to \`${contentId}\` at est. $${rec.costUsd.toFixed(2)}\n` +
          (c
            ? `- Spent: $${c.spentUsd.toFixed(2)} / $${c.budgetUsd.toFixed(2)} cap ` +
              `(remaining $${(c.budgetUsd - c.spentUsd).toFixed(2)})`
            : '');
      } else {
        // Pre-flight guarded this, but keep defensive — bookkeeping refusal
        // after a successful paid generation is rare (TOCTOU) but possible.
        contentSummary =
          `\n\n## Content NOT updated\n` +
          `- ${rec.reason}\n` +
          `- The image was generated and saved locally; cost was NOT recorded ` +
          `against the content budget.`;
      }
    }

    return {
      output: `Image saved to ${outPath} (${sizeKB}KB, ${imageSize})${revisedPrompt}\n\nOpen with: open ${outPath}${contentSummary}`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('abort')) {
      return { output: 'Image generation timed out (60s limit). Try a simpler prompt.', isError: true };
    }
    return { output: `Error: ${msg}`, isError: true };
  } finally {
    clearTimeout(timeout);
  }
  };
}

// ─── Payment ───────────────────────────────────────────────────────────────

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string
): Promise<Record<string, string> | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;

    if (chain === 'solana') {
      const wallet = await getOrCreateSolanaWallet();
      const paymentRequired = parsePaymentRequired(paymentHeader);
      const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
      const secretBytes = await solanaKeyToBytes(wallet.privateKey);
      const feePayer = details.extra?.feePayer || details.recipient;

      const payload = await createSolanaPaymentPayload(
        secretBytes,
        wallet.address,
        details.recipient,
        details.amount,
        feePayer as string,
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'RunCode image generation',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return { 'PAYMENT-SIGNATURE': payload };
    } else {
      const wallet = getOrCreateWallet();
      const paymentRequired = parsePaymentRequired(paymentHeader);
      const details = extractPaymentDetails(paymentRequired);

      const payload = await createPaymentPayload(
        wallet.privateKey as `0x${string}`,
        wallet.address,
        details.recipient,
        details.amount,
        details.network || 'eip155:8453',
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'RunCode image generation',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
  } catch (err) {
    console.error(`[franklin] Image payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) {
        header = btoa(JSON.stringify(body));
      }
    } catch { /* ignore */ }
  }
  return header;
}

// ─── Export ────────────────────────────────────────────────────────────────

/**
 * Build the ImageGen capability. Passing `deps.library` enables the
 * contentId flow: pre-flight budget check + post-generation asset
 * recording. With no deps, behavior matches the pre-factory version.
 */
export function createImageGenCapability(deps: ImageGenDeps = {}): CapabilityHandler {
  return {
    spec: {
      name: 'ImageGen',
      description:
        "Generate an image from a text prompt. Costs USDC from the user's wallet " +
        "— confirm before generating. Saves to a local file. Default size: " +
        "1024x1024. Do NOT call repeatedly to iterate on style — ask the user " +
        "first. Pass contentId to attach the result to an existing Content " +
        "piece: the content's budget is checked BEFORE paying, and on success " +
        "the image is recorded as an asset with its estimated cost. Skipping " +
        "contentId generates a one-off image with no budget tracking.",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the image to generate' },
          output_path: { type: 'string', description: 'Where to save the image. Default: generated-<timestamp>.png in working directory' },
          size: { type: 'string', description: 'Image size: 1024x1024, 1792x1024, or 1024x1792. Default: 1024x1024' },
          model: { type: 'string', description: 'Image model to use. Default: openai/gpt-image-1' },
          contentId: { type: 'string', description: 'Optional Content id to attach this generation to. Pre-flight budget check + auto-record on success.' },
        },
        required: ['prompt'],
      },
    },
    execute: buildExecute(deps),
    concurrent: false,
  };
}

/** Back-compat static capability for callers that don't want the Content bridge. */
export const imageGenCapability: CapabilityHandler = createImageGenCapability();
