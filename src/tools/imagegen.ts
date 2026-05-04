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
import type { ContentLibrary } from '../content/library.js';
import { checkImageBudget, recordImageAsset } from '../content/record-image.js';
import { ModelClient } from '../agent/llm.js';
import { analyzeMediaRequest, renderProposalForAskUser } from '../agent/media-router.js';
import { recordUsage } from '../stats/tracker.js';
import { findModel, estimateCostUsd } from '../gateway-models.js';
import { logger } from '../logger.js';

interface ImageGenInput {
  prompt: string;
  output_path?: string;
  size?: string;
  model?: string;
  /**
   * Optional reference image for image-to-image generation (style transfer,
   * character consistency, edits). When set, the call is routed to
   * /v1/images/image2image instead of /v1/images/generations and only models
   * that support reference images may be used (gpt-image-1/2,
   * nano-banana-pro, grok-imagine-image-pro). Accepts:
   *   - http(s) URL — fetched server-side
   *   - data URI (data:image/...;base64,...)
   *   - local file path — read, base64-encoded, capped at ~4 MB
   */
  image_url?: string;
  /**
   * Optional Content id to attach this generation to. When provided:
   *   (1) Budget is checked BEFORE the paid generation — refusing up-front
   *       saves wasting USDC on a fill that couldn't be recorded.
   *   (2) On successful generation, the saved image is recorded as an asset
   *       on that content with the estimated USD cost.
   */
  contentId?: string;
}

/**
 * Models that accept a reference image via /v1/images/image2image. Currently
 * limited to OpenAI's edit endpoint — Gemini Nano Banana Pro and Grok Imagine
 * Image Pro need gateway-side support before they can be wired in here.
 */
export const EDIT_SUPPORTED_MODELS = new Set([
  'openai/gpt-image-1',
  'openai/gpt-image-2',
]);

export const REFERENCE_IMAGE_MAX_BYTES = 4_000_000;

/**
 * Normalize a reference image into a base64 data URI for the gateway. The
 * /v1/images/image2image endpoint validates `image` against /^data:image\//,
 * so http(s) URLs and local paths both have to be inlined client-side before
 * posting. Already-formed data URIs pass through.
 */
