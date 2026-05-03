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
import { loadConfig } from '../commands/config.js';

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

    // User-configured default image model — set via VS Code settings popover
    // or `franklin config set default-image-model <id>`. When set, this is
    // treated like an explicit model arg from the LLM: the per-prompt media
    // router (cheaper / premium proposal flow) is skipped, and we go straight
    // to generation. Reference-image mode falls back to its own edit-capable
    // default if the user's pick isn't on the edit allow-list.
    let userDefaultModel: string | undefined;
    try {
      const cfg = loadConfig();
      const v = cfg['default-image-model'];
      if (v && v !== '__unset__') userDefaultModel = v;
    } catch { /* ignore — config read is best-effort */ }
    if (referenceImage && userDefaultModel && !EDIT_SUPPORTED_MODELS.has(userDefaultModel)) {
      // User's default isn't edit-capable; fall back to the edit default
      // rather than failing — they probably set the default for t2i.
      userDefaultModel = undefined;
    }

    let imageModel =
      model ||
      userDefaultModel ||
      (referenceImage ? 'openai/gpt-image-2' : 'openai/gpt-image-1');
    let imageSize = size || '1024x1024';
    let chosenPrompt = prompt;

    // Skip the proposal flow when a reference image is set: the media router
    // doesn't know which models support image-to-image, so its suggestions
    // would frequently be unusable (text-only models). Default to gpt-image-1
    // for now; a future router upgrade can pick between the four edit-capable
    // models based on the prompt.
    // Also skip when the user set a default-image-model — that's the whole
    // point of the setting: stop asking, just use my pick.
    const autoApprove =
      process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1' ||
      !!userDefaultModel;
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

    // (Was: forced override to 1024x1024 for gpt-image-2 — see v3.9.5 commit
    // 43c58b7. The pin was added when the gateway routing reliably timed out
    // on non-square sizes AFTER x402 settlement, burning user USDC. Removed
    // experimentally on user request to test whether the gateway issue still
    // reproduces. If you see "Image generation timed out" hits at vertical /
    // landscape sizes on gpt-image-2, restore the override.)

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

  // Default output path uses Date.now() — fine for serial calls.
  const outPath = output_path
    ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
    : path.resolve(ctx.workingDir, `generated-${Date.now()}.png`);

  // OpenAI's gpt-image-1 / gpt-image-2 family removed the `response_format`
  // parameter — they always return base64 by default, and including the
  // param makes the gateway reject the call with an empty data array
  // (which surfaces as "No image data returned from API"). Strip it for
  // those models; keep it for DALL-E 3 / cogview / grok-imagine etc. that
  // still honor it.
  const isGptImageFamily = imageModel.startsWith('openai/gpt-image-');
  const t2iBody: Record<string, unknown> = {
    model: imageModel,
    prompt: chosenPrompt,
    n: 1,
    size: imageSize,
  };
  if (!isGptImageFamily) {
    t2iBody['response_format'] = 'b64_json';
  }
  const body = JSON.stringify(
    referenceImage
      ? {
          model: imageModel,
          prompt: chosenPrompt,
          image: referenceImage,
          size: imageSize,
          n: 1,
        }
      : t2iBody,
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };


  const controller = new AbortController();
  // Overall budget covers: initial POST + 402 sign retry + (if async) poll
  // loop. Slow models like openai/gpt-image-2 hit the 30s gateway inline
  // window and degrade to async (returns { id, poll_url } instead of
  // image data); we then have to poll until terminal status. 5 minute
  // ceiling is enough for the slowest current model.
  const timeoutMs = referenceImage ? 300_000 : 180_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // First request — will get 402
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body,
    });

    // Handle x402 payment. Capture the signed headers because they may be
    // needed again for poll-loop GETs (gateway re-validates auth on each
    // poll call to settle on first completed response).
    let signedPaymentHeaders: Record<string, string> | null = null;
    if (response.status === 402) {
      signedPaymentHeaders = await signPayment(response, chain, endpoint);
      if (!signedPaymentHeaders) {
        return { output: 'Payment failed. Check wallet balance with: franklin balance', isError: true };
      }

      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...signedPaymentHeaders },
        body,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { output: `Image generation failed (${response.status}): ${errText.slice(0, 200)}`, isError: true };
    }

    // Read body as text first so we can include the actual gateway response
    // in error messages — "No image data returned" with no further detail
    // makes it impossible to distinguish "model not enabled for this
    // account" from "wrong response shape" from "empty data array".
    const rawBody = await response.text().catch(() => '');
    let result: {
      data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
      error?: unknown;
      // Async path fields: when generation exceeds the 30s inline window,
      // the gateway returns these instead of `data[]` and expects the
      // client to poll the poll_url with the same x-payment header.
      id?: string;
      job_id?: string;
      poll_url?: string;
      status?: string;
      [k: string]: unknown;
    } = {};
    try {
      result = JSON.parse(rawBody);
    } catch {
      return {
        output: `Image generation: gateway returned non-JSON body (${response.status}): ${rawBody.slice(0, 300)}`,
        isError: true,
      };
    }

    // ── Async path: gateway returned a job_id + poll_url because the model
    // ── exceeded the 30s inline window. Poll until terminal state, then
    // ── treat the resolved body as the normal sync response.
    const ASYNC_STATUSES = new Set(['queued', 'pending', 'in_progress', 'processing']);
    const pollUrl = (result.poll_url || '') as string;
    const isAsync =
      response.status === 202 ||
      (!result.data && (pollUrl.length > 0 || (typeof result.status === 'string' && ASYNC_STATUSES.has(result.status))));

    if (isAsync) {
      if (!pollUrl) {
        return {
          output:
            `Image generation entered async mode (status=${result.status ?? '?'}) ` +
            `but the gateway did not return a poll_url. ` +
            `Raw response: ${rawBody.slice(0, 300)}`,
          isError: true,
        };
      }
      const origin = new URL(apiUrl).origin;
      const fullPollUrl = pollUrl.startsWith('http') ? pollUrl : `${origin}${pollUrl}`;
      const pollHeaders = { ...headers, ...(signedPaymentHeaders || {}) };
      const pollOutcome = await pollImageJob(fullPollUrl, pollHeaders, controller.signal);
      if (pollOutcome.kind === 'failed') {
        return {
          output: `Image generation failed during async polling: ${pollOutcome.error || 'unknown error'}`,
          isError: true,
        };
      }
      if (pollOutcome.kind === 'timed_out') {
        return {
          output:
            `Image generation timed out during async polling (~${Math.round(timeoutMs / 1000)}s budget). ` +
            `The job may still complete on the gateway side — try a faster model ` +
            `(openai/gpt-image-1, xai/grok-imagine-image, zai/cogview-4) for next attempt.`,
          isError: true,
        };
      }
      // Replace `result` with the resolved poll body so the rest of the
      // function (image-data extract → save → recordUsage) works unchanged.
      result = pollOutcome.body as typeof result;
    }

    const imageData = result.data?.[0];
    if (!imageData) {
      // Surface the actual response so users / agents can act on it.
      // Common causes: account doesn't have access to the model, the
      // gateway routed to a backend that returned a different shape,
      // or a soft error nested inside a 200 OK.
      const errField = result.error
        ? (typeof result.error === 'string' ? result.error : JSON.stringify(result.error))
        : '';
      const preview = rawBody.length > 400 ? rawBody.slice(0, 400) + '…' : rawBody;
      return {
        output:
          `Image generation returned no image data for ${imageModel}.\n` +
          (errField ? `Gateway error field: ${errField}\n` : '') +
          `Raw response (first 400 chars): ${preview}\n\n` +
          `Common causes: account not granted access to this model, ` +
          `gateway backend returned a non-OpenAI response shape, or a ` +
          `transient backend issue. Try a different image model ` +
          `(openai/gpt-image-1 / xai/grok-imagine-image / zai/cogview-4).`,
        isError: true,
      };
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
          ? 'Image-to-image timed out (300s budget). The reference image may be too large or the model under load — try a smaller image or simpler prompt.'
          : 'Image generation timed out (180s budget). Try a faster model (openai/gpt-image-1, xai/grok-imagine-image, zai/cogview-4) or simpler prompt.',
        isError: true,
      };
    }
    return { output: `Error: ${msg}`, isError: true };
  } finally {
    clearTimeout(timeout);
  }
  };
}

