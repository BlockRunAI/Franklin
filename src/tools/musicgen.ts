/**
 * Music Generation capability — generate ~3-minute MP3 tracks via the
 * BlockRun `/v1/audio/generations` endpoint. Uses x402 payment (Base
 * or Solana) and shares the same pattern as VideoGen.
 *
 * Default model `minimax/music-2.5+` bills $0.1575/call and returns a
 * ~3-minute track regardless of duration hint. Generation takes 1-3
 * minutes — the HTTP connection stays open until the upstream job
 * finishes, so the caller issues a single POST and waits.
 *
 * The generated URL is time-limited (~24h) from the upstream CDN, so
 * the tool downloads the MP3 to disk immediately and stores the local
 * path. Optional contentId integration records the track as a budget-
 * tracked asset on a Content piece.
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
import { logger } from '../logger.js';
import type { ContentLibrary } from '../content/library.js';

interface MusicGenInput {
  prompt: string;
  output_path?: string;
  model?: string;
  instrumental?: boolean;
  lyrics?: string;
  duration_seconds?: number;
  contentId?: string;
}

export interface MusicGenDeps {
  library?: ContentLibrary;
  onContentChange?: () => void | Promise<void>;
}

const DEFAULT_MODEL = 'minimax/music-2.5+';
const PRICE_USD = 0.1575;
// MiniMax generation is 1-3 minutes + small buffer for payment + download.
const GEN_TIMEOUT_MS = 240_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function buildExecute(deps: MusicGenDeps) {
  return async function execute(
    input: Record<string, unknown>,
    ctx: ExecutionScope,
  ): Promise<CapabilityResult> {
    const { prompt, output_path, model, instrumental, lyrics, duration_seconds, contentId } =
      input as unknown as MusicGenInput;

    if (!prompt) return { output: 'Error: prompt is required', isError: true };
    if (instrumental === true && lyrics) {
      return {
        output: 'Error: cannot set both `instrumental: true` and `lyrics` — pick one',
        isError: true,
      };
    }

    const musicModel = model || DEFAULT_MODEL;

    if (contentId && deps.library) {
      const content = deps.library.get(contentId);
      if (!content) {
        return { output: `Content ${contentId} not found. No USDC was spent.` };
      }
      if (content.spentUsd + PRICE_USD > content.budgetUsd + 1e-9) {
        return {
          output:
            `## Music generation skipped\n` +
            `- Would exceed budget: spent $${content.spentUsd.toFixed(2)} + fixed ` +
            `$${PRICE_USD.toFixed(2)} > cap $${content.budgetUsd.toFixed(2)}\n\n` +
            `No USDC was spent.`,
        };
      }
    }

    const chain = loadChain();
    const apiUrl = API_URLS[chain];
    const endpoint = `${apiUrl}/v1/audio/generations`;

    const outPath = output_path
      ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
      : path.resolve(ctx.workingDir, `generated-${Date.now()}.mp3`);

    const body = JSON.stringify({
      model: musicModel,
      prompt,
      ...(instrumental !== undefined ? { instrumental } : {}),
      ...(lyrics ? { lyrics } : {}),
      ...(duration_seconds ? { duration_seconds } : {}),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `franklin/${VERSION}`,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
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
          output: `Music generation failed (${response.status}): ${errText.slice(0, 300)}`,
          isError: true,
        };
      }

      const result = (await response.json()) as {
        data?: { url?: string; duration_seconds?: number; lyrics?: string }[];
      };
      const track = result.data?.[0];
      if (!track?.url) {
        return { output: 'No track URL returned from API', isError: true };
      }

      // CDN URLs expire in ~24h — download NOW.
      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), DOWNLOAD_TIMEOUT_MS);
      const mp3Resp = await fetch(track.url, { signal: dlCtrl.signal });
      clearTimeout(dlTimeout);
      if (!mp3Resp.ok) {
        return {
          output: `Music URL fetched but MP3 download failed (${mp3Resp.status}): ${track.url}`,
          isError: true,
        };
      }
      const buffer = Buffer.from(await mp3Resp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);

      const fileSize = fs.statSync(outPath).size;
      const sizeMB = (fileSize / 1_048_576).toFixed(1);
      const dur = track.duration_seconds ?? 180;
      const lyricsPreview = track.lyrics
        ? `\n\n**Generated lyrics:**\n\n${track.lyrics.slice(0, 600)}${track.lyrics.length > 600 ? '\n...' : ''}`
        : '';

      let contentSummary = '';
      if (contentId && deps.library) {
        const rec = deps.library.addAsset(contentId, {
          kind: 'audio',
          source: musicModel,
          costUsd: PRICE_USD,
          data: outPath,
        });
        if (rec.ok) {
          if (deps.onContentChange) await deps.onContentChange();
          const c = deps.library.get(contentId);
          contentSummary =
            `\n\n## Content updated\n` +
            `- Attached to \`${contentId}\` at est. $${PRICE_USD.toFixed(2)}\n` +
            (c
              ? `- Spent: $${c.spentUsd.toFixed(2)} / $${c.budgetUsd.toFixed(2)} cap ` +
                `(remaining $${(c.budgetUsd - c.spentUsd).toFixed(2)})`
              : '');
        } else {
          contentSummary =
            `\n\n## Content NOT updated\n- ${rec.reason}\n- Track saved locally; ` +
            `cost NOT recorded against the content budget.`;
        }
      }

      return {
        output:
          `Track saved to ${outPath} (${sizeMB}MB, ${dur}s, ${musicModel})\n\n` +
          `Open with: open ${outPath}${lyricsPreview}${contentSummary}`,
      };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('abort')) {
        return {
          output: `Music generation timed out or was aborted (limit ${Math.round(GEN_TIMEOUT_MS / 1000)}s).`,
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

// ─── Payment ───────────────────────────────────────────────────────

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
          resourceDescription: details.resource?.description || 'Franklin music generation',
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
        resourceDescription: details.resource?.description || 'Franklin music generation',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] Music payment error: ${(err as Error).message}`);
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

// ─── Export ────────────────────────────────────────────────────────

export function createMusicGenCapability(deps: MusicGenDeps = {}): CapabilityHandler {
  return {
    spec: {
      name: 'MusicGen',
      description:
        "Generate a ~3-minute MP3 track from a text prompt (plus optional " +
        "lyrics or instrumental flag). Calls BlockRun's /v1/audio/generations. " +
        "Costs $0.1575 USDC per call — bills a flat rate, MiniMax ignores " +
        "duration hints and always returns ~3 min. Generation takes 1–3 " +
        "minutes. ALWAYS confirm with the user before calling — music is " +
        "expensive and slow. Pass contentId to attach to a Content piece " +
        "(budget is checked before paying).",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Music style / mood / description' },
          output_path: { type: 'string', description: 'Where to save the MP3. Default: generated-<timestamp>.mp3' },
          model: { type: 'string', description: 'Music model. Default: minimax/music-2.5+' },
          instrumental: { type: 'boolean', description: 'No vocals. Cannot combine with `lyrics`.' },
          lyrics: { type: 'string', description: 'Custom lyrics. Cannot combine with `instrumental: true`.' },
          duration_seconds: { type: 'number', description: 'Duration hint (ignored by MiniMax — always ~3 min).' },
          contentId: { type: 'string', description: 'Optional Content id to attach and budget against.' },
        },
        required: ['prompt'],
      },
    },
    execute: buildExecute(deps),
    concurrent: false,
  };
}

export const musicGenCapability: CapabilityHandler = createMusicGenCapability();
