/**
 * Video Generation capability — generate short MP4 videos via the BlockRun
 * /v1/videos/generations endpoint. Uses x402 payment (Base or Solana).
 *
 * Default model `xai/grok-imagine-video` returns an 8-second clip for ~$0.42.
 * The endpoint is synchronous-over-polling: the HTTP connection stays open
 * until the upstream xAI job finishes (typically 20–60s, timeout 180s), so
 * the caller only needs to issue a single POST.
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
import { ModelClient } from '../agent/llm.js';
import { analyzeMediaRequest, renderProposalForAskUser } from '../agent/media-router.js';

interface VideoGenInput {
  prompt: string;
  output_path?: string;
  model?: string;
  image_url?: string;
  duration_seconds?: number;
  contentId?: string;
}

export interface VideoGenDeps {
  library?: ContentLibrary;
  onContentChange?: () => void | Promise<void>;
}

const DEFAULT_MODEL = 'xai/grok-imagine-video';
const DEFAULT_DURATION = 8;
const PRICE_PER_SECOND_USD = 0.05;
// Long ceiling — the endpoint synchronously waits for xAI's async job (up to
// ~180s). Give ourselves a bit of headroom for the GCS backup + settle step.
const GEN_TIMEOUT_MS = 210_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function estimateVideoCostUsd(durationSeconds = DEFAULT_DURATION): number {
  return Math.max(1, durationSeconds) * PRICE_PER_SECOND_USD;
}

function buildExecute(deps: VideoGenDeps) {
  return async function execute(
    input: Record<string, unknown>,
    ctx: ExecutionScope,
  ): Promise<CapabilityResult> {
    const { prompt, output_path, model, image_url, duration_seconds, contentId } =
      input as unknown as VideoGenInput;

    if (!prompt) return { output: 'Error: prompt is required', isError: true };

    const userDefaultVideo = loadConfig()['default-video-model'];
    let videoModel = model || userDefaultVideo || DEFAULT_MODEL;
    let duration = duration_seconds ?? DEFAULT_DURATION;

    // ── Media router + AskUser flow (video bills per second, always ask) ──
    // Skip cost preview when caller named a model OR user has set a default.
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!model && !userDefaultVideo && !autoApprove && ctx.onAskUser) {
      try {
        const chain = loadChain();
        const client = new ModelClient({ apiUrl: API_URLS[chain], chain });
        const proposal = await analyzeMediaRequest({
          kind: 'video',
          prompt,
          durationSeconds: duration_seconds,
          client,
          signal: ctx.abortSignal,
        });
        if (proposal) {
          const { question, options } = renderProposalForAskUser(proposal, prompt);
          const labels = options.map(o => o.label);
          const answer = await ctx.onAskUser(question, labels);
          const chosen = options.find(o => o.label === answer) ?? { id: 'cancel' };
          switch (chosen.id) {
            case 'cheaper':
              videoModel = proposal.cheaper?.model ?? proposal.recommended.model;
              break;
            case 'premium':
              videoModel = proposal.premium?.model ?? proposal.recommended.model;
              break;
            case 'cancel':
              return {
                output: `## Video generation cancelled\n\nNo USDC was spent.`,
              };
            case 'recommended':
            default:
              videoModel = proposal.recommended.model;
          }
          // Use the proposal's duration — the router honored the user's
          // duration_seconds or filled in the model's default.
          if (proposal.durationSeconds) duration = proposal.durationSeconds;
        }
      } catch {
        // Router / AskUser failed — fall through to legacy default.
      }
    }

    const estCost = estimateVideoCostUsd(duration);

    if (contentId && deps.library) {
      const content = deps.library.get(contentId);
      if (!content) {
        return { output: `Content ${contentId} not found. No USDC was spent.` };
      }
      if (content.spentUsd + estCost > content.budgetUsd + 1e-9) {
        return {
          output:
            `## Video generation skipped\n` +
            `- Would exceed budget: spent $${content.spentUsd.toFixed(2)} + estimated ` +
            `$${estCost.toFixed(2)} > cap $${content.budgetUsd.toFixed(2)}\n\n` +
            `No USDC was spent.`,
        };
      }
    }

    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const endpoint = `${apiUrl}/v1/videos/generations`;

    const outPath = output_path
      ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
      : path.resolve(ctx.workingDir, `generated-${Date.now()}.mp4`);

    const body = JSON.stringify({
      model: videoModel,
      prompt,
      ...(image_url ? { image_url } : {}),
      ...(duration_seconds ? { duration_seconds } : {}),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `franklin/${VERSION}`,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
    // Abort on user cancel too
    const onAbort = () => controller.abort();
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      let response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body,
      });

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
        return {
          output: `Video generation failed (${response.status}): ${errText.slice(0, 300)}`,
          isError: true,
        };
      }

      const result = (await response.json()) as {
        data?: { url?: string; source_url?: string; duration_seconds?: number; request_id?: string }[];
      };
      const videoData = result.data?.[0];
      if (!videoData?.url) {
        return { output: 'No video URL returned from API', isError: true };
      }

      // Download the MP4
      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), DOWNLOAD_TIMEOUT_MS);
      const vidResp = await fetch(videoData.url, { signal: dlCtrl.signal });
      clearTimeout(dlTimeout);
      if (!vidResp.ok) {
        return { output: `Video fetched URL but download failed (${vidResp.status}): ${videoData.url}`, isError: true };
      }
      const buffer = Buffer.from(await vidResp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);

      const fileSize = fs.statSync(outPath).size;
      const sizeMB = (fileSize / 1_048_576).toFixed(1);
      const dur = videoData.duration_seconds ?? duration;

      let contentSummary = '';
      if (contentId && deps.library) {
        const rec = deps.library.addAsset(contentId, {
          kind: 'video',
          source: videoModel,
          costUsd: estimateVideoCostUsd(dur),
          data: outPath,
        });
        if (rec.ok) {
          if (deps.onContentChange) await deps.onContentChange();
          const c = deps.library.get(contentId);
          contentSummary =
            `\n\n## Content updated\n` +
            `- Attached to \`${contentId}\` at est. $${estimateVideoCostUsd(dur).toFixed(2)}\n` +
            (c
              ? `- Spent: $${c.spentUsd.toFixed(2)} / $${c.budgetUsd.toFixed(2)} cap ` +
                `(remaining $${(c.budgetUsd - c.spentUsd).toFixed(2)})`
              : '');
        } else {
          contentSummary =
            `\n\n## Content NOT updated\n` +
            `- ${rec.reason}\n` +
            `- The video was generated and saved locally; cost was NOT recorded ` +
            `against the content budget.`;
        }
      }

      return {
        output:
          `Video saved to ${outPath} (${sizeMB}MB, ${dur}s, ${videoModel})\n\n` +
          `Open with: open ${outPath}${contentSummary}`,
      };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('abort')) {
        return {
          output: `Video generation timed out or was aborted (limit ${Math.round(GEN_TIMEOUT_MS / 1000)}s).`,
          isError: true,
        };
      }
      return { output: `Error: ${msg}`, isError: true };
    } finally {
      clearTimeout(timeout);
      ctx.abortSignal.removeEventListener('abort', onAbort);
    }
  };
}

// ─── Payment ───────────────────────────────────────────────────────────────

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
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
          resourceDescription: details.resource?.description || 'Franklin video generation',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
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
        resourceDescription: details.resource?.description || 'Franklin video generation',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    console.error(`[franklin] Video payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* ignore */ }
  }
  return header;
}

