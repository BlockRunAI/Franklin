/**
 * 0x Gasless API V2 — Franklin built-in tool for Base swaps WITHOUT user gas.
 *
 * UX win over Base0xSwap (Permit2): the user signs only EIP-712 typed-data
 * (no on-chain approval, no on-chain swap submission). 0x's relayer
 * broadcasts the trade and pays gas; the user pays nothing in ETH and only
 * needs to hold the input token (USDC, DAI, or other Permit-supporting
 * ERC-20).
 *
 * For tokens that don't support Permit (USDT etc.) we error out and tell
 * the user to either use Base0xSwap (which can do a one-time approve+swap
 * with ETH gas) or swap from a Permit-supporting token instead.
 *
 * Routes through BlockRun gateway (/v1/zerox/gasless/{price,quote,submit,status})
 * — server holds the 0x API key, no user setup needed. On-chain affiliate
 * (20 bps) is force-set at quote time on the gateway side.
 *
 * Reference: https://github.com/0xProject/0x-examples/tree/main/gasless-v2-headless-example
 */

import {
  parseUnits,
  formatUnits,
  type Hex,
  type Address,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createWalletClient, http, publicActions } from 'viem';
import { getOrCreateWallet } from '@blockrun/llm';

import { loadConfig } from '../commands/config.js';
import { loadChain, API_URLS, VERSION } from '../config.js';
import type { CapabilityHandler, ExecutionScope } from '../agent/types.js';

// ─── Constants ────────────────────────────────────────────────────────────

const ZEROX_GATEWAY_PATH = '/v1/zerox/gasless';
const QUOTE_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const MAX_STATUS_POLL_MS = 60_000; // hard ceiling on confirmation wait
const STATUS_POLL_INTERVAL_MS = 3_000;

// 0x SignatureType.EIP712 = 2 (per @0x/utils/signature.ts)
const SIGNATURE_TYPE_EIP712 = 2;

// Session safety guards — same pattern as zerox-base.ts
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

const DEFAULT_LARGE_SWAP_USD = 20;
const largeSwapThresholdUsd = (() => {
  const raw = process.env.FRANKLIN_LIVE_SWAP_WARN_USD;
  if (!raw) return DEFAULT_LARGE_SWAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LARGE_SWAP_USD;
  return n;
})();

// ─── Base token map (mirror zerox-base.ts) ────────────────────────────────

const SYMBOL_TO_ADDRESS: Record<string, Address> = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  CBETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
};

const TOKEN_DECIMALS: Record<string, number> = {
  '0x4200000000000000000000000000000000000006': 18,
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6,
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 8,
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 18,
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 18,
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18,
};

const STABLECOIN_ADDRESSES = new Set<string>([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
]);

function resolveTokenAddress(input: string): Address {
  const upper = input.trim().toUpperCase();
  if (SYMBOL_TO_ADDRESS[upper]) return SYMBOL_TO_ADDRESS[upper];
  return input.trim() as Address;
}

function decimalsFor(address: Address): number {
  return TOKEN_DECIMALS[address.toLowerCase()] ?? 18;
}

