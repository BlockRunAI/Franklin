/**
 * Modal Sandbox capabilities — spin up GPU/CPU compute on Modal Labs via the
 * BlockRun gateway's x402-paid passthrough at /v1/modal/sandbox/{create, exec,
 * status, terminate}. See https://modal.com/docs/guide/sandboxes for the
 * underlying primitives.
 *
 * Pricing (per-call, USDC; the Base gateway adds a $0.001 transaction fee):
 *   create with timeout <= 300s, cpu <= 1 and memory <= 1024 MB (flat):
 *     $0.01 (CPU) / $0.05 (T4) / $0.08 (L4) / $0.10 (A10G) / $0.20 (A100) / $0.40 (H100)
 *   any other create: hourly rate x the full requested lifetime, upfront, never
 *   below the flat rate, no refund on early terminate:
 *     $0.25 (CPU) / $4 (T4) / $4.50 (L4) / $5 (A10G) / $7 (A100) / $9 (H100) per hour
 *   exec: $0.001
 *   status: $0.001
 *   terminate: $0.001
 *
 * Gateway constraints (probed 2026-05-02; lifetime re-probed 2026-11-13):
 *   - sandbox lifetime (create `timeout`): 10..86400 s (24 h). 86401 -> 400 on
 *     sol.blockrun.ai and blockrun.ai; 86400 -> 402 with a quote.
 *   - cpu >= 0.125 (Modal's own default; below that the Solana gateway 400s).
 *   - image is fixed at python:3.11 — no custom containers yet.
 *   - command is execve-style (string[]), not a shell string. We accept a
 *     plain string from the LLM and auto-wrap to ["sh","-c", string].
 *   - No stdin / env / workdir / streaming on exec — keep commands self-
 *     contained and idempotent.
 *   - No upload/download endpoints — files in/out via exec heredoc / curl.
 *
 * Lifecycle:
 *   ModalCreate → returns sandbox_id, charged at GPU tier
 *   ModalExec   → sync, returns { stdout, stderr, exit_code }
 *   ModalStatus → check running/terminated
 *   ModalTerminate → release; called automatically at session end via
 *                    the SessionSandboxTracker registry.
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
import { loadChain, VERSION, DASHBOARD_URL, type Chain } from '../config.js';
import { gatewayBase, gatewayHeaders, isKeyMode, walletMayPay } from '../payments/auth-mode.js';
import { walletReservation, AMBIGUOUS_GRACE_MS, type ReservationToken } from '../wallet/reservation.js';
import { recordUsage } from '../stats/tracker.js';
import { logger } from '../logger.js';
import { noChargeNote } from '../payments/billing-copy.js';
import { GATEWAY_TRANSACTION_FEE_USD } from '../gateway-models.js';

// ─── Pricing table (probed from /.well-known/x402 + 402 responses) ─────────
const CREATE_PRICE_USD: Record<string, number> = {
  cpu: 0.01,
  T4: 0.05,
  L4: 0.08,
  A10G: 0.10,
  A100: 0.20,
  H100: 0.40,
};
// The gateway bills every create outside the flat tier by the hour for its whole
// requested lifetime. Keep in step with getModalCreatePricing in the gateway's
// src/lib/modal.ts (sol, arc and nano carry these rates; the Base gateway's are
// lower, so these never under-reserve there). The quote guard in
// postWithPayment refuses to sign anything above this table, so a gateway price
// rise surfaces as a clear refusal rather than a silent over-charge.
const HOURLY_PRICE_USD: Record<string, number> = {
  cpu: 0.25,
  T4: 4.00,
  L4: 4.50,
  A10G: 5.00,
  A100: 7.00,
  H100: 9.00,
};
const FLAT_RATE_MAX_CPU = 1;
const FLAT_RATE_MAX_MEMORY_MB = 1024;
const FLAT_RATE_MAX_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 300;
/** Gateway bounds on create `timeout` (sol and base probed 2026-11-13; arc and nano share the schema). */
export const MODAL_MIN_TIMEOUT_SECONDS = 10;
export const MODAL_MAX_TIMEOUT_SECONDS = 86_400;
export const MODAL_MIN_CPU = 0.125;
/**
 * Per-call transaction fee the Base gateway adds to every quote (the Solana
 * gateway charges none). The quote guard allows it on top of the list price.
 */
const QUOTE_FEE_ALLOWANCE_USD = GATEWAY_TRANSACTION_FEE_USD;

export interface ModalCreatePricing {
  priceUsd: number;
  model: 'flat' | 'hourly';
  /** Set when model === 'hourly'. */
  hourlyRateUsd?: number;
}

/**
 * What the gateway will ask for this create — mirrors getModalCreatePricing.
 * Flat only when the lifetime is <= 300 s AND the size is <= 1 CPU / 1024 MB;
 * anything else is hourly x the full requested lifetime, floored at the flat
 * rate. The reservation, the quote ceiling and the confirm dialog all read it.
 */
