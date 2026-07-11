// src/tools/polymarket-bet.ts
//
// PolymarketBet — Franklin's native end-to-end Polymarket betting capability
// (CLOB V2, Polygon). This is the execution half of the prediction-market story:
// the read-only PredictionMarket tool answers "what are the odds / should I bet",
// this tool actually places, manages, and settles the bet. Orders are EIP-712
// signed LOCALLY with the same ~/.blockrun/.session key that pays x402 fees on
// Base — the purest expression of "the agent with a wallet actually spends".
//
// Ported from blockrun-mcp's polymarket module (src/tools/polymarket/*). The only
// Franklin-specific glue lives here and in ./polymarket/wallet-key.ts. Discovery
// (token_id, condition_id, prices) stays with PredictionMarket / blockrun_markets.
//
// SAFETY MODEL (real money):
//   1. Dry-run unless confirm:true — every placement action previews first.
//   2. Interactive human gate — when the agent asks to actually sign (confirm:true),
//      the REAL dry-run preview is shown through ctx.onAskUser and the user must
//      approve before anything is signed. Bypass only with auto_approve:true (or
//      FRANKLIN_POLYMARKET_AUTO_APPROVE=1) for headless runs.
//   3. Hard per-order + session USD caps (POLYMARKET_MAX_BET_USD default $25,
//      POLYMARKET_MAX_SESSION_USD) enforced inside orders.ts — independent of the
//      x402 API budget: bets are the user's own pUSD on Polygon and do NOT draw
//      from the --max-spend AI ledger. The $0.01 fund fee IS metered as x402 spend.
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { recordUsage } from '../stats/tracker.js';
import { logger } from '../logger.js';
import { ensurePolymarketWallet } from './polymarket/wallet-key.js';
import {
  executeTrade,
  listOpenOrders,
  cancelOrdersAction,
  getSessionLedger,
  type ToolResult,
} from './polymarket/orders.js';
import { listPositions } from './polymarket/positions.js';
import { redeemPosition } from './polymarket/redeem.js';
import { runSetup } from './polymarket/setup.js';
import { withdrawFunds } from './polymarket/withdraw.js';
import { fundVault } from './polymarket/fund.js';

type PmAction =
  | 'setup'
  | 'fund'
  | 'buy'
  | 'sell'
  | 'cancel'
  | 'orders'
  | 'positions'
  | 'redeem'
  | 'withdraw';

interface PmInput {
  action: PmAction;
  token_id?: string;
  condition_id?: string;
  outcome?: string;
  price?: number;
  size?: number;
  amount_usd?: number;
  order_type?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  expires_at?: number;
  post_only?: boolean;
  order_id?: string;
  all?: boolean;
  to_address?: string;
  confirm?: boolean;
  auto_approve?: boolean;
  agent_id?: string;
}

// Actions that SIGN or MOVE money when confirm:true — these get the interactive
// human gate. reads (orders/positions) and cancel never spend, so they don't.
const PLACEMENT_ACTIONS = new Set<PmAction>(['setup', 'fund', 'buy', 'sell', 'redeem', 'withdraw']);

const FUND_FEE_USD = 0.01;

/** Route one action to its ported handler. `confirm` is threaded through so the
 * caller can request a dry-run (confirm:false) or the real thing (confirm:true). */
async function dispatch(input: PmInput, confirm: boolean): Promise<ToolResult> {
  switch (input.action) {
    case 'setup': {
      const r = await runSetup({ confirm });
      return { text: r.text, structured: r.structured };
    }
    case 'fund':
      return fundVault({ amount_usd: input.amount_usd, confirm });
    case 'buy':
    case 'sell':
      return executeTrade({
        action: input.action,
        token_id: input.token_id,
        condition_id: input.condition_id,
        outcome: input.outcome,
        price: input.price,
        size: input.size,
        amount_usd: input.amount_usd,
        order_type: input.order_type,
        expires_at: input.expires_at,
        post_only: input.post_only,
        confirm,
        agent_id: input.agent_id,
      });
    case 'orders':
      return listOpenOrders({ condition_id: input.condition_id });
    case 'cancel':
      return cancelOrdersAction({ order_id: input.order_id, all: input.all });
    case 'positions':
      return listPositions();
    case 'redeem':
      return redeemPosition({ condition_id: input.condition_id, confirm });
    case 'withdraw':
      return withdrawFunds({ amount_usd: input.amount_usd, to_address: input.to_address, confirm });
    default:
      return { text: `Unknown action: ${String((input as PmInput).action)}`, isError: true };
  }
}