// ─── Export ────────────────────────────────────────────────────────────────

export function createVideoGenCapability(deps: VideoGenDeps = {}): CapabilityHandler {
  return {
    spec: {
      name: 'VideoGen',
      description:
        "Generate a short MP4 video from a text prompt (optional seed image). " +
        "Calls BlockRun's /v1/videos/generations. Costs USDC — default model " +
        "xai/grok-imagine-video bills $0.05/s (8s default ≈ $0.42). Generation " +
        "takes ~20–60s. ALWAYS confirm with the user before calling — videos " +
        "are expensive and slow. Pass contentId to attach to a Content piece " +
        "(budget is checked before paying; asset is recorded on success).",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the video to generate' },
          output_path: { type: 'string', description: 'Where to save the MP4. Default: generated-<timestamp>.mp4 in working directory' },
          model: { type: 'string', description: 'Video model. Default: xai/grok-imagine-video' },
          image_url: { type: 'string', description: 'Optional seed image URL (image-to-video)' },
          duration_seconds: { type: 'number', description: 'Duration billed for. Default depends on model (8s for grok-imagine-video).' },
          contentId: { type: 'string', description: 'Optional Content id to attach and budget against.' },
        },
        required: ['prompt'],
      },
    },
    execute: buildExecute(deps),
    concurrent: false,
  };
}

export const videoGenCapability: CapabilityHandler = createVideoGenCapability();