export function modalCreatePricing(
  tier: string,
  cpu?: number,
  memory?: number,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
): ModalCreatePricing {
  const flat = CREATE_PRICE_USD[tier];
  const flatEligible =
    timeoutSeconds <= FLAT_RATE_MAX_SECONDS &&
    (cpu ?? 1) <= FLAT_RATE_MAX_CPU &&
    (memory ?? 512) <= FLAT_RATE_MAX_MEMORY_MB;
  if (!flatEligible) {
    const hourlyRateUsd = HOURLY_PRICE_USD[tier];
    const hourlyPrice = hourlyRateUsd * (timeoutSeconds / 3600);
    if (hourlyPrice > flat) return { priceUsd: hourlyPrice, model: 'hourly', hourlyRateUsd };
  }
  return { priceUsd: flat, model: 'flat' };
}

export function modalCreatePriceUsd(
  tier: string,
  cpu?: number,
  memory?: number,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
): number {
  return modalCreatePricing(tier, cpu, memory, timeoutSeconds).priceUsd;
}

/**
 * The most this client will sign for a call listed at `listPriceUsd`: the list
 * price plus the Base transaction fee, rounded UP to USDC's 6 decimals, plus
 * one atomic unit for the gateway's own round-up of an hourly quote. Returned
 * in atomic units (1 USDC = 1_000_000).
 */
export function maxSignableAtomic(listPriceUsd: number): bigint {
  // Round the micro-dollar figure to 3 places first so float noise
  // (0.1 + 0.001 = 0.10100000000000001) does not ceil an exact figure up a unit.
  const micro = Math.ceil(Number(((listPriceUsd + QUOTE_FEE_ALLOWANCE_USD) * 1e6).toFixed(3)));
  return BigInt(micro) + 1n;
}

/** The ceiling as dollars — what the wallet reservation holds. */
export function maxSignableUsd(listPriceUsd: number): number {
  return Number(maxSignableAtomic(listPriceUsd)) / 1e6;
}

const EXEC_PRICE_USD = 0.001;
const STATUS_PRICE_USD = 0.001;
const TERMINATE_PRICE_USD = 0.001;

const VALID_GPUS = new Set(Object.keys(CREATE_PRICE_USD).filter(g => g !== 'cpu'));

// ─── Session sandbox tracker ───────────────────────────────────────────────
// In-memory registry of sandboxes created in the current session. Used by
// (1) the cleanup hook in vscode-session.ts to terminate orphans on session
// end, (2) the extension UI's "active sandboxes" badge.
//
// NOT persisted — sandboxes outlive the Franklin process via Modal's own
// timeout, so a missed cleanup is bounded by the user-set `timeout`.

export interface SandboxRecord {
  id: string;
  gpu: string; // 'cpu' | 'T4' | ... — denormalized for cost display
  createdAt: number;
  timeoutSeconds?: number;
}

class SessionSandboxTracker {
  private sandboxes = new Map<string, SandboxRecord>();

  add(rec: SandboxRecord): void {
    this.sandboxes.set(rec.id, rec);
  }

  remove(id: string): void {
    this.sandboxes.delete(id);
  }