function symbolFor(address: Address): string {
  const lower = address.toLowerCase();
  for (const [sym, addr] of Object.entries(SYMBOL_TO_ADDRESS)) {
    if (addr.toLowerCase() === lower) return sym;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function isStablecoin(address: Address): boolean {
  return STABLECOIN_ADDRESSES.has(address.toLowerCase());
}

function estimateUsdValue(addr: Address, humanAmount: number): number | null {
  if (isStablecoin(addr)) return humanAmount;
  return null;
}

// ─── Signature helpers ────────────────────────────────────────────────────
// Split a 65-byte 0x-prefixed signature into the {r, s, v, signatureType}
// shape that 0x's /gasless/submit expects.

function splitEip712Signature(sig: Hex): {
  r: Hex;
  s: Hex;
  v: number;
  signatureType: number;
} {
  if (!sig.startsWith('0x')) throw new Error('signature must be 0x-prefixed');
  const noPrefix = sig.slice(2);
  if (noPrefix.length !== 130) {
    throw new Error(
      `expected 65-byte signature, got ${noPrefix.length / 2} bytes`,
    );
  }
  return {
    r: `0x${noPrefix.slice(0, 64)}` as Hex,
    s: `0x${noPrefix.slice(64, 128)}` as Hex,
    v: parseInt(noPrefix.slice(128, 130), 16),
    signatureType: SIGNATURE_TYPE_EIP712,
  };
}

// ─── Wallet + RPC ─────────────────────────────────────────────────────────

const DEFAULT_BASE_RPC = 'https://mainnet.base.org';

function resolveBaseRpcUrl(): string {
  return (
    process.env.BASE_RPC_URL ||
    loadConfig()['base-rpc-url'] ||
    DEFAULT_BASE_RPC
  );
}

async function loadEvmWallet() {
  const raw = await getOrCreateWallet();
  const account = privateKeyToAccount(raw.privateKey as `0x${string}`);
  return { account, address: raw.address as Address };
}

function makeClient(account: ReturnType<typeof privateKeyToAccount>): WalletClient {
  return createWalletClient({
    account,
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  }).extend(publicActions);
}

// ─── Gateway HTTP ─────────────────────────────────────────────────────────

interface Eip712TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  domain: { name?: string; chainId?: number; verifyingContract?: Address };
  message: Record<string, unknown>;
  primaryType: string;
}

interface GaslessQuoteResponse {
  buyAmount: string;
  sellAmount: string;
  buyToken: Address;
  sellToken: Address;
  minBuyAmount?: string;
  trade: { type: string; eip712: Eip712TypedData };
  approval?: { type: string; eip712: Eip712TypedData };
  issues?: { allowance?: { spender: Address; actual: string } | null };
  liquidityAvailable?: boolean;
  fees?: { integratorFee?: { amount: string; token: Address } | null };
  route?: { fills?: Array<{ source?: string }> };
}

interface GaslessSubmitResponse {
  tradeHash: string;
  type?: string;
}

interface GaslessStatusResponse {
  status: 'pending' | 'submitted' | 'succeeded' | 'confirmed' | 'failed' | string;
  transactions?: Array<{ hash: string; timestamp?: number }>;
  reason?: string;
}

async function gatewayGet<T>(
  pathSuffix: string,
  query: URLSearchParams,
  timeoutMs: number,
  ctx: ExecutionScope,
): Promise<T> {
  const apiUrl = API_URLS[loadChain()];
  const url = `${apiUrl}${ZEROX_GATEWAY_PATH}/${pathSuffix}?${query.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': `franklin/${VERSION}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${pathSuffix} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function gatewayPost<T>(
  pathSuffix: string,
  body: unknown,
  timeoutMs: number,
  ctx: ExecutionScope,
): Promise<T> {
  const apiUrl = API_URLS[loadChain()];
  const url = `${apiUrl}${ZEROX_GATEWAY_PATH}/${pathSuffix}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `franklin/${VERSION}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${pathSuffix} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────

function formatGaslessQuoteText(q: GaslessQuoteResponse): string {
  const sellDec = decimalsFor(q.sellToken);
  const buyDec = decimalsFor(q.buyToken);
  const sellHuman = Number(formatUnits(BigInt(q.sellAmount), sellDec));
  const buyHuman = Number(formatUnits(BigInt(q.buyAmount), buyDec));
  const sellSym = symbolFor(q.sellToken);
  const buySym = symbolFor(q.buyToken);
  const rate = sellHuman > 0 ? buyHuman / sellHuman : 0;
  const route =
    q.route?.fills?.map((f) => f.source).filter(Boolean).slice(0, 4).join(' → ') ||
    '0x V2 router';
  const minOut = q.minBuyAmount
    ? Number(formatUnits(BigInt(q.minBuyAmount), buyDec))
    : null;
  const lines = [
    `${sellHuman.toFixed(Math.min(8, sellDec))} ${sellSym} → ${buyHuman.toFixed(Math.min(8, buyDec))} ${buySym}`,
    `Rate: 1 ${sellSym} ≈ ${rate.toPrecision(6)} ${buySym}`,
  ];
  if (minOut != null) {
    lines.push(`Min received: ${minOut.toFixed(Math.min(8, buyDec))} ${buySym}`);
  }
  lines.push(`Route: ${route}`);
  lines.push(`Gas: paid by 0x relayer (you pay nothing in ETH)`);
  lines.push(`Affiliate fee: 20 bps in ${sellSym} (BlockRun affiliate)`);
  return lines.join('\n');
}

// ─── Status polling ──────────────────────────────────────────────────────

async function pollUntilDone(
  tradeHash: string,
  ctx: ExecutionScope,
): Promise<GaslessStatusResponse> {
  const deadline = Date.now() + MAX_STATUS_POLL_MS;
  let last: GaslessStatusResponse = { status: 'pending' };
  while (Date.now() < deadline) {
    if (ctx.abortSignal.aborted) {
      throw new Error('aborted while polling status');
    }
    const params = new URLSearchParams({ chainId: String(base.id) });
    try {
      last = await gatewayGet<GaslessStatusResponse>(
        `status/${tradeHash}`,
        params,
        STATUS_TIMEOUT_MS,
        ctx,
      );
    } catch (err) {
      // Surface a transient failure but keep polling — relayer might be backlogged.
      console.error(
        `[franklin] gasless status poll error: ${(err as Error).message}`,
      );
    }
    if (
      last.status === 'confirmed' ||
      last.status === 'succeeded' ||
      last.status === 'failed'
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  return last;
}

// ─── Tool implementations ────────────────────────────────────────────────

interface SwapInput {
  sell_token: string;
  buy_token: string;
  sell_amount: number;
  auto_approve?: boolean;
}

async function executeBase0xGaslessSwap(
  input: SwapInput,
  ctx: ExecutionScope,
): Promise<{ output: string; isError?: boolean }> {
  if (liveSwapCount >= liveSwapCap) {
    return {
      output:
        `Live-swap session cap reached (${liveSwapCount}/${liveSwapCap}). Stopping to protect your wallet.\n` +
        `Override with FRANKLIN_LIVE_SWAP_CAP=20 (or 0 to disable), or restart Franklin to reset.`,
      isError: true,
    };
  }

  let wallet: { account: ReturnType<typeof privateKeyToAccount>; address: Address };
  try {
    wallet = await loadEvmWallet();
  } catch (err) {
    return {
      output: `Couldn't load Base wallet: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const sellTokenAddr = resolveTokenAddress(input.sell_token);
  const buyTokenAddr = resolveTokenAddress(input.buy_token);
  const sellDec = decimalsFor(sellTokenAddr);
  const sellAmount = parseUnits(input.sell_amount.toString(), sellDec).toString();

  // Step 1 — fetch the gasless firm quote.
  const quoteParams = new URLSearchParams({
    chainId: String(base.id),
    sellToken: sellTokenAddr,
    buyToken: buyTokenAddr,
    sellAmount,
    taker: wallet.address,
  });

  let quote: GaslessQuoteResponse;
  try {
    quote = await gatewayGet<GaslessQuoteResponse>('quote', quoteParams, QUOTE_TIMEOUT_MS, ctx);
  } catch (err) {
    return {
      output: `Gasless /quote failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  if (!quote.trade?.eip712) {
    return {
      output:
        `0x didn't return a tradable gasless quote — likely the pair has insufficient liquidity for gasless. ` +
        `Try Base0xSwap (Permit2) instead, or a different output token.`,
      isError: true,
    };
  }

  // Determine if approval is needed and whether gasless approval is available.
  const approvalRequired = quote.issues?.allowance != null;
  const gaslessApprovalAvailable = quote.approval != null;

  if (approvalRequired && !gaslessApprovalAvailable) {
    return {
      output:
        `${symbolFor(sellTokenAddr)} doesn't support gasless approval (Permit) on Base — first-time use needs a one-time on-chain approve, which requires ETH.\n\n` +
        `Two ways forward:\n` +
        `1. Use Base0xSwap instead — it can do approve+swap with ETH gas.\n` +
        `2. Swap from a Permit-supporting token (USDC, DAI) to ${symbolFor(buyTokenAddr)} instead.`,
      isError: true,
    };
  }

  // Step 2 — confirm with user.
  if (!input.auto_approve && ctx.onAskUser) {
    const quoteText = formatGaslessQuoteText(quote);
    const usdEst = estimateUsdValue(sellTokenAddr, input.sell_amount);
    const sections: string[] = [
      'Execute this gasless 0x swap on Base (no ETH needed)?',
      '',
      quoteText,
    ];
    if (usdEst != null && usdEst >= largeSwapThresholdUsd) {
      sections.push(
        '',
        `⚠ Large swap warning — input is ~$${usdEst.toFixed(2)} (above $${largeSwapThresholdUsd} threshold).`,
      );
    } else if (usdEst == null) {
      sections.push(
        '',
        `Note: input is not a stablecoin, so I cannot price-check this in USD before signing. Verify the output amount matches your intent.`,
      );
    }
    sections.push(
      '',
      `Wallet: ${wallet.address}`,
      `Live-swap session count: ${liveSwapCount}/${liveSwapCap === Infinity ? '∞' : liveSwapCap}`,
    );
    const answer = await ctx.onAskUser(sections.join('\n'), ['Confirm', 'Cancel']);
    if (answer.toLowerCase() !== 'confirm') {
      return { output: 'Swap cancelled by user.' };
    }
  }

  const client = makeClient(wallet.account);

  // Step 3 — sign trade typed-data.
  let tradeSigHex: Hex;
  try {
    tradeSigHex = (await client.signTypedData({
      account: wallet.account,
      types: quote.trade.eip712.types,
      domain: quote.trade.eip712.domain,
      message: quote.trade.eip712.message,
      primaryType: quote.trade.eip712.primaryType,
    })) as Hex;
  } catch (err) {
    return {
      output: `Trade signature failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const tradeSplitSig = splitEip712Signature(tradeSigHex);
  const tradeSubmitObject = {
    type: quote.trade.type,
    eip712: quote.trade.eip712,
    signature: tradeSplitSig,
  };

  // Step 4 — sign approval typed-data if required and available.
  let approvalSubmitObject: Record<string, unknown> | undefined;
  if (approvalRequired && gaslessApprovalAvailable && quote.approval) {
    try {
      const approvalSigHex = (await client.signTypedData({
        account: wallet.account,
        types: quote.approval.eip712.types,
        domain: quote.approval.eip712.domain,
        message: quote.approval.eip712.message,
        primaryType: quote.approval.eip712.primaryType,
      })) as Hex;
      const approvalSplitSig = splitEip712Signature(approvalSigHex);
      approvalSubmitObject = {
        type: quote.approval.type,
        eip712: quote.approval.eip712,
        signature: approvalSplitSig,
      };
    } catch (err) {
      return {
        output: `Approval signature failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  // Step 5 — submit to 0x relayer via gateway.
  const submitBody: Record<string, unknown> = {
    trade: tradeSubmitObject,
    chainId: base.id,
  };
  if (approvalSubmitObject) submitBody.approval = approvalSubmitObject;

  let submitRes: GaslessSubmitResponse;
  try {
    submitRes = await gatewayPost<GaslessSubmitResponse>('submit', submitBody, SUBMIT_TIMEOUT_MS, ctx);
  } catch (err) {
    return {
      output: `Gasless /submit failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  if (!submitRes.tradeHash) {
    return {
      output: `0x relayer didn't return a tradeHash — submission may have been rejected.`,
      isError: true,
    };
  }

  // Step 6 — poll status until confirmed / failed / timeout.
  const final = await pollUntilDone(submitRes.tradeHash, ctx);

  liveSwapCount += 1;
  const onChainHash = final.transactions?.[0]?.hash;
  const explorer = onChainHash ? `https://basescan.org/tx/${onChainHash}` : null;
  const statusLine =
    final.status === 'confirmed' || final.status === 'succeeded'
      ? '✓ Swap confirmed.'
      : final.status === 'failed'
        ? `✗ Swap failed: ${final.reason ?? 'unknown reason'}`
        : `⏳ Still pending after ${MAX_STATUS_POLL_MS / 1000}s — relayer is backlogged. Check status later via /v1/zerox/gasless/status/${submitRes.tradeHash}.`;

  const lines: string[] = [
    statusLine,
    formatGaslessQuoteText(quote),
    `Trade hash: ${submitRes.tradeHash}`,
  ];
  if (onChainHash) lines.push(`On-chain tx: ${onChainHash}`);
  if (explorer) lines.push(explorer);
  lines.push(`(Session live-swap count: ${liveSwapCount}/${liveSwapCap === Infinity ? '∞' : liveSwapCap})`);

  return {
    output: lines.join('\n'),
    isError: final.status === 'failed',
  };
}

// ─── Capability handler ──────────────────────────────────────────────────

export const base0xGaslessSwapCapability: CapabilityHandler = {
  spec: {
    name: 'Base0xGaslessSwap',
    description:
      "Execute a Base DEX swap via 0x Gasless V2. The user signs only EIP-712 typed-data (offline, no on-chain action) — 0x's relayer broadcasts the trade and pays gas. **The user does NOT need any ETH for gas.** Only input token (USDC, DAI, etc. — Permit-supporting ERC-20) is required. Returns the BaseScan link once the relayer confirms. " +
      "Routes through BlockRun gateway /v1/zerox/gasless/* — no 0x signup needed. Affiliate 20 bps in sell-token to BlockRun treasury (server-side enforced). " +
      "Use this instead of Base0xSwap when the user has 0 ETH but holds USDC/DAI. For tokens that don't support Permit (USDT etc.), the tool errors with a clear instruction to use Base0xSwap instead.",
    input_schema: {
      type: 'object',
      required: ['sell_token', 'buy_token', 'sell_amount'],
      properties: {
        sell_token: {
          type: 'string',
          description:
            'Sell-token address or symbol. ONLY Permit-supporting tokens work for fully-gasless flow on Base: USDC, DAI. ETH is native — use Base0xSwap for ETH input. USDT does NOT support Permit on Base.',
        },
        buy_token: {
          type: 'string',
          description: 'Buy-token address or symbol (any token).',
        },
        sell_amount: {
          type: 'number',
          description: 'Amount of sell_token in human units (e.g. 0.1 USDC).',
        },
        auto_approve: {
          type: 'boolean',
          description:
            'If true, skip the AskUser confirm. Default false. Only use when the user just authorized this specific call.',
        },
      },
    },
  },
  execute: async (input: unknown, ctx: ExecutionScope) => {
    return executeBase0xGaslessSwap(input as SwapInput, ctx);
  },
  concurrent: false,
};