async function execute(raw: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const input = raw as unknown as PmInput;
  if (!input.action) {
    return { output: 'Pass an action: setup | fund | buy | sell | cancel | orders | positions | redeem | withdraw.', isError: true };
  }

  // Load-or-create the EVM session key so the synchronous signer inside the
  // ported client can serve it. Must run before any dispatch.
  try {
    await ensurePolymarketWallet();
  } catch (err) {
    return { output: `Wallet unavailable: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }

  const wantsConfirm = input.confirm === true;
  const autoApprove = input.auto_approve === true || process.env.FRANKLIN_POLYMARKET_AUTO_APPROVE === '1';

  // Interactive human gate — the agent proposed a real, signing action. Show the
  // ACTUAL dry-run preview (built by the underlying handler) and require an
  // explicit user Confirm before we sign anything on-chain.
  if (PLACEMENT_ACTIONS.has(input.action) && wantsConfirm && !autoApprove && ctx.onAskUser) {
    let previewText: string;
    try {
      const preview = await dispatch(input, false);
      previewText = preview.text;
      if (preview.isError) {
        // The dry-run itself failed (bad params, insufficient balance, not set
        // up) — surface that instead of prompting to sign a doomed action.
        return { output: preview.text, isError: true, fullOutput: preview.text };
      }
    } catch (err) {
      return { output: `Preview failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const answer = await ctx.onAskUser(
      [
        previewText,
        '',
        '⚠ REAL MONEY — confirming signs and submits this on-chain (Polygon). Proceed?',
      ].join('\n'),
      ['Confirm', 'Cancel'],
    );
    if (answer.toLowerCase() !== 'confirm') {
      return { output: 'Polymarket action cancelled by user.' };
    }
  }

  // Execute for real (or return the dry-run when confirm was never requested).
  const startedAt = Date.now();
  let result: ToolResult;
  try {
    result = await dispatch(input, wantsConfirm);
  } catch (err) {
    return { output: `Polymarket ${input.action} error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }

  // Meter the $0.01 fund fee as x402 spend (it IS a BlockRun gateway charge on
  // Base). Bet stakes are NOT metered here — they're the user's own pUSD, tracked
  // separately by the session betting ledger in orders.ts.
  if (input.action === 'fund' && !result.isError && result.structured?.success === true) {
    try {
      recordUsage('PolymarketBet:fund', 0, 0, FUND_FEE_USD, Date.now() - startedAt);
    } catch (err) {
      logger.debug?.(`PolymarketBet: recordUsage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.isError) {
    return { output: result.text, isError: true, fullOutput: result.text };
  }
  return { output: result.text, fullOutput: result.text };
}

export const polymarketBetCapability: CapabilityHandler = {
  spec: {
    name: 'PolymarketBet',
    description:
      'Place and manage REAL-MONEY bets on Polymarket prediction markets (CLOB V2, Polygon). Orders spend pUSD in your Polymarket deposit wallet, signed locally by your BlockRun key. Discover markets/prices/token IDs with PredictionMarket first; this tool executes. ' +
      'Run action:"setup" FIRST (and again after funding) — it creates a gasless deposit wallet, checks pUSD balance + approvals, and reports your region status. Actions: ' +
      '`setup` (create/inspect deposit wallet + approvals; confirm:true signs the approval batch), ' +
      '`fund` (top up the vault from your OWN Base USDC, gasless, $0.01 fee; amount_usd required, confirm:true), ' +
      '`buy`/`sell` (token_id or condition_id+outcome, plus price+size for a limit order or amount_usd for a market buy / size for a market sell; confirm:true to place, otherwise a dry-run preview — per-order cap POLYMARKET_MAX_BET_USD default $25), ' +
      '`orders` (list open orders), `cancel` (order_id or all:true), ' +
      '`positions` (holdings incl. redeemable winnings), ' +
      '`redeem` (claim resolved winnings for condition_id; confirm:true), ' +
      '`withdraw` (cash out pUSD → USDC on Base to your agent wallet; confirm:true). ' +
      'Prices are probabilities 0–1 on the market tick grid. Every confirm:true placement is shown to the user for approval before signing unless auto_approve is set. Order placement is geoblocked in some regions (setup reports status).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['setup', 'fund', 'buy', 'sell', 'cancel', 'orders', 'positions', 'redeem', 'withdraw'],
          description: 'Operation to perform.',
        },
        token_id: { type: 'string', description: 'Outcome token ID (decimal ERC-1155 id from PredictionMarket clobTokenIds).' },
        condition_id: { type: 'string', description: 'Market condition ID (0x…). With `outcome` it resolves token_id; required for redeem.' },
        outcome: { type: 'string', description: "Outcome label (e.g. 'Yes') — used with condition_id when token_id is omitted." },
        price: { type: 'number', description: 'Limit price as probability (0–1). Omit for a market order.' },
        size: { type: 'number', description: 'Shares — required for limit orders and market sells.' },
        amount_usd: { type: 'number', description: 'pUSD dollars — to spend (market buy / fund) or cash out (withdraw; default full balance).' },
        order_type: { type: 'string', enum: ['GTC', 'GTD', 'FOK', 'FAK'], description: 'Default GTC for limit orders, FOK for market orders.' },
        expires_at: { type: 'number', description: 'Unix seconds expiry (GTD only, ≥ ~3 min in the future).' },
        post_only: { type: 'boolean', description: 'Maker-only limit order (rejected if it would cross the book).' },
        order_id: { type: 'string', description: 'Order ID to cancel.' },
        all: { type: 'boolean', description: 'cancel: cancel ALL open orders.' },
        to_address: { type: 'string', description: 'withdraw: destination address on Base (default: your agent wallet).' },
        confirm: { type: 'boolean', description: 'Must be true to place orders / sign approvals / redeem. Omit for a dry-run preview.' },
        auto_approve: { type: 'boolean', description: 'Skip the interactive user confirmation prompt (headless use). Caps still apply.' },
        agent_id: { type: 'string', description: 'Tag for the session betting ledger (bets do NOT draw from the x402 API budget).' },
      },
      required: ['action'],
    },
  },
  execute,
  // Betting mutates order/wallet state; serialize rather than run in parallel.
  concurrent: false,
};

export { getSessionLedger };