  list(): SandboxRecord[] {
    return [...this.sandboxes.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Snapshot then clear — used by the session cleanup hook. */
  drainIds(): string[] {
    const ids = [...this.sandboxes.keys()];
    this.sandboxes.clear();
    return ids;
  }
}

export const sessionSandboxTracker = new SessionSandboxTracker();

// ─── x402 payment signing — same shape as imagegen's helper ───────────────

/** Indirection so tests can stub the signer without a funded wallet. */
let paymentSigner: typeof signPayment = (...args) => signPayment(...args);
export function _setPaymentSignerForTests(fn: typeof signPayment | null): void {
  paymentSigner = fn ?? ((...args) => signPayment(...args));
}

async function signPayment(
  response: Response,
  chain: Chain,
  endpoint: string,
  resourceDescription: string,
): Promise<Record<string, string> | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;

    // maxTimeoutSeconds below is the x402 authorization validity window the 402
    // quotes (300 s), NOT the sandbox lifetime: a 24 h create still settles
    // within seconds of signing, so it needs no change for long lifetimes.
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
          resourceDescription: details.resource?.description || resourceDescription,
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
          resourceDescription: details.resource?.description || resourceDescription,
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
  } catch (err) {
    logger.warn(`[franklin] Modal payment error: ${(err as Error).message}`);
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

/**
 * The amount (atomic USDC) a 402 asks for, picked the same way signPayment
 * picks its option. Null when the 402 carries no readable quote.
 */
async function quotedAtomic(response: Response, chain: Chain): Promise<bigint | null> {
  try {
    const header = await extractPaymentReq(response.clone());
    if (!header) return null;
    const details = extractPaymentDetails(
      parsePaymentRequired(header),
      chain === 'solana' ? SOLANA_NETWORK : undefined,
    );
    const amount = String(details.amount ?? '');
    return /^\d+$/.test(amount) ? BigInt(amount) : null;
  } catch {
    return null;
  }
}

function atomicToUsd(n: bigint): string {
  return `$${(Number(n) / 1e6).toFixed(6)}`;
}

/**
 * Generic POST-with-x402-retry helper used by all four Modal endpoints. The
 * first POST gets a 402 with payment requirements; we sign and retry once
 * with the X-PAYMENT header. Returns the parsed JSON body and the raw
 * Response (callers may need status code).
 *
 * `reservation` is the caller's wallet hold for this call. If the signed
 * (paid) request has been dispatched and the call then aborts or times out
 * before a response, or the response arrives but its body is cut off, the
 * outcome is ambiguous — the gateway may already have settled the payment.
 * The hold is marked ambiguous so the reservation layer keeps counting it
 * (see reservation.ts) instead of the caller's `finally` releasing it as if
 * nothing was spent. Failures that provably never left this machine (signal
 * already aborted before dispatch, DNS / connection-refused) are NOT
 * ambiguous and release normally.
 *
 * `maxPriceUsd` is the list price this client expects for the call. When set,
 * the 402's quote is checked BEFORE anything is signed: above
 * maxSignableAtomic(maxPriceUsd), or unreadable, and nothing is signed or
 * sent — the call returns 402 with `quote_exceeds_expected`. Without it a
 * gateway quoting a long-lifetime create at $216 would be signed blind while
 * the reservation held a fraction of that.
 */
export async function postWithPayment(
  endpoint: string,
  body: Record<string, unknown>,
  resourceDescription: string,
  abortSignal: AbortSignal,
  timeoutMs: number,
  reservation?: ReservationToken | null,
  maxPriceUsd?: number,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; raw: string }> {
  const chain = loadChain();
  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  abortSignal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let paymentDispatched = false;

  try {
    const payload = JSON.stringify(body);
    let response = await fetch(endpoint, { method: 'POST', signal: ctrl.signal, headers, body: payload });

    if (response.status === 402 && walletMayPay(headers)) {
      if (maxPriceUsd !== undefined) {
        const quoted = await quotedAtomic(response, chain);
        const ceiling = maxSignableAtomic(maxPriceUsd);
        if (quoted === null || quoted > ceiling) {
          const error = quoted === null
            ? 'quote_exceeds_expected: the 402 carried no readable amount, so nothing was signed'
            : `quote_exceeds_expected: the gateway asked ${atomicToUsd(quoted)}, above the ` +
              `${atomicToUsd(ceiling)} this client expected, so nothing was signed`;
          logger.warn(`[franklin] Modal ${endpoint}: ${error}`);
          return { ok: false, status: 402, body: { error }, raw: '' };
        }
      }
      const paymentHeaders = await paymentSigner(response, chain, endpoint, resourceDescription);
      if (!paymentHeaders) {
        return { ok: false, status: 402, body: { error: 'payment signing failed' }, raw: '' };
      }
      // Signing can take a while (wallet load, Solana RPC). If the budget
      // expired meanwhile, fetch rejects before writing a byte — that is a
      // definite non-payment, not an ambiguous one.
      if (ctrl.signal.aborted) throw signalError(ctrl.signal);
      paymentDispatched = true;
      response = await fetch(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { ...headers, ...paymentHeaders },
        body: payload,
      });
    }

    let raw = '';
    try {
      raw = await response.text();
    } catch (err) {
      // A paid 2xx whose body was cut off (abort mid-stream) is still a
      // settled payment with an unknown result — e.g. a sandbox we were never
      // told the id of. Surface it instead of returning ok:true with {}.
      if (paymentDispatched) throw err;
    }
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave as {} */ }
    return { ok: response.ok, status: response.status, body: parsed, raw };
  } catch (err) {
    if (paymentDispatched && reservation && !definitelyNotSent(err)) {
      // Signed request went out; abort/timeout hit before we saw the result.
      // Money may be gone — keep the hold counted rather than releasing it.
      // Window = this call's own timeout (the gateway may still be running
      // the paid work and settle when it finishes) + settlement margin.
      walletReservation.markAmbiguous(reservation, timeoutMs + AMBIGUOUS_GRACE_MS);
      logger.warn(
        `[franklin] Modal payment outcome ambiguous (${(err as Error).message}); ` +
        `holding ${reservation.amountUsd.toFixed(4)} USDC reservation until balance refresh`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', onParentAbort);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Explain why hold() refused, so the agent does not loop on "wait". */
function describeHeadroom(): string {
  const snap = walletReservation.snapshot();
  const parts: string[] = [];
  if (snap.count > 0) parts.push(`${snap.count} in-flight paid call(s) hold ${fmtUsd(snap.totalUsd - snap.ambiguousUsd)}`);
  if (snap.ambiguousCount > 0) {
    parts.push(
      `${fmtUsd(snap.ambiguousUsd)} is held for ${snap.ambiguousCount} recent payment(s) whose settlement is ` +
      `unconfirmed (released automatically after the on-chain balance refreshes)`,
    );
  }
  // In key mode there is no wallet to fund — the ceiling is the prepaid
  // balance, so send the user to the right place.
  const topUp = isKeyMode()
    ? `Top up account credits at ${DASHBOARD_URL}.`
    : 'Fund the wallet.';
  if (parts.length === 0) return topUp;
  return parts.join('; ') + ` — wait for those to clear, or ${topUp[0].toLowerCase()}${topUp.slice(1)}`;
}

function signalError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Errors whose cause proves the request never reached the network: the
 * payment cannot have settled, so the reservation should release normally.
 * Anything else after dispatch (abort, timeout, reset, unknown) errs tight.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_INVALID_URL']);
function definitelyNotSent(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  return NOT_SENT_CODES.has(code);
}

function modalEndpoint(path: string): string {
  const chain = loadChain();
  return `${gatewayBase()}/v1/modal/sandbox/${path}`;
}

/**
 * Normalize the agent's `command` input into the execve-style array Modal
 * expects. LLMs frequently pass a shell string ("pip install torch && python
 * train.py"); auto-wrap that into ["sh","-c", string] so the agent doesn't
 * have to know the difference. Arrays are passed through verbatim.
 */
function normalizeCommand(input: unknown): string[] | null {
  if (Array.isArray(input)) {
    if (input.every(x => typeof x === 'string') && input.length > 0) {
      return input as string[];
    }
    return null;
  }
  if (typeof input === 'string' && input.trim().length > 0) {
    return ['sh', '-c', input];
  }
  return null;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ─── ModalCreate ─────────────────────────────────────────────────────────

interface ModalCreateInput {
  gpu?: string;
  timeout?: number;
  cpu?: number;
  memory?: number;
}

export const modalCreateCapability: CapabilityHandler = {
  spec: {
    name: 'ModalCreate',
    description:
      'Create a Modal Python 3.11 sandbox (CPU or GPU) via the BlockRun gateway. ' +
      'Returns a sandbox_id you pass to ModalExec. Charged ONCE, UPFRONT, at create.\n' +
      'BILLING — `timeout` is the BILLED lifetime, not an idle timeout:\n' +
      '  - timeout <= 300 s AND cpu <= 1 AND memory <= 1024 MB: flat rate. ' +
      'CPU $0.01, T4 $0.05, L4 $0.08, A10G $0.10, A100 $0.20, H100 $0.40.\n' +
      '  - Anything else (timeout > 300 s, OR cpu > 1, OR memory > 1024 MB): hourly rate x the FULL ' +
      'requested timeout, charged upfront, never below the flat rate, NO refund when you terminate early. ' +
      'Per hour: CPU $0.25, T4 $4, L4 $4.50, A10G $5, A100 $7, H100 $9.\n' +
      '  - Examples: {timeout: 600, gpu: "A100"} = $1.17; {timeout: 1200, gpu: "H100"} = $3.00; ' +
      '{timeout: 86400, gpu: "H100"} = $216 even if the job finishes in a minute.\n' +
      '  - Ask for the time the work needs, not a safe-looking ceiling. Keep timeout <= 300 with ' +
      'default size for short tasks.\n' +
      'Limits:\n' +
      '  - sandbox lifetime: 10 s to 86400 s (24 h); default 300 s\n' +
      '  - per ModalExec call: 60 seconds MAX wall-clock (use fire-and-poll below)\n' +
      '  - Python 3.11 only, no custom images yet\n' +
      '  - 1 vCPU, 512 MB RAM defaults\n' +
      '  - No setup-time provisioning — every sandbox starts empty\n' +
      'Good for: GPU benchmarks, CUDA kernel validation, model inference, ad-hoc Python, and ' +
      'longer jobs (pip install + model download + training) when the user accepts the hourly cost. ' +
      'Always call ModalTerminate when done (it stops the sandbox; it does not refund the lifetime). ' +
      'Long-running command pattern: each ModalExec call is itself capped at 60s wall-clock. ' +
      'For work that takes >60s (pip install, model download, training), use the ' +
      'fire-and-poll pattern: ModalExec(["sh","-c","nohup <cmd> > /workspace/log 2>&1 &"]) ' +
      'returns in <1s, then poll with subsequent ModalExec(["cat","/workspace/log"]) calls.',
    input_schema: {
      type: 'object',
      properties: {
        gpu: { type: 'string', description: 'GPU tier. One of T4, L4, A10G, A100, H100. Omit for CPU-only ($0.01).' },
        timeout: {
          type: 'number',
          description:
            'BILLED sandbox lifetime in seconds: charged upfront for the whole value, never refunded. ' +
            'Default 300, min 10, max 86400 (24 h). <= 300 (with cpu <= 1, memory <= 1024) is the flat rate; ' +
            '> 300 bills hourly for the full value (e.g. 600 s on A100 = $1.17, 3600 s CPU = $0.25, 86400 s H100 = $216).',
        },
        cpu: { type: 'number', description: 'Number of CPU cores. Default 1, min 0.125, max 1 for CPU sandboxes and 8 with a GPU. Above 1 bills hourly.' },
        memory: { type: 'number', description: 'Memory MB. Default 512, max 1024 for CPU sandboxes and 32768 with a GPU. Above 1024 bills hourly.' },
      },
    },
  },
  concurrent: false,
  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const raw = input as ModalCreateInput;
    // ── Client-side coercion ────────────────────────────────────────────
    // LLMs routinely pass numeric fields as strings ("timeout":"300") and
    // GPU tier in lowercase ("t4"). The gateway's schema is strict and
    // 400s on either, leaving the agent confused (it sees "Invalid
    // request body" with no actionable hint). Fix the obvious mistakes
    // before they leave the client.
    let gpu = raw.gpu;
    if (typeof gpu === 'string') {
      const matched = [...VALID_GPUS].find(g => g.toLowerCase() === gpu!.toLowerCase());
      if (matched) gpu = matched;
    }
    if (gpu && !VALID_GPUS.has(gpu)) {
      return {
        output: `Error: invalid gpu "${gpu}". Allowed: ${[...VALID_GPUS].join(', ')} (or omit for CPU).`,
        isError: true,
      };
    }
    const tier = gpu ?? 'cpu';

    // Coerce numeric fields. Reject NaN explicitly so we don't ship
    // garbage to the gateway.
    const coerceNum = (v: unknown, name: string): number | { error: string } => {
      if (v === undefined || v === null || v === '') return undefined as unknown as number;
      const n = typeof v === 'string' ? Number(v) : (v as number);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { error: `${name} must be a number, got ${typeof v}: ${JSON.stringify(v)}` };
      }
      return n;
    };
    const timeoutCoerced = coerceNum(raw.timeout, 'timeout');
    const cpuCoerced = coerceNum(raw.cpu, 'cpu');
    const memoryCoerced = coerceNum(raw.memory, 'memory');
    for (const c of [timeoutCoerced, cpuCoerced, memoryCoerced]) {
      if (c && typeof c === 'object' && 'error' in c) {
        return { output: `Error: ${c.error}`, isError: true };
      }
    }
    // Mirror the gateway's create schema (integer timeout in 10..86400, cpu
    // >= 0.125) so a bad value fails here with a clear message instead of a
    // bare 400 from the gateway.
    const timeoutSec = typeof timeoutCoerced === 'number' ? timeoutCoerced : DEFAULT_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(timeoutSec) ||
      timeoutSec < MODAL_MIN_TIMEOUT_SECONDS ||
      timeoutSec > MODAL_MAX_TIMEOUT_SECONDS
    ) {
      return {
        output:
          `Error: timeout must be a whole number of seconds from ${MODAL_MIN_TIMEOUT_SECONDS} to ` +
          `${MODAL_MAX_TIMEOUT_SECONDS} (24 h), got ${timeoutSec}. Remember it is the billed lifetime: ` +
          `above 300 s it is charged hourly for the full value, upfront, with no refund.`,
        isError: true,
      };
    }
    if (typeof cpuCoerced === 'number' && cpuCoerced < MODAL_MIN_CPU) {
      return { output: `Error: cpu must be at least ${MODAL_MIN_CPU}, got ${cpuCoerced}.`, isError: true };
    }

    const pricing = modalCreatePricing(
      tier,
      typeof cpuCoerced === 'number' ? cpuCoerced : undefined,
      typeof memoryCoerced === 'number' ? memoryCoerced : undefined,
      timeoutSec,
    );
    const price = pricing.priceUsd;
    const billingLine = pricing.model === 'hourly'
      ? `hourly: ${fmtUsd(pricing.hourlyRateUsd ?? 0)}/h x ${(timeoutSec / 3600).toFixed(2)} h, upfront, no refund on early terminate`
      : 'flat (timeout <= 300 s, cpu <= 1, memory <= 1024 MB)';

    // ── AskUser cost preview (skipped if env auto-approve or non-UI mode) ──
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (ctx.onAskUser && !autoApprove) {
      const lines = [
        `Create Modal sandbox?`,
        ``,
        `  Tier:        ${tier === 'cpu' ? 'CPU only' : `GPU ${tier}`}`,
        `  Image:       python:3.11`,
        `  Timeout:     ${timeoutSec}s (${(timeoutSec / 60).toFixed(1)} min) — billed lifetime`,
        ...(typeof cpuCoerced === 'number' ? [`  CPU cores:   ${cpuCoerced}`] : []),
        ...(typeof memoryCoerced === 'number' ? [`  Memory:      ${memoryCoerced} MB`] : []),
        ``,
        `Create cost:   ${fmtUsd(price)} (one-time, ${billingLine})`,
        `Each exec:     ${fmtUsd(EXEC_PRICE_USD)}`,
        `Terminate:     ${fmtUsd(TERMINATE_PRICE_USD)}`,
      ];
      try {
        const answer = await ctx.onAskUser(lines.join('\n'), ['Approve', 'Cancel']);
        if (answer !== 'Approve') {
          return { output: `## Sandbox creation cancelled\n\n${noChargeNote()}` };
        }
      } catch {
        // askUser failed (UI gone) — fall through and create. Better than
        // silently aborting in headless contexts.
      }
    }

    // Wallet reservation — block over-spend if other in-flight calls hold balance.
    // Hold the most we will sign (list price + Base fee), not the list price:
    // the quote guard in postWithPayment refuses anything above that ceiling.
    let reservation: ReservationToken | null = null;
    try {
      reservation = await walletReservation.hold(maxSignableUsd(price));
      if (!reservation) {
        return {
          output:
            `Insufficient ${isKeyMode() ? 'account credit' : 'USDC'} for ModalCreate (${tier}, ~${fmtUsd(price)}). ` +
            describeHeadroom(),
          isError: true,
        };
      }
    } catch { /* fall through, x402 will surface real error */ }

    try {
      const body: Record<string, unknown> = {};
      if (gpu) body.gpu = gpu;
      if (typeof timeoutCoerced === 'number') body.timeout = timeoutCoerced;
      if (typeof cpuCoerced === 'number') body.cpu = cpuCoerced;
      if (typeof memoryCoerced === 'number') body.memory = memoryCoerced;

      const callStartedAt = Date.now();
      const res = await postWithPayment(
        modalEndpoint('create'),
        body,
        'Franklin Modal sandbox create',
        ctx.abortSignal,
        90_000, // 90s — sandbox cold-start can be slow on fresh GPU pulls
        reservation,
        price,
      );
      const latencyMs = Date.now() - callStartedAt;

      if (!res.ok) {
        const err = res.body.error ? String(res.body.error) : res.raw.slice(0, 300);
        // Surface the per-field validation issues — usually the
        // actionable bit ("expected number, received string at path
        // ['timeout']").
        const details = Array.isArray(res.body.details)
          ? '\nDetails: ' + res.body.details.map((d: Record<string, unknown>) =>
              `${(d.path as string[] | undefined)?.join('.') ?? '?'}: ${d.message ?? JSON.stringify(d)}`
            ).join('; ')
          : '';
        return {
          output: `ModalCreate failed (${res.status}): ${err}${details}`,
          isError: true,
        };
      }

      const sandboxId =
        (typeof res.body.sandbox_id === 'string' && res.body.sandbox_id) ||
        (typeof res.body.id === 'string' && res.body.id) ||
        '';
      if (!sandboxId) {
        return {
          output: `ModalCreate returned no sandbox_id. Raw: ${res.raw.slice(0, 300)}`,
          isError: true,
        };
      }

      sessionSandboxTracker.add({
        id: sandboxId,
        gpu: tier,
        createdAt: Date.now(),
        timeoutSeconds: timeoutSec,
      });

      // Stats — surface Modal usage in `franklin insights` like other paid tools.
      try {
        recordUsage(`modal/${tier}`, 0, 0, price, latencyMs);
      } catch { /* ignore */ }

      return {
        output:
          `Sandbox created\n` +
          `- id: \`${sandboxId}\`\n` +
          `- tier: ${tier === 'cpu' ? 'CPU only' : `GPU ${tier}`}\n` +
          `- timeout: ${timeoutSec}s (billed lifetime; terminating early refunds nothing)\n` +
          `- charged: ${fmtUsd(price)} (${billingLine})\n\n` +
          `Next: ModalExec({ sandbox_id: "${sandboxId}", command: ["python","-c","print(1)"] })`,
      };
    } finally {
      walletReservation.release(reservation);
    }
  },
};

// ─── ModalExec ───────────────────────────────────────────────────────────

interface ModalExecInput {
  sandbox_id?: string;
  command?: unknown; // string OR string[] — we normalize
  timeout?: number;
}

export const modalExecCapability: CapabilityHandler = {
  spec: {
    name: 'ModalExec',
    description:
      'Run a command inside a Modal sandbox (must already exist via ModalCreate). ' +
      '`command` accepts either an execve-style array (e.g. ["python","-c","print(1)"]) ' +
      'or a shell string (e.g. "pip install torch && python train.py") which is auto-wrapped ' +
      'as ["sh","-c", <string>]. Returns stdout, stderr, exit_code synchronously. ' +
      'Each call charges $0.001. The sandbox keeps state across exec calls (filesystem, ' +
      'installed pip packages, etc) until ModalTerminate. ' +
      'CRITICAL: timeout is HARD-CAPPED at 60 seconds by the gateway — anything longer ' +
      'returns HTTP 400. For long-running commands (pip install large packages, model ' +
      'downloads, training loops), use the fire-and-poll pattern: ' +
      '  exec1: ["sh","-c","nohup <slow-cmd> > /workspace/log 2>&1 & echo $! > /workspace/pid"] (<1s) ' +
      '  exec2: ["sh","-c","tail -50 /workspace/log"] (poll progress, <1s) ' +
      '  exec3: ["sh","-c","kill -0 $(cat /workspace/pid) 2>/dev/null && echo RUN || echo DONE"] (check live) ' +
      'This decouples actual work duration from the per-exec 60s ceiling, but the sandbox ' +
      'itself still dies when its create `timeout` (billed lifetime, default 300 s, max 24 h) runs out.',
    input_schema: {
      type: 'object',
      properties: {
        sandbox_id: { type: 'string', description: 'Sandbox id from ModalCreate.' },
        command: {
          description: 'Execve-style array OR shell string. Strings are wrapped as ["sh","-c", string].',
        },
        timeout: { type: 'number', description: 'Per-exec timeout in seconds. Default 60, MAX 60 (gateway hard cap). Use fire-and-poll for longer work.' },
      },
      required: ['sandbox_id', 'command'],
    },
  },
  concurrent: false,
  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const raw = input as ModalExecInput;
    if (!raw.sandbox_id) return { output: 'Error: sandbox_id is required', isError: true };

    const command = normalizeCommand(raw.command);
    if (!command) {
      // JSON.stringify(undefined) returns undefined — guard the slice call.
      const got = raw.command === undefined
        ? 'undefined (missing)'
        : JSON.stringify(raw.command);
      return {
        output:
          `Error: invalid command. Expected a non-empty string or string[] of length >= 1. ` +
          `Got: ${(got ?? 'undefined').slice(0, 100)}`,
        isError: true,
      };
    }

    let reservation: ReservationToken | null = null;
    try {
      reservation = await walletReservation.hold(EXEC_PRICE_USD);
      // For micro-cost calls don't hard-block on insufficient — just proceed.
    } catch { /* ignore */ }

    try {
      // Same string-as-number guard as ModalCreate. LLMs love
      // "timeout":"300".
      let coercedTimeout: number | undefined;
      if (raw.timeout !== undefined && raw.timeout !== null && (raw.timeout as unknown) !== '') {
        const n = typeof raw.timeout === 'string' ? Number(raw.timeout) : raw.timeout;
        if (typeof n === 'number' && Number.isFinite(n)) coercedTimeout = n;
      }
      // Gateway hard-caps exec timeout at 60s. Cap client-side so we
      // never burn an x402 round-trip on a 400. Default to 60s if
      // unset since "I want it to actually run" is a more sensible
      // default than the lib's smaller value.
      const EXEC_TIMEOUT_MAX = 60;
      if (coercedTimeout === undefined || coercedTimeout > EXEC_TIMEOUT_MAX) {
        coercedTimeout = EXEC_TIMEOUT_MAX;
      }
      const body: Record<string, unknown> = {
        sandbox_id: raw.sandbox_id,
        command,
      };
      if (coercedTimeout !== undefined) body.timeout = coercedTimeout;

      const callStartedAt = Date.now();
      const res = await postWithPayment(
        modalEndpoint('exec'),
        body,
        'Franklin Modal sandbox exec',
        ctx.abortSignal,
        Math.max(30_000, ((coercedTimeout ?? 300) + 30) * 1000),
        reservation,
        EXEC_PRICE_USD,
      );
      const latencyMs = Date.now() - callStartedAt;

      if (!res.ok) {
        // 400 here usually means the agent built the wrong shape (bad
        // sandbox_id, malformed command). Dump the full raw body so the
        // agent can see exactly what the gateway complained about and
        // self-correct on the next turn instead of looping blind.
        const err = res.body.error ? String(res.body.error) : '(no error field)';
        const details = res.body.details ? `\nDetails: ${JSON.stringify(res.body.details)}` : '';
        const raw = res.raw.length > 500 ? res.raw.slice(0, 500) + '…' : res.raw;
        return {
          output:
            `ModalExec failed (${res.status}): ${err}${details}\n` +
            `Raw response: ${raw}\n` +
            `Sent: command=${JSON.stringify(command).slice(0, 200)}`,
          isError: true,
        };
      }

      const stdout = typeof res.body.stdout === 'string' ? res.body.stdout : '';
      const stderr = typeof res.body.stderr === 'string' ? res.body.stderr : '';
      // Gateway field shape isn't 100% pinned — accept exit_code, exitCode,
      // returncode, code (in priority order). If NONE of them are present
      // but stdout/stderr came back, treat as success (exit 0) rather than
      // poisoning the failure counter on a healthy run with an unfamiliar
      // response shape.
      const rawExit =
        typeof res.body.exit_code === 'number' ? res.body.exit_code :
        typeof res.body.exitCode === 'number' ? res.body.exitCode :
        typeof res.body.returncode === 'number' ? res.body.returncode :
        typeof res.body.code === 'number' ? res.body.code :
        null;
      const hasAnyOutput = stdout.length > 0 || stderr.length > 0;
      const exitCode = rawExit !== null ? rawExit : (hasAnyOutput ? 0 : -1);

      try { recordUsage('modal/exec', 0, 0, EXEC_PRICE_USD, latencyMs); } catch { /* ignore */ }

      const summary = `exit ${exitCode}` + (rawExit === null ? ' (inferred — no exit_code field in response)' : '');
      const sections = [
        `\`${command.join(' ')}\` → ${summary}`,
      ];
      if (stdout) sections.push(`--- stdout ---\n${stdout}`);
      if (stderr) sections.push(`--- stderr ---\n${stderr}`);
      // Only mark as error when we have a real non-zero exit code OR
      // we have nothing at all (no stdout / stderr / exit_code) which
      // suggests an actual problem rather than a parsing edge case.
      const isError = rawExit !== null ? rawExit !== 0 : !hasAnyOutput;
      return { output: sections.join('\n\n'), isError };
    } finally {
      walletReservation.release(reservation);
    }
  },
};

// ─── ModalStatus ─────────────────────────────────────────────────────────

export const modalStatusCapability: CapabilityHandler = {
  spec: {
    name: 'ModalStatus',
    description:
      'Check the status of a Modal sandbox (running / terminated). Charges $0.001. ' +
      'Useful when you suspect a sandbox died or you want to confirm a previous ' +
      'ModalTerminate succeeded.',
    input_schema: {
      type: 'object',
      properties: {
        sandbox_id: { type: 'string' },
      },
      required: ['sandbox_id'],
    },
  },
  concurrent: false,
  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const sandbox_id = (input as { sandbox_id?: string }).sandbox_id;
    if (!sandbox_id) return { output: 'Error: sandbox_id is required', isError: true };

    let reservation: ReservationToken | null = null;
    try { reservation = await walletReservation.hold(STATUS_PRICE_USD); } catch { /* ignore */ }

    try {
      const callStartedAt = Date.now();
      const res = await postWithPayment(
        modalEndpoint('status'),
        { sandbox_id },
        'Franklin Modal sandbox status',
        ctx.abortSignal,
        30_000,
        reservation,
        STATUS_PRICE_USD,
      );
      const latencyMs = Date.now() - callStartedAt;

      if (!res.ok) {
        const err = res.body.error ? String(res.body.error) : res.raw.slice(0, 300);
        return { output: `ModalStatus failed (${res.status}): ${err}`, isError: true };
      }

      try { recordUsage('modal/status', 0, 0, STATUS_PRICE_USD, latencyMs); } catch { /* ignore */ }

      const status = (res.body.status as string) || 'unknown';
      const extra = JSON.stringify(res.body, null, 2);
      return { output: `Sandbox \`${sandbox_id}\` status: **${status}**\n\n${extra}` };
    } finally {
      walletReservation.release(reservation);
    }
  },
};