// ─── Async image polling ────────────────────────────────────────────────
// Mirrors videogen's pollUntilReady but tuned for images: shorter intervals
// (images finish faster than videos once async), tighter terminal-state
// detection (image responses don't have status='completed' fields, they
// just gain a populated `data` array on completion).

const IMAGE_POLL_INTERVAL_MS = 3_000;

interface ImagePollBody {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  status?: string;
  error?: string;
  [k: string]: unknown;
}

type ImagePollOutcome =
  | { kind: 'completed'; body: ImagePollBody }
  | { kind: 'failed'; error?: string }
  | { kind: 'timed_out' };

async function pollImageJob(
  pollUrl: string,
  headers: Record<string, string>,
  abortSignal: AbortSignal,
): Promise<ImagePollOutcome> {
  while (true) {
    if (abortSignal.aborted) return { kind: 'timed_out' };

    const resp = await fetch(pollUrl, { method: 'GET', headers, signal: abortSignal });

    if (resp.status === 202 || resp.status === 200) {
      const body = (await resp.json().catch(() => ({}))) as ImagePollBody;
      // Terminal: image data populated.
      if (body.data && body.data.length > 0 && (body.data[0].b64_json || body.data[0].url)) {
        return { kind: 'completed', body };
      }
      // Terminal: explicit failed status.
      if (body.status === 'failed' || (typeof body.error === 'string' && body.error.length > 0)) {
        return { kind: 'failed', error: body.error || 'failed' };
      }
      // Otherwise still pending — sleep and try again.
    } else if (resp.status === 429 || resp.status >= 500) {
      // Transient — back off briefly. Fall through to sleep.
    } else {
      const text = await resp.text().catch(() => '');
      return { kind: 'failed', error: `Poll HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }

    try {
      await imageSleep(IMAGE_POLL_INTERVAL_MS, abortSignal);
    } catch {
      return { kind: 'timed_out' };
    }
  }
}

function imageSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
          size: { type: 'string', description: 'Image size: 1024x1024 (square), 1792x1024 (landscape), 1024x1792 (vertical). Default: 1024x1024. For vertical / landscape, prefer openai/gpt-image-1 — gpt-image-2 historically only served 1024x1024 reliably through the gateway.' },
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
