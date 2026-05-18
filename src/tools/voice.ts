/**
 * Outbound AI voice calls via Bland.ai through the BlockRun `/v1/voice/*`
 * gateway. Two tools:
 *
 *  - VoiceCall   — POST /v1/voice/call ($0.54 flat, up to 5 min default).
 *                  Returns call_id immediately; the call runs async upstream.
 *  - VoiceStatus — GET  /v1/voice/call/{call_id} (free). Polls for transcript
 *                  + recording + final disposition.
 *
 * Voice calls require a wallet-owned BlockRun phone number as caller ID —
 * use BuyPhoneNumber (or ListPhoneNumbers if one already exists) before
 * calling VoiceCall, otherwise the gateway returns 400 with the buy
 * instructions inline.
 *
 * x402 payment flow mirrors src/tools/exa.ts.
 */

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
import { recordUsage } from '../stats/tracker.js';
import { CallLog, type CallStatus } from '../phone/call-log.js';

/** Singleton, lazy — paths are computed at first use so tests can stub homedir. */
let _callLog: CallLog | null = null;
function callLog(): CallLog {
  if (!_callLog) _callLog = new CallLog();
  return _callLog;
}

/**
 * Normalize whatever string Bland.ai returns as `status` (or `disposition` /
 * `call_state` — the field name has drifted across upstream versions) into
 * the CallStatus union our journal stores. Unknown / missing → 'queued' so
 * the row still gets written and a later poll can refine it.
 */
function normalizeStatus(raw: unknown): CallStatus {
  if (typeof raw !== 'string') return 'queued';
  const s = raw.toLowerCase().trim();
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'busy') return 'busy';
  if (s === 'no-answer' || s === 'no_answer' || s === 'noanswer') return 'no-answer';
  if (s === 'voicemail') return 'voicemail';
  if (s === 'in-progress' || s === 'in_progress' || s === 'inprogress' || s === 'ringing') return 'in_progress';
  return 'queued';
}

const VOICE_TIMEOUT_MS = 30_000;

// ─── Shared x402 helpers (paid POST + free GET) ───────────────────────────

interface PaidCallMeta {
  /** Tool name shown in the status bar / audit tab (e.g. "VoiceCall"). */
  tool: string;
  /** USD amount the gateway charges on success. 0 for free routes (VoiceStatus). */
  priceUsd: number;
}

