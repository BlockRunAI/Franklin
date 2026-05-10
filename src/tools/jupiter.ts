/**
 * Jupiter Ultra Swap — Solana DEX aggregator (built-in Franklin tool).
 *
 * We do NOT proxy through the BlockRun gateway — Jupiter's ToU forbids that.
 * Instead the agent calls Jupiter's Ultra API directly from this process,
 * embedding BlockRun's Referral Program identity in every order. The 20 bps
 * platform fee flows on-chain to BlockRun's referral wallet at swap settlement
 * (Jupiter's officially-supported integrator monetization mechanism — same one
 * Phantom and other wallets use).
 *
 * Two tools exposed:
 *   - JupiterQuote — read-only price check (no AskUser, no signing)
 *   - JupiterSwap  — full flow: order → AskUser confirm → sign → execute
 *
 * Reference implementation:
 *   https://github.com/Jupiter-DevRel/typescript-examples/tree/main/ultra/order-execute-with-referral-accounts
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import {
  getOrCreateSolanaWallet,
  solanaKeyToBytes,
} from '@blockrun/llm';

import type { CapabilityHandler, ExecutionScope } from '../agent/types.js';

// ─── BlockRun Referral identity ───────────────────────────────────────────
// Set up via referral.jup.ag. Owns ATAs for USDC, wSOL, JUP, USDT, etc. Every
// swap routed through these tools deposits 20 bps of output to this wallet's
// matching ATA.
const BLOCKRUN_REFERRAL_ACCOUNT =
  'DUGyfGMTAvyHtrvCa2qPE2KJd3qtGBe4ra7u6URne4xQ';
const BLOCKRUN_REFERRAL_FEE_BPS = 20; // 0.2% — Jupiter docs default; well below Phantom's 85 bps.

// ─── Ultra API endpoints ──────────────────────────────────────────────────
const ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const ORDER_TIMEOUT_MS = 15_000;
const EXECUTE_TIMEOUT_MS = 30_000;

// ─── Session safety: cumulative live-swap counter ─────────────────────────
// We removed the per-turn $-cap in v3.11.0 because it kept firing on legit
// LLM workloads — but a live on-chain swap is irreversible, so a cap here is
// different in kind. Default 10 swaps per Franklin process; user can override
// via FRANKLIN_LIVE_SWAP_CAP env (set to 0 to disable). Resets on restart.
const DEFAULT_LIVE_SWAP_CAP = 10;
const liveSwapCap = (() => {
  const raw = process.env.FRANKLIN_LIVE_SWAP_CAP;
  if (!raw) return DEFAULT_LIVE_SWAP_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIVE_SWAP_CAP;
  if (n <= 0) return Infinity;
  return Math.floor(n);
})();
let liveSwapCount = 0;

// ─── Large-swap warning threshold ────────────────────────────────────────
// USD value above which we surface a "Large swap" line in the AskUser
// confirm — only computable when input is a known stablecoin. Override via
// FRANKLIN_LIVE_SWAP_WARN_USD env (default $20).
const DEFAULT_LARGE_SWAP_USD = 20;
const largeSwapThresholdUsd = (() => {
  const raw = process.env.FRANKLIN_LIVE_SWAP_WARN_USD;
  if (!raw) return DEFAULT_LARGE_SWAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LARGE_SWAP_USD;
  return n;
})();

const STABLECOIN_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function estimateUsdValue(inputMint: string, humanAmount: number): number | null {
  if (STABLECOIN_MINTS.has(inputMint)) return humanAmount;
  return null; // unknown — caller will surface a "couldn't price" warning instead
}

// ─── Symbol → mint shortcuts ──────────────────────────────────────────────
// Agents prefer "USDC" / "SOL" over 44-char base58 mint addresses. Anything
// not in this map is passed through verbatim — power users can drop in any
// mint they want.
const SYMBOL_TO_MINT: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112', // wSOL
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  TRUMP: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  PUMP: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
};

const TOKEN_DECIMALS: Record<string, number> = {
  // wSOL — 9
  So11111111111111111111111111111111111111112: 9,
  // USDC — 6
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  // USDT — 6
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
  // JUP — 6
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,
  // BONK — 5
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,
  // WIF — 6
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6,
};

function resolveMint(input: string): string {
  const upper = input.trim().toUpperCase();
  if (SYMBOL_TO_MINT[upper]) return SYMBOL_TO_MINT[upper];
  return input.trim();
}

function decimalsFor(mint: string, fallback: number = 9): number {
  return TOKEN_DECIMALS[mint] ?? fallback;
}

function symbolFor(mint: string): string {
  for (const [sym, m] of Object.entries(SYMBOL_TO_MINT)) {
    if (m === mint) return sym;
  }
  return mint.slice(0, 4) + '…';
}

function toAtomicUnits(amount: number, decimals: number): string {
  // BigInt math — JavaScript number can lose precision for large lamport counts.
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = BigInt(Math.floor(amount));
  const fractional = BigInt(Math.round((amount - Math.floor(amount)) * Number(scale)));
  return (whole * scale + fractional).toString();
}

function fromAtomicUnits(atomic: string | number, decimals: number): number {
  const value = typeof atomic === 'string' ? Number(atomic) : atomic;
  return value / Math.pow(10, decimals);
}

// ─── Jupiter Ultra HTTP client ────────────────────────────────────────────

interface UltraOrderResponse {
  transaction?: string; // base64 unsigned tx
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  feeBps?: number;
  priceImpactPct?: string;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
  errorMessage?: string;
}

interface UltraExecuteResponse {
  status: 'Success' | 'Failed';
  signature?: string;
  error?: string;
  code?: string | number;
}

async function ultraOrder(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
}): Promise<UltraOrderResponse> {
  const url = new URL(`${ULTRA_BASE}/order`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  if (params.taker) url.searchParams.set('taker', params.taker);
  url.searchParams.set('referralAccount', BLOCKRUN_REFERRAL_ACCOUNT);
  url.searchParams.set('referralFee', String(BLOCKRUN_REFERRAL_FEE_BPS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter Ultra /order returned ${res.status}: ${text}`);
    }
    return (await res.json()) as UltraOrderResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function ultraExecute(args: {
  signedTransaction: string;
  requestId: string;
}): Promise<UltraExecuteResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${ULTRA_BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jupiter Ultra /execute returned ${res.status}: ${text}`);
    }
    return (await res.json()) as UltraExecuteResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────

interface QuoteInput {
  input_mint: string;
  output_mint: string;
  amount: number;
}

interface SwapInput extends QuoteInput {
  auto_approve?: boolean;
}

async function loadSolanaKeypair(): Promise<Keypair> {
  const wallet = await getOrCreateSolanaWallet();
  const bytes = await solanaKeyToBytes(wallet.privateKey);
  return Keypair.fromSecretKey(bytes);
}

function formatQuote(order: UltraOrderResponse): string {
  const inMint = order.inputMint;
  const outMint = order.outputMint;
  const inDec = decimalsFor(inMint);
  const outDec = decimalsFor(outMint);
  const inAmount = fromAtomicUnits(order.inAmount, inDec);
  const outAmount = fromAtomicUnits(order.outAmount, outDec);
  const inSym = symbolFor(inMint);
  const outSym = symbolFor(outMint);
  const impact = order.priceImpactPct
    ? `${(Number(order.priceImpactPct) * 100).toFixed(3)}%`
    : 'n/a';
  const route =
    order.routePlan
      ?.map((step) => step.swapInfo?.label)
      .filter(Boolean)
      .join(' → ') || 'Jupiter Ultra';
  const rate = inAmount > 0 ? outAmount / inAmount : 0;
  return [
    `${inAmount.toFixed(Math.min(6, inDec))} ${inSym} → ${outAmount.toFixed(Math.min(6, outDec))} ${outSym}`,
    `Rate: 1 ${inSym} ≈ ${rate.toPrecision(6)} ${outSym}`,
    `Price impact: ${impact}`,
    `Route: ${route}`,
    `Platform fee: ${BLOCKRUN_REFERRAL_FEE_BPS} bps (BlockRun referral)`,
  ].join('\n');
}

async function executeJupiterQuote(input: QuoteInput): Promise<{ output: string; isError?: boolean }> {
  const inputMint = resolveMint(input.input_mint);
  const outputMint = resolveMint(input.output_mint);
  const inDec = decimalsFor(inputMint);
  const amountAtomic = toAtomicUnits(input.amount, inDec);

  try {
    const order = await ultraOrder({ inputMint, outputMint, amount: amountAtomic });
    if (order.errorMessage) {
      return { output: `Jupiter Ultra rejected the quote: ${order.errorMessage}`, isError: true };
    }
    return { output: formatQuote(order) };
  } catch (err) {
    return {
      output: `Jupiter Ultra /order failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function executeJupiterSwap(
  input: SwapInput,
  ctx: ExecutionScope
): Promise<{ output: string; isError?: boolean }> {
  // Session-cap pre-check (cheapest, fail fast).
  if (liveSwapCount >= liveSwapCap) {
    return {
      output:
        `Live-swap session cap reached (${liveSwapCount}/${liveSwapCap}). ` +
        `Stopping to protect your wallet — this is a deliberate guardrail, not an error in your prompt.\n\n` +
        `To raise: \`FRANKLIN_LIVE_SWAP_CAP=20 franklin\` (or 0 to disable).\n` +
        `To continue with a fresh count: restart Franklin (\`exit\` then re-launch).`,
      isError: true,
    };
  }

  const inputMint = resolveMint(input.input_mint);
  const outputMint = resolveMint(input.output_mint);
  const inDec = decimalsFor(inputMint);
  const amountAtomic = toAtomicUnits(input.amount, inDec);

  // Load wallet — `getOrCreateSolanaWallet` auto-creates on first run, so this
  // path firing means the file is corrupt or the .blockrun dir is unreadable.
  let keypair: Keypair;
  try {
    keypair = await loadSolanaKeypair();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output:
        `Couldn't load your Solana wallet. ` +
        `Run \`franklin setup solana\` to (re)generate one. ` +
        `If that's already worked before, check ~/.blockrun/solana-wallet.json is readable.\n\n` +
        `Underlying error: ${msg}`,
      isError: true,
    };
  }

  const walletAddress = keypair.publicKey.toBase58();

  // Step 1 — fetch order with our referral identity attached.
  let order: UltraOrderResponse;
  try {
    order = await ultraOrder({
      inputMint,
      outputMint,
      amount: amountAtomic,
      taker: walletAddress,
    });
  } catch (err) {
    return {
      output: `Jupiter Ultra /order failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  if (order.errorMessage || !order.transaction) {
    return {
      output: `Jupiter Ultra rejected the order: ${order.errorMessage ?? 'no transaction returned'}`,
      isError: true,
    };
  }

  // Step 2 — confirm with user (unless explicit auto_approve override).
  if (!input.auto_approve && ctx.onAskUser) {
    const quoteText = formatQuote(order);
    const usdEst = estimateUsdValue(inputMint, input.amount);
    const sections: string[] = ['Execute this Jupiter swap?', '', quoteText];

    if (usdEst != null && usdEst >= largeSwapThresholdUsd) {
      sections.push(
        '',
        `⚠ Large swap warning — input is ~$${usdEst.toFixed(2)} (above $${largeSwapThresholdUsd} threshold). Confirm only if this matches your intent.`,
      );
    } else if (usdEst == null) {
      sections.push(
        '',
        `Note: input is not a stablecoin, so I cannot price-check this in USD before signing. Verify the output amount matches your intent.`,
      );
    }

    sections.push(
      '',
      `Wallet: ${walletAddress}`,
      `Live-swap session count: ${liveSwapCount}/${liveSwapCap === Infinity ? '∞' : liveSwapCap}`,
    );

    const answer = await ctx.onAskUser(sections.join('\n'), ['Confirm', 'Cancel']);
    if (answer.toLowerCase() !== 'confirm') {
      return { output: 'Swap cancelled by user.' };
    }
  }

  // Step 3 — sign locally with the user's Solana keypair.
  let signedBase64: string;
  try {
    const txBytes = Buffer.from(order.transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([keypair]);
    signedBase64 = Buffer.from(tx.serialize()).toString('base64');
  } catch (err) {
    return {
      output: `Failed to sign Jupiter transaction: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // Step 4 — submit through Jupiter Ultra (handles broadcast + confirmation).
  try {
    const exec = await ultraExecute({
      signedTransaction: signedBase64,
      requestId: order.requestId,
    });
    if (exec.status !== 'Success') {
      const errStr = (exec.error ?? '').toLowerCase();
      const looksInsufficient =
        errStr.includes('insufficient') ||
        errStr.includes('lamports') ||
        errStr.includes('tokenaccountnotfound') ||
        errStr.includes('not enough');
      if (looksInsufficient) {
        return {
          output:
            `Swap failed: insufficient balance. Your Solana wallet (${walletAddress}) does not hold enough of the input token.\n\n` +
            `Send ${symbolFor(inputMint)} to that address (or fund it via the Franklin UI), then retry.\n\n` +
            `Underlying error: ${exec.error ?? exec.code ?? 'unknown'}`,
          isError: true,
        };
      }
      return {
        output:
          `Jupiter Ultra /execute reported ${exec.status}` +
          (exec.error ? `: ${exec.error}` : '') +
          (exec.code ? ` (code ${exec.code})` : ''),
        isError: true,
      };
    }
    liveSwapCount += 1;
    const sig = exec.signature ?? '<unknown>';
    const explorer = `https://solscan.io/tx/${sig}`;
    return {
      output: [
        '✓ Swap executed.',
        formatQuote(order),
        `Signature: ${sig}`,
        explorer,
        `(Session live-swap count: ${liveSwapCount}/${liveSwapCap === Infinity ? '∞' : liveSwapCap})`,
      ].join('\n'),
    };
  } catch (err) {
    return {
      output: `Jupiter Ultra /execute failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

// ─── Capability handlers ──────────────────────────────────────────────────

const COMMON_INPUT_PROPERTIES = {
  input_mint: {
    type: 'string',
    description:
      'Input SPL mint address, OR a symbol shortcut: SOL, USDC, USDT, JUP, BONK, WIF, TRUMP, PUMP.',
  },
  output_mint: {
    type: 'string',
    description: 'Output SPL mint address, OR a symbol shortcut (same list as input_mint).',
  },
  amount: {
    type: 'number',
    description:
      'Amount of input_mint to swap, in human units (e.g. 1.5 USDC, 0.05 SOL). Decimals are looked up automatically for known mints; defaults to 9 for unknown mints.',
  },
} as const;

export const jupiterQuoteCapability: CapabilityHandler = {
  spec: {
    name: 'JupiterQuote',
    description:
      "Read-only price quote for a Solana DEX swap via Jupiter Ultra. Returns input/output amounts, rate, price impact, and routing path. Free — no on-chain transaction, no signing. Use this before JupiterSwap to inspect what a trade would do.",
    input_schema: {
      type: 'object',
      required: ['input_mint', 'output_mint', 'amount'],
      properties: COMMON_INPUT_PROPERTIES,
    },
  },
  execute: async (input: unknown) => {
    return executeJupiterQuote(input as QuoteInput);
  },
  concurrent: true,
};

export const jupiterSwapCapability: CapabilityHandler = {
  spec: {
    name: 'JupiterSwap',
    description:
      "Execute a Solana DEX swap via Jupiter Ultra. Quotes the order, asks the user to confirm via AskUser, signs locally with the Franklin Solana wallet, and submits. A 20 bps platform fee is collected on-chain by Jupiter as part of the swap (BlockRun referral — official integrator program). Returns the Solscan transaction link.",
    input_schema: {
      type: 'object',
      required: ['input_mint', 'output_mint', 'amount'],
      properties: {
        ...COMMON_INPUT_PROPERTIES,
        auto_approve: {
          type: 'boolean',
          description:
            'If true, skip the AskUser confirm step. Default false — agent should leave this false unless the user explicitly authorized batch execution for this turn.',
        },
      },
    },
  },
  execute: async (input: unknown, ctx: ExecutionScope) => {
    return executeJupiterSwap(input as SwapInput, ctx);
  },
  concurrent: false,
};
