/**
 * 0x Swap API V2 (Permit2) — Franklin built-in tools for Base trading.
 *
 * Same posture as the JupiterSwap tools, different chain + aggregator:
 *   - Calls 0x's API directly from this Franklin process (the user is the
 *     first-party caller; we are not a gateway proxy → no ToS violation).
 *   - Embeds BlockRun's affiliate identity in every quote (`swapFeeRecipient`
 *     + `swapFeeBps` + `swapFeeToken`). Fee flows on-chain to BlockRun at
 *     swap settlement — 0x's officially-supported integrator monetization.
 *   - User signs locally with their existing Base/EVM keypair (via @blockrun/
 *     llm's `getOrCreateWallet`); we never custody.
 *
 * Two tools exposed:
 *   - Base0xQuote — indicative price, free, no signing
 *   - Base0xSwap  — full quote → sign Permit2 → submit raw tx → BaseScan link
 *
 * Reference (official 0x example):
 *   https://github.com/0xProject/0x-examples/tree/main/swap-v2-permit2-headless-example
 *
 * Required env:
 *   ZERO_EX_API_KEY  — get one free at https://dashboard.0x.org
 *   BASE_RPC_URL     — optional override; defaults to public Base RPC
 */

import {
  createWalletClient,
  http,
  publicActions,
  concat,
  numberToHex,
  size,
  parseUnits,
  formatUnits,
  maxUint256,
  erc20Abi,
  getContract,
  type Hex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { getOrCreateWallet } from '@blockrun/llm';

import { loadConfig } from '../commands/config.js';
import type { CapabilityHandler, ExecutionScope } from '../agent/types.js';

// ─── BlockRun affiliate identity on Base ─────────────────────────────────
// Reuses the existing BlockRun ops wallet that already receives x402
// settlements on Base. Every swap routed through these tools deposits 20
// bps of the sell-token amount into this address at settlement.
const BLOCKRUN_BASE_AFFILIATE: Address =
  '0xe9030014F5DAe217d0A152f02A043567b16c1aBf';
const BLOCKRUN_AFFILIATE_FEE_BPS = 20; // 0.2% — matches Jupiter Ultra path.

// ─── 0x API endpoints ─────────────────────────────────────────────────────
const ZEROX_BASE = 'https://api.0x.org/swap/permit2';
const ZEROX_VERSION = 'v2';
const ZEROX_TIMEOUT_MS = 20_000;

// ─── Default Base RPC ────────────────────────────────────────────────────
// Public Base mainnet endpoint. Override via BASE_RPC_URL env or
// `franklin config set base-rpc-url <url>` (Alchemy, QuickNode public, etc.).
// The user-facing call is the swap submission; quote fetches are off-chain.
const DEFAULT_BASE_RPC = 'https://mainnet.base.org';

function resolveBaseRpcUrl(): string {
  return (
    process.env.BASE_RPC_URL ||
    loadConfig()['base-rpc-url'] ||
    DEFAULT_BASE_RPC
  );
}

function resolveZeroxApiKey(): string | undefined {
  return process.env.ZERO_EX_API_KEY || loadConfig()['zerox-api-key'];
}

// ─── Session safety: cumulative live-swap counter ─────────────────────────
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

// ─── Base token map ──────────────────────────────────────────────────────
// EVM addresses are case-sensitive in some libraries — store as checksum.
const NATIVE_ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SYMBOL_TO_ADDRESS: Record<string, Address> = {
  ETH: NATIVE_ETH,
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  CBETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
};

const TOKEN_DECIMALS: Record<string, number> = {
  [NATIVE_ETH.toLowerCase()]: 18,
  '0x4200000000000000000000000000000000000006': 18, // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 6, // USDT
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 8, // CBBTC
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 18, // CBETH
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 18, // AERO
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18, // DAI
};

const STABLECOIN_ADDRESSES = new Set<string>([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
]);

function resolveTokenAddress(input: string): Address {
  const upper = input.trim().toUpperCase();
  if (SYMBOL_TO_ADDRESS[upper]) return SYMBOL_TO_ADDRESS[upper];
  return input.trim() as Address;
}

function decimalsFor(address: Address): number {
  const lower = address.toLowerCase();
  return TOKEN_DECIMALS[lower] ?? 18;
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

function estimateUsdValue(sellTokenAddr: Address, humanAmount: number): number | null {
  if (isStablecoin(sellTokenAddr)) return humanAmount;
  return null; // unknown — caller surfaces a "couldn't price" notice
}

function isNativeEth(addr: Address): boolean {
  return addr.toLowerCase() === NATIVE_ETH.toLowerCase();
}

// ─── 0x V2 response shapes ───────────────────────────────────────────────

interface ZeroXFee {
  amount?: string;
  token?: string;
  type?: string;
}

interface ZeroXIssues {
  allowance?: { spender: Address; actual: string } | null;
  balance?: unknown;
  simulationIncomplete?: boolean;
  invalidSourcesPassed?: string[];
}

interface ZeroXTransaction {
  to: Address;
  data: Hex;
  gas: string;
  gasPrice: string;
  value: string;
}

interface ZeroXPermit2 {
  type: string;
  hash: Hex;
  eip712: {
    types: Record<string, Array<{ name: string; type: string }>>;
    domain: { name?: string; chainId?: number; verifyingContract?: Address };
    message: Record<string, unknown>;
    primaryType: string;
  };
}

interface ZeroXQuoteResponse {
  blockNumber?: string;
  buyAmount: string;
  sellAmount: string;
  buyToken: Address;
  sellToken: Address;
  minBuyAmount?: string;
  permit2?: ZeroXPermit2;
  transaction?: ZeroXTransaction;
  fees?: { integratorFee?: ZeroXFee | null; zeroExFee?: ZeroXFee | null };
  issues?: ZeroXIssues;
  liquidityAvailable?: boolean;
  totalNetworkFee?: string;
  route?: { fills?: Array<{ source?: string; from?: Address; to?: Address; proportionBps?: string }> };
}

// ─── Wallet + client setup ───────────────────────────────────────────────

async function loadEvmWallet() {
  const raw = await getOrCreateWallet();
  // @blockrun/llm returns { privateKey: '0x...', address: '0x...' } — use it
  // verbatim for viem.
  const account = privateKeyToAccount(raw.privateKey as `0x${string}`);
  return { account, address: raw.address as Address };
}

function makeClient(account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({
    account,
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  }).extend(publicActions);
}

function zeroxHeaders(): Record<string, string> {
  const apiKey = resolveZeroxApiKey();
  if (!apiKey) {
    throw new Error(
      "Base swaps need a 0x API key. Each Franklin user sets their own (free, no credit card, 10 req/s): " +
        "1) Sign up at https://dashboard.0x.org · " +
        "2) Copy the API key from the Demo App or your own app · " +
        "3a) Persist it: `franklin setup zerox` (interactive) or `franklin config set zerox-api-key zx_...`, OR " +
        "3b) Per-session: `ZERO_EX_API_KEY=zx_... franklin`. " +
        "BlockRun does NOT need a 0x account — the affiliate fee routes to BlockRun's wallet regardless of whose key is making the call.",
    );
  }
  return {
    'Content-Type': 'application/json',
    '0x-api-key': apiKey,
    '0x-version': ZEROX_VERSION,
  };
}

// ─── 0x API calls ────────────────────────────────────────────────────────

async function zeroxFetch<T>(path: 'price' | 'quote', params: URLSearchParams): Promise<T> {
  const url = `${ZEROX_BASE}/${path}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZEROX_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: zeroxHeaders(), signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`0x ${path} returned ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function buildSwapParams(args: {
  sellTokenAddr: Address;
  buyTokenAddr: Address;
  sellAmountAtomic: string;
  taker: Address;
  feeRecipient?: Address;
  feeBps?: number;
  feeToken?: Address;
}): URLSearchParams {
  const p = new URLSearchParams({
    chainId: String(base.id),
    sellToken: args.sellTokenAddr,
    buyToken: args.buyTokenAddr,
    sellAmount: args.sellAmountAtomic,
    taker: args.taker,
  });
  if (args.feeRecipient && args.feeBps && args.feeBps > 0 && args.feeToken) {
    p.set('swapFeeRecipient', args.feeRecipient);
    p.set('swapFeeBps', String(args.feeBps));
    p.set('swapFeeToken', args.feeToken);
  }
  return p;
}

// ─── Formatting ──────────────────────────────────────────────────────────

function formatQuoteText(q: ZeroXQuoteResponse): string {
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
  lines.push(
    `Affiliate fee: ${BLOCKRUN_AFFILIATE_FEE_BPS} bps (BlockRun affiliate, taken in ${sellSym})`,
  );
  return lines.join('\n');
}

// ─── Tool inputs ─────────────────────────────────────────────────────────

interface QuoteInput {
  sell_token: string;
  buy_token: string;
  sell_amount: number;
}

interface SwapInput extends QuoteInput {
  auto_approve?: boolean;
}

// ─── Quote (read-only) ───────────────────────────────────────────────────

async function executeBase0xQuote(input: QuoteInput): Promise<{ output: string; isError?: boolean }> {
  let walletAddress: Address;
  try {
    const wallet = await loadEvmWallet();
    walletAddress = wallet.address;
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

  const params = buildSwapParams({
    sellTokenAddr,
    buyTokenAddr,
    sellAmountAtomic: sellAmount,
    taker: walletAddress,
    feeRecipient: BLOCKRUN_BASE_AFFILIATE,
    feeBps: BLOCKRUN_AFFILIATE_FEE_BPS,
    // Take the fee in the sell token so it's deterministic and doesn't
    // depend on the output token having an existing recipient ATA / balance.
    feeToken: sellTokenAddr,
  });

  try {
    const price = await zeroxFetch<ZeroXQuoteResponse>('price', params);
    if (!price.liquidityAvailable && price.liquidityAvailable !== undefined) {
      return {
        output: `0x reports no liquidity for ${symbolFor(sellTokenAddr)} → ${symbolFor(buyTokenAddr)} on Base.`,
        isError: true,
      };
    }
    return { output: formatQuoteText(price) };
  } catch (err) {
    return { output: `0x /price failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ─── Swap (full execute) ─────────────────────────────────────────────────

async function executeBase0xSwap(
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
      output:
        `Couldn't load Base wallet. Run \`franklin setup\` to (re)generate a Base wallet, ` +
        `or check ~/.blockrun/.session.\n\nUnderlying error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const client = makeClient(wallet.account);
  const sellTokenAddr = resolveTokenAddress(input.sell_token);
  const buyTokenAddr = resolveTokenAddress(input.buy_token);
  const sellDec = decimalsFor(sellTokenAddr);
  const sellAmount = parseUnits(input.sell_amount.toString(), sellDec).toString();

  const params = buildSwapParams({
    sellTokenAddr,
    buyTokenAddr,
    sellAmountAtomic: sellAmount,
    taker: wallet.address,
    feeRecipient: BLOCKRUN_BASE_AFFILIATE,
    feeBps: BLOCKRUN_AFFILIATE_FEE_BPS,
    feeToken: sellTokenAddr,
  });

  // Step 1 — fetch the firm quote (returns tx + permit2.eip712 to sign).
  let quote: ZeroXQuoteResponse;
  try {
    quote = await zeroxFetch<ZeroXQuoteResponse>('quote', params);
  } catch (err) {
    return {
      output: `0x /quote failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  if (!quote.transaction) {
    return {
      output: `0x returned no transaction — likely no liquidity for this pair.`,
      isError: true,
    };
  }

  // Step 2 — confirm with user (unless explicit auto_approve override).
  if (!input.auto_approve && ctx.onAskUser) {
    const quoteText = formatQuoteText(quote);
    const usdEst = estimateUsdValue(sellTokenAddr, input.sell_amount);
    const sections: string[] = ['Execute this 0x swap on Base?', '', quoteText];
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

  // Step 3 — for ERC-20 sell tokens, ensure Permit2 has an allowance.
  // Native ETH skips this entirely.
  if (!isNativeEth(sellTokenAddr)) {
    const allowanceIssue = quote.issues?.allowance ?? null;
    if (allowanceIssue) {
      try {
        const erc20 = getContract({ address: sellTokenAddr, abi: erc20Abi, client });
        const { request } = await erc20.simulate.approve([allowanceIssue.spender, maxUint256]);
        const approveHash = await erc20.write.approve(request.args);
        await client.waitForTransactionReceipt({ hash: approveHash });
      } catch (err) {
        return {
          output:
            `Permit2 approval failed for ${symbolFor(sellTokenAddr)}: ${err instanceof Error ? err.message : String(err)}\n` +
            `This is a one-time setup step per token; retry the swap and it should succeed.`,
          isError: true,
        };
      }
    }

    // Step 4 — sign the Permit2 EIP-712 typed-data and append signature to
    // transaction.data per the canonical 0x recipe.
    if (!quote.permit2?.eip712) {
      return {
        output: '0x quote did not include permit2.eip712 — non-Permit2 path required, not yet supported.',
        isError: true,
      };
    }
    let signature: Hex;
    try {
      signature = await client.signTypedData(quote.permit2.eip712);
    } catch (err) {
      return {
        output: `Permit2 signing failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    const sigLengthHex = numberToHex(size(signature), { signed: false, size: 32 });
    quote.transaction.data = concat([quote.transaction.data, sigLengthHex, signature]);
  }

  // Step 5 — submit. Native ETH path uses sendTransaction (with value);
  // ERC-20 path uses signTransaction + sendRawTransaction (matches the
  // official 0x example to avoid double-signing pitfalls).
  let txHash: Hex;
  try {
    if (isNativeEth(sellTokenAddr)) {
      txHash = await client.sendTransaction({
        account: wallet.account,
        chain: base,
        to: quote.transaction.to,
        data: quote.transaction.data,
        value: BigInt(quote.transaction.value),
        gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
        gasPrice: quote.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
      });
    } else {
      const nonce = await client.getTransactionCount({ address: wallet.address });
      const signedTx = await client.signTransaction({
        account: wallet.account,
        chain: base,
        to: quote.transaction.to,
        data: quote.transaction.data,
        gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
        gasPrice: quote.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
        nonce,
      });
      txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (
      lower.includes('insufficient') ||
      lower.includes('exceeds balance') ||
      lower.includes('not enough')
    ) {
      return {
        output:
          `Swap failed: insufficient balance. Your Base wallet (${wallet.address}) does not hold enough ${symbolFor(sellTokenAddr)}.\n\n` +
          `Send ${symbolFor(sellTokenAddr)} to that address (or fund it via Coinbase / a bridge), then retry.\n\n` +
          `Underlying error: ${msg}`,
        isError: true,
      };
    }
    return {
      output: `Submit failed: ${msg}`,
      isError: true,
    };
  }

  liveSwapCount += 1;
  const explorer = `https://basescan.org/tx/${txHash}`;
  return {
    output: [
      '✓ Swap executed on Base.',
      formatQuoteText(quote),
      `Tx hash: ${txHash}`,
      explorer,
      `(Session live-swap count: ${liveSwapCount}/${liveSwapCap === Infinity ? '∞' : liveSwapCap})`,
    ].join('\n'),
  };
}

// ─── Capability handlers ─────────────────────────────────────────────────

const COMMON_INPUT_PROPERTIES = {
  sell_token: {
    type: 'string',
    description:
      "Sell-token address (Base EVM 0x... 42 chars), OR a symbol shortcut: ETH, WETH, USDC, USDT, CBBTC, CBETH, AERO, DAI.",
  },
  buy_token: {
    type: 'string',
    description: 'Buy-token address or symbol shortcut (same list as sell_token).',
  },
  sell_amount: {
    type: 'number',
    description:
      'Amount of sell_token to swap, in human units (e.g. 0.01 ETH, 1.5 USDC). Decimals are looked up automatically for known tokens; defaults to 18 for unknown ERC-20s.',
  },
} as const;

export const base0xQuoteCapability: CapabilityHandler = {
  spec: {
    name: 'Base0xQuote',
    description:
      "Read-only price quote for a Base DEX swap via 0x V2. Returns sell/buy amounts, rate, minimum-received, route, and the BlockRun affiliate fee that would apply. Free — no on-chain transaction. Use before Base0xSwap to inspect the trade.",
    input_schema: {
      type: 'object',
      required: ['sell_token', 'buy_token', 'sell_amount'],
      properties: COMMON_INPUT_PROPERTIES,
    },
  },
  execute: async (input: unknown) => {
    return executeBase0xQuote(input as QuoteInput);
  },
  concurrent: true,
};

export const base0xSwapCapability: CapabilityHandler = {
  spec: {
    name: 'Base0xSwap',
    description:
      "Execute a Base DEX swap via 0x V2 (Permit2). Quotes the order, asks the user to confirm, signs locally with the Franklin Base wallet, and submits via Base RPC. A 20 bps affiliate fee in the sell-token is collected on-chain by 0x as part of the swap (BlockRun affiliate program — official 0x integrator mechanism). Returns the BaseScan transaction link. Requires ZERO_EX_API_KEY env var (free at dashboard.0x.org).",
    input_schema: {
      type: 'object',
      required: ['sell_token', 'buy_token', 'sell_amount'],
      properties: {
        ...COMMON_INPUT_PROPERTIES,
        auto_approve: {
          type: 'boolean',
          description:
            'If true, skip the AskUser confirm. Default false — agent should leave this false unless the user explicitly authorized this specific call.',
        },
      },
    },
  },
  execute: async (input: unknown, ctx: ExecutionScope) => {
    return executeBase0xSwap(input as SwapInput, ctx);
  },
  concurrent: false,
};