export async function resolveReferenceImage(input: string, workingDir: string): Promise<string> {
  if (input.startsWith('data:image/')) return input;

  if (/^https?:\/\//i.test(input)) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(input, { signal: ctrl.signal });
      if (!resp.ok) {
        throw new Error(`Reference image fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const contentType = (resp.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        throw new Error(`Reference image URL returned non-image content-type: ${contentType || '(none)'}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
        throw new Error(
          `Reference image too large: ${(buf.byteLength / 1_000_000).toFixed(1)}MB > ${(REFERENCE_IMAGE_MAX_BYTES / 1_000_000).toFixed(1)}MB cap.`,
        );
      }
      return `data:${contentType};base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Treat as local file path.
  const resolved = path.isAbsolute(input) ? input : path.resolve(workingDir, input);
  const stat = fs.statSync(resolved);
  if (stat.size > REFERENCE_IMAGE_MAX_BYTES) {
    throw new Error(
      `Reference image too large: ${(stat.size / 1_000_000).toFixed(1)}MB > ${(REFERENCE_IMAGE_MAX_BYTES / 1_000_000).toFixed(1)}MB cap. Resize or crop first.`,
    );
  }
  const ext = path.extname(resolved).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mime = mimeMap[ext];
  if (!mime) {
    throw new Error(`Unsupported reference image extension ${ext || '(none)'}. Use .png/.jpg/.jpeg/.gif/.webp.`);
  }
  const bytes = fs.readFileSync(resolved);
  return `data:${mime};base64,${bytes.toString('base64')}`;
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
    const rawInput = input as unknown as ImageGenInput;
    const { output_path, size, model, contentId, image_url } = rawInput;

    if (!rawInput.prompt) {
      return { output: 'Error: prompt is required', isError: true };
    }

    // Resolve the reference image (if any) before any paid call so we fail
    // cheaply on bad paths / oversize attachments. Holds the resolved data URI
    // / http URL that gets posted to /v1/images/image2image.
    let referenceImage: string | undefined;
    if (image_url) {
      try {
        referenceImage = await resolveReferenceImage(image_url, ctx.workingDir);
      } catch (err) {
        return { output: `Error: ${(err as Error).message}`, isError: true };
      }
    }

    // One-shot refinement opt-out: leading `///` tells Franklin "don't
    // refine this prompt, I wrote it the way I want it." Strip the prefix
    // and pass skipRefine through to the router.
    let prompt = rawInput.prompt;
    let skipRefine = false;
    if (prompt.trimStart().startsWith('///')) {
      prompt = prompt.replace(/^\s*\/\/\/\s?/, '');
      skipRefine = true;
    }

    // ── Media router + AskUser flow ────────────────────────────────────
    // If the caller explicitly named a model, or the env auto-approves, or
    // no AskUser bridge exists (batch / --prompt mode), skip the proposal
    // step and use the old default. Otherwise: classifier picks a fitting
    // model + rewrites the prompt, the preview goes to AskUser, user
    // chooses or cancels.
    // Reference-image mode forces an edit-capable model. If the caller named
    // an unsupported one, fail loudly so we don't silently downgrade their
    // request to text-only generation.
    if (referenceImage && model && !EDIT_SUPPORTED_MODELS.has(model)) {
      return {
        output:
          `Error: model ${model} does not support reference images. ` +
          `Use one of: ${[...EDIT_SUPPORTED_MODELS].join(', ')}.`,
        isError: true,
      };
    }

    let imageModel = model || (referenceImage ? 'openai/gpt-image-2' : 'openai/gpt-image-1');
    let imageSize = size || '1024x1024';
    let chosenPrompt = prompt;

    // Skip the proposal flow when a reference image is set: the media router
    // doesn't know which models support image-to-image, so its suggestions
    // would frequently be unusable (text-only models). Default to gpt-image-1
    // for now; a future router upgrade can pick between the four edit-capable
    // models based on the prompt.
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!model && !autoApprove && ctx.onAskUser && !referenceImage) {
      try {
        const chain = loadChain();
        const client = new ModelClient({ apiUrl: API_URLS[chain], chain });
        const proposal = await analyzeMediaRequest({
          kind: 'image',
          prompt,
          quantity: 1,
          client,
          signal: ctx.abortSignal,
          skipRefine,
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
            case 'use-raw':
              imageModel = proposal.recommended.model;
              // chosenPrompt stays as the raw input
              break;
            case 'recommended':
            default:
              imageModel = proposal.recommended.model;
              if (proposal.refinedPrompt) chosenPrompt = proposal.refinedPrompt;
          }
        }
      } catch {
        // Router / AskUser failed — fall back to default model silently.
      }
    }

    // gpt-image-2 reliably serves 1024x1024 only — other sizes time out at
    // the gateway. Force the supported size regardless of caller / router
    // input so we never burn USDC on a request that's going to abort.
    if (imageModel === 'openai/gpt-image-2' && imageSize !== '1024x1024') {
      imageSize = '1024x1024';
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
  // Reference-image mode hits the dedicated /v1/images/image2image endpoint;
  // otherwise stay on text-to-image generations.
  const endpoint = referenceImage
    ? `${apiUrl}/v1/images/image2image`
    : `${apiUrl}/v1/images/generations`;

  // Default output path
  const outPath = output_path
    ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
    : path.resolve(ctx.workingDir, `generated-${Date.now()}.png`);

  const body = JSON.stringify(
    referenceImage
      ? {
          model: imageModel,
          prompt: chosenPrompt,
          image: referenceImage,
          size: imageSize,
          n: 1,
        }
      : {
          model: imageModel,
          prompt: chosenPrompt,
          n: 1,
          size: imageSize,
          response_format: 'b64_json',
        },
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  // Reference-image mode (gpt-image-2 edits) is meaningfully slower than
  // pure text-to-image: the model is reasoning-driven and the request
  // body carries a few MB of base64. The shared 60s budget has to cover
  // both x402 retry attempts plus the actual generation, which made
  // image-to-image effectively always time out. Image-to-image gets 3
  // minutes; text-to-image keeps the original 60s.
  const timeoutMs = referenceImage ? 180_000 : 60_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
        return { output: 'Payment failed. Check wallet balance with: franklin balance', isError: true };
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
      error?: unknown;
      message?: unknown;
    };

    const imageData = result.data?.[0];
    if (!imageData) {
      // Some gateways return 200 with an `error` / `message` field for
      // moderation, quota, or upstream-model failures instead of using
      // HTTP error codes. Without surfacing those, the agent sees only
      // "No image data returned from API" and starts guessing — verified
      // 2026-05-04: agent guessed "gpt-image-2 is forced to 1024x1024
      // per the tool docs" and burned a retry on a size param that
      // wasn't the actual cause. Surface the diagnostic so the agent
      // (or user) can react.
      const bits: string[] = [];
      if (result.error !== undefined) {
        bits.push(`error=${JSON.stringify(result.error).slice(0, 240)}`);
      }
      if (result.message !== undefined) {
        bits.push(`message=${String(result.message).slice(0, 240)}`);
      }
      if (Array.isArray(result.data) && result.data.length === 0) {
        bits.push('data=[] (empty array — likely content moderation)');
      } else if (result.data === undefined) {
        bits.push('data field missing');
      }
      const detail = bits.length > 0 ? ` — ${bits.join('; ')}` : '';
      return { output: `No image data returned from API${detail}`, isError: true };
    }

    // Save image. The /v1/images/image2image endpoint returns Gemini results
    // as a data URI in `url`, so decode those locally instead of going through
    // fetch — saves a network round-trip and avoids data:-URI fetch quirks.
    if (imageData.b64_json) {
      const buffer = Buffer.from(imageData.b64_json, 'base64');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);
    } else if (imageData.url && imageData.url.startsWith('data:')) {
      const match = imageData.url.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) {
        return { output: 'Malformed data URI in response', isError: true };
      }
      const buffer = Buffer.from(match[1], 'base64');
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

    // Stats: record this generation so it shows up in `franklin insights`
    // alongside chat spend. Before this, media generations bypassed
    // recordUsage entirely (only LLM chat calls were tracked), so the
    // insights panel under-reported total spend and never surfaced
    // image-generation models in its "top models" list. Fire-and-forget —
    // stats write must not fail a user-visible generation.
    void (async () => {
      try {
        const m = await findModel(imageModel);
        const estCost = m ? estimateCostUsd(m, { quantity: 1 }) : 0;
        recordUsage(imageModel, 0, 0, estCost, 0);
      } catch { /* ignore stats errors */ }
    })();

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
      return {
        output: referenceImage
          ? 'Image-to-image timed out (180s limit). The reference image may be too large or the model under load — try a smaller image or simpler prompt.'
          : 'Image generation timed out (60s limit). Try a simpler prompt.',
        isError: true,
      };
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
          resourceDescription: details.resource?.description || 'Franklin image generation',
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
          resourceDescription: details.resource?.description || 'Franklin image generation',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
  } catch (err) {
    logger.warn(`[franklin] Image payment error: ${(err as Error).message}`);
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
        "Generate an image from a text prompt — optionally with a reference " +
        "image for style transfer / character consistency / edits. Costs USDC " +
        "from the user's wallet — confirm before generating. Saves to a local " +
        "file. Default size: 1024x1024. Do NOT call repeatedly to iterate on " +
        "style — ask the user first. Pass contentId to attach the result to " +
        "an existing Content piece: the content's budget is checked BEFORE " +
        "paying, and on success the image is recorded as an asset with its " +
        "estimated cost. Skipping contentId generates a one-off image with no " +
        "budget tracking. When image_url is set, only edit-capable models " +
        "(openai/gpt-image-1, openai/gpt-image-2) are accepted.",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the image to generate' },
          output_path: { type: 'string', description: 'Where to save the image. Default: generated-<timestamp>.png in working directory' },
          size: { type: 'string', description: 'Image size: 1024x1024, 1792x1024, or 1024x1792. Default: 1024x1024. Note: openai/gpt-image-2 is forced to 1024x1024 (other sizes time out at the gateway).' },
          model: { type: 'string', description: 'Image model to use. Default: openai/gpt-image-1' },
          image_url: { type: 'string', description: 'Optional reference image (image-to-image / style transfer). Accepts an http(s) URL, a data URI, or a local file path. Only works with edit-capable models.' },
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