async function postWithPayment<T>(
  path: string,
  body: unknown,
  ctx: ExecutionScope,
  meta: PaidCallMeta,
): Promise<T> {
  const startMs = Date.now();
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const endpoint = `${apiUrl}${path}`;
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: bodyStr,
    });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) throw new Error('Payment signing failed — check wallet balance');
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
        body: bodyStr,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Voice ${path} failed (${response.status}): ${errText.slice(0, 400)}`);
    }
    const data = (await response.json()) as T;
    // Telemetry — record the cost so the status bar's per-turn delta reflects
    // real x402 spend (not just LLM cost). Best-effort; never block on failure.
    try {
      recordUsage(meta.tool, 0, 0, meta.priceUsd, Date.now() - startMs);
    } catch { /* telemetry best-effort */ }
    return data;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function getNoPayment<T>(path: string, ctx: ExecutionScope, meta: PaidCallMeta): Promise<T> {
  const startMs = Date.now();
  const chain = loadChain();
  const apiUrl = API_URLS[chain];
  const endpoint = `${apiUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': `franklin/${VERSION}` },
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Voice ${path} failed (${resp.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as T;
    // Record even free calls so the audit tab shows the activity (cost 0).
    try {
      recordUsage(meta.tool, 0, 0, meta.priceUsd, Date.now() - startMs);
    } catch { /* telemetry best-effort */ }
    return data;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

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
          resourceDescription: details.resource?.description || 'Franklin voice call',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
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
        resourceDescription: details.resource?.description || 'Franklin voice call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] Voice payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* not JSON */ }
  }
  return header;
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export const voiceCallCapability: CapabilityHandler = {
  spec: {
    name: 'VoiceCall',
    description:
      'Make an outbound AI-powered phone call via Bland.ai. The AI agent on the other end ' +
      'follows the `task` description in natural language. Cost: $0.54 flat per call (up to 5 min ' +
      'default, 30 min max). Returns a call_id immediately; the call runs asynchronously. Use ' +
      'VoiceStatus with the same call_id to poll transcript / recording / disposition.\n\n' +
      'Common use cases: appointment reminders, verification callbacks, voice surveys, customer ' +
      'outreach, OTP retrieval, two-party verification calls.\n\n' +
      'Requirements:\n' +
      '  - `from` MUST be a wallet-owned BlockRun phone number — use ListPhoneNumbers to find ' +
      'one or BuyPhoneNumber to provision one ($5, 30-day lease).\n' +
      '  - `to` and `from` must be E.164 format (+ country code prefix, e.g. +14155552671).\n' +
      '  - `task` must be ≥10 chars, ≤4000 chars.\n' +
      '  - US/CA destinations only.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format, e.g. +14155552671.',
        },
        from: {
          type: 'string',
          description:
            'Caller ID — must be a phone number your wallet owns via BlockRun (provision with ' +
            'BuyPhoneNumber). E.164 format.',
        },
        task: {
          type: 'string',
          description:
            'Natural-language description of what the AI should do on the call. Min 10 chars, ' +
            'max 4000. Example: "Greet the person, confirm their 3 pm appointment for Thursday, ' +
            'and ask if they need to reschedule. Speak warmly and end the call after confirmation."',
        },
        voice: {
          type: 'string',
          enum: ['nat', 'josh', 'maya', 'june', 'paige', 'derek', 'florian'],
          description:
            'Voice preset (default: maya). Try josh/derek for male voices, maya/june/paige for ' +
            'female, nat for neutral.',
        },
        max_duration: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Maximum call length in minutes (1–30, default: 5).',
        },
        language: {
          type: 'string',
          description: 'Language code for STT/TTS (default: en-US). Bland supports zh-CN, es-ES, etc.',
        },
        first_sentence: {
          type: 'string',
          description: 'Optional fixed opening line spoken before the AI takes over (≤500 chars).',
        },
        wait_for_greeting: {
          type: 'boolean',
          description: 'If true, AI waits for the recipient to speak first before talking.',
        },
      },
      required: ['to', 'from', 'task'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.to !== 'string') return { output: 'to (E.164) required', isError: true };
    if (typeof input.from !== 'string') return { output: 'from (wallet-owned E.164) required — use ListPhoneNumbers / BuyPhoneNumber', isError: true };
    if (typeof input.task !== 'string' || input.task.length < 10) {
      return { output: 'task required (10–4000 chars natural-language description)', isError: true };
    }

    const body: Record<string, unknown> = {
      to: input.to,
      from: input.from,
      task: input.task,
    };
    // The gateway validates additionalProperties: false — only forward known
    // optional fields, don't echo back whatever the caller passed.
    if (typeof input.voice === 'string') body.voice = input.voice;
    if (typeof input.max_duration === 'number') body.max_duration = input.max_duration;
    if (typeof input.language === 'string') body.language = input.language;
    if (typeof input.first_sentence === 'string') body.first_sentence = input.first_sentence;
    if (typeof input.wait_for_greeting === 'boolean') body.wait_for_greeting = input.wait_for_greeting;

    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/voice/call', body, ctx, { tool: 'VoiceCall', priceUsd: 0.54 },
      );
      const callId = (res.call_id || res.id) as string | undefined;
      // Persist a "queued" row so the panel sees the call before VoiceStatus polls.
      // Best-effort — if disk write fails we still surface the call_id to the agent.
      if (callId) {
        try {
          callLog().append({
            timestamp: Date.now(),
            call_id: callId,
            to: String(input.to),
            from: String(input.from),
            task: String(input.task),
            voice: typeof input.voice === 'string' ? input.voice : undefined,
            max_duration_min: typeof input.max_duration === 'number' ? input.max_duration : undefined,
            language: typeof input.language === 'string' ? input.language : undefined,
            status: normalizeStatus(res.status),
            paid_usd: 0.54,
            tx_hash: typeof res.tx_hash === 'string' ? res.tx_hash : undefined,
          });
        } catch { /* best-effort */ }
      }
      return {
        output:
          `## Voice call initiated ($0.54 USDC charged)\n\n` +
          (callId
            ? `**call_id:** \`${callId}\`\n\nPoll with VoiceStatus call_id="${callId}" to get the ` +
              `transcript and disposition. The call typically completes in 1–6 minutes.\n\n`
            : '') +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Voice call failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const voiceStatusCapability: CapabilityHandler = {
  spec: {
    name: 'VoiceStatus',
    description:
      'Poll a previously-initiated voice call for its current status, transcript, recording URL, ' +
      'and final disposition (completed / failed / no-answer / busy / voicemail). Free — no USDC ' +
      'charged. Use the call_id returned by VoiceCall. Call this every 30–60 s until status is ' +
      'a terminal state.',
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'The call_id returned by a prior VoiceCall.',
        },
      },
      required: ['call_id'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.call_id !== 'string') {
      return { output: 'call_id required', isError: true };
    }
    try {
      const res = await getNoPayment<Record<string, unknown>>(
        `/v1/voice/call/${encodeURIComponent(input.call_id)}`,
        ctx,
        { tool: 'VoiceStatus', priceUsd: 0 },
      );
      // Patch the local journal with whatever fields the gateway returned —
      // transcript / recording / duration / disposition. Append-only schema
      // means we just write a new row; CallLog.summary() picks the latest.
      try {
        const prior = callLog().byCallId(input.call_id);
        if (prior) {
          const recording =
            typeof res.recording_url === 'string' ? res.recording_url :
            typeof res.recording === 'string' ? res.recording : undefined;
          const duration =
            typeof res.call_length === 'number' ? Math.round(res.call_length) :
            typeof res.duration === 'number' ? Math.round(res.duration) :
            typeof res.duration_sec === 'number' ? Math.round(res.duration_sec) : undefined;
          const transcript =
            typeof res.concatenated_transcript === 'string' ? res.concatenated_transcript :
            typeof res.transcript === 'string' ? res.transcript : undefined;
          callLog().append({
            ...prior,
            timestamp: Date.now(),
            paid_usd: prior.paid_usd, // status polls are free; preserve the per-call total
            status: normalizeStatus(res.status ?? res.queue_status ?? res.disposition),
            duration_sec: duration ?? prior.duration_sec,
            transcript: transcript ?? prior.transcript,
            recording_url: recording ?? prior.recording_url,
          });
        }
      } catch { /* best-effort */ }
      return {
        output:
          `## Voice call status\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `VoiceStatus failed: ${(err as Error).message}`, isError: true };
    }
  },
};
