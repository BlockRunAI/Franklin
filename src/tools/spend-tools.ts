/**
 * Spend-tool registry — which capabilities move real money, and how much.
 *
 * Two consumers:
 *   1. HookEngine — PreSpend/PostSpend events fire only for tools listed here,
 *      carrying the estimated USD amount so user hooks can enforce caps and
 *      blacklists without parsing tool-specific inputs.
 *   2. Trade-plan gating — the trade-execution subset must be covered by an
 *      approved trade plan before it can execute.
 *
 * Estimators are conservative: they return a USD number only when the input
 * denominates the spend directly (stablecoin in, explicit USD field, or a
 * known flat price). Anything else returns null = "unknown amount" — hooks
 * still fire and can decide policy for unpriceable spends.
 *
 * Stable-mint tables intentionally mirror the per-tool confirm logic in
 * jupiter.ts / zerox-base.ts (stables price 1:1, everything else unknown).
 */

const SOLANA_STABLE_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const BASE_STABLE_ADDRESSES = new Set<string>([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT on Base
]);

type SpendInput = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function solanaStableAmount(input: SpendInput): number | null {
  const mint = str(input.input_mint).toUpperCase() === 'USDC'
    ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    : str(input.input_mint).toUpperCase() === 'USDT'
      ? 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      : str(input.input_mint);
  if (!SOLANA_STABLE_MINTS.has(mint)) return null;
  return num(input.amount);
}

function baseStableAmount(input: SpendInput): number | null {
  const token = str(input.sell_token);
  const addr = token.toUpperCase() === 'USDC'
    ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    : token.toUpperCase() === 'USDT'
      ? '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2'
      : token.toLowerCase();
  if (!BASE_STABLE_ADDRESSES.has(addr)) return null;
  return num(input.sell_amount);
}

function polymarketAmount(input: SpendInput): number | null {
  const action = str(input.action);
  // Only money-out actions count as spend. Sells/redeems/withdraws return
  // funds; setup/orders/positions are reads.
  if (action !== 'buy' && action !== 'fund') return null;
  const direct = num(input.amount_usd);
  if (direct != null) return direct;
  // Limit buy: price (0–1 probability) × size (shares) ≈ pUSD cost.
  const price = num(input.price);
  const size = num(input.size);
  if (price != null && size != null) return price * size;
  return null;
}

/**
 * Tool name → USD estimator. Presence in this map is what marks a tool as
 * spendful; the estimator may still return null (unknown amount).
 */
export const SPEND_TOOLS: Readonly<Record<string, (input: SpendInput) => number | null>> = {
  JupiterSwap: solanaStableAmount,
  Base0xSwap: baseStableAmount,
  Base0xGaslessSwap: baseStableAmount,
  PolymarketBet: polymarketAmount,
  // Flat-priced gateway services.
  BuyPhoneNumber: () => 5,
  RenewPhoneNumber: () => 5,
  // Variable-priced paid services — amount unknown at call time, but hooks
  // must still see the spend event.
  VoiceCall: () => null,
  agent_talent: (input) => (str(input.action) === 'run' ? null : 0) || null,
  ImageGen: () => null,
  VideoGen: () => null,
  MusicGen: () => null,
};

/**
 * The subset whose invocations are trades — used by the trade-plan gate.
 * PolymarketBet is trade-gated only for order placement (buy/sell with
 * confirm), which the gate itself checks via the invocation input.
 */
export const TRADE_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  'JupiterSwap',
  'Base0xSwap',
  'Base0xGaslessSwap',
  'PolymarketBet',
]);

export function isSpendTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPEND_TOOLS, name);
}

export function estimateSpendUsd(name: string, input: SpendInput): number | null {
  const estimator = SPEND_TOOLS[name];
  if (!estimator) return null;
  try {
    return estimator(input);
  } catch {
    return null;
  }
}