// ─── ModalTerminate ──────────────────────────────────────────────────────

export const modalTerminateCapability: CapabilityHandler = {
  spec: {
    name: 'ModalTerminate',
    description:
      'Terminate a Modal sandbox and release its resources. Charges $0.001. ' +
      'Strongly recommended after every successful ModalExec sequence — ' +
      'Modal bills wall-clock GPU time until the sandbox terminates or hits ' +
      'its `timeout`. Session-end auto-cleanup also calls this for any sandboxes ' +
      'the agent forgot, but explicit is better.',
    input_schema: {
      type: 'object',
      properties: {
        sandbox_id: { type: 'string' },
      },
      required: ['sandbox_id'],
    },
  },
  concurrent: false,
  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const sandbox_id = (input as { sandbox_id?: string }).sandbox_id;
    if (!sandbox_id) return { output: 'Error: sandbox_id is required', isError: true };

    let reservation: ReservationToken | null = null;
    try { reservation = await walletReservation.hold(TERMINATE_PRICE_USD); } catch { /* ignore */ }

    try {
      const callStartedAt = Date.now();
      const res = await postWithPayment(
        modalEndpoint('terminate'),
        { sandbox_id },
        'Franklin Modal sandbox terminate',
        ctx.abortSignal,
        30_000,
        reservation,
        TERMINATE_PRICE_USD,
      );
      const latencyMs = Date.now() - callStartedAt;

      // Always remove from tracker — even on failure, retrying is wasteful.
      sessionSandboxTracker.remove(sandbox_id);

      if (!res.ok) {
        const err = res.body.error ? String(res.body.error) : res.raw.slice(0, 300);
        return {
          output:
            `ModalTerminate returned ${res.status}: ${err}\n\n` +
            `(Removed from local tracker regardless. Modal-side cleanup will happen at the timeout.)`,
          isError: res.status >= 500, // 4xx (e.g. already-terminated) is benign
        };
      }

      try { recordUsage('modal/terminate', 0, 0, TERMINATE_PRICE_USD, latencyMs); } catch { /* ignore */ }

      return { output: `Sandbox \`${sandbox_id}\` terminated.` };
    } finally {
      walletReservation.release(reservation);
    }
  },
};

// ─── Bulk session cleanup ────────────────────────────────────────────────

/**
 * Terminate every sandbox the current session has created. Called from
 * vscode-session.ts at session end (and the SessionToolGuard cleanup path)
 * so a missed agent ModalTerminate doesn't leave Modal billing the user
 * up to the per-sandbox timeout. Best-effort: failures are logged but
 * don't block session shutdown.
 */
export async function terminateAllSessionSandboxes(opts: { abortSignal?: AbortSignal } = {}): Promise<{
  attempted: number;
  succeeded: number;
  failed: Array<{ id: string; error: string }>;
}> {
  const ids = sessionSandboxTracker.drainIds();
  const failed: Array<{ id: string; error: string }> = [];
  let succeeded = 0;
  const ctrl = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) ctrl.abort();
    else opts.abortSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  // Sequential — terminating a few sandboxes in parallel offers no real
  // win over serial, and serial keeps the wallet-reservation accounting
  // simple.
  for (const id of ids) {
    try {
      const res = await postWithPayment(
        modalEndpoint('terminate'),
        { sandbox_id: id },
        'Franklin Modal sandbox cleanup',
        ctrl.signal,
        20_000,
        null,
        TERMINATE_PRICE_USD,
      );
      if (res.ok) succeeded++;
      else failed.push({ id, error: String(res.body.error ?? res.raw.slice(0, 200)) });
    } catch (err) {
      failed.push({ id, error: (err as Error).message });
    }
  }
  return { attempted: ids.length, succeeded, failed };
}

// ─── All-in-one export for index.ts registration ─────────────────────────

export const modalCapabilities: CapabilityHandler[] = [
  modalCreateCapability,
  modalExecCapability,
  modalStatusCapability,
  modalTerminateCapability,
];
