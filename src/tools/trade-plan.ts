/**
 * TradePlan capability — the model's path to trade authorization.
 *
 * `propose` validates the intended trades, persists a pending plan, and
 * BLOCKS until the approval surface decides (TUI prompt, dashboard client,
 * or headless auto-policy). Without any approval surface the proposal fails
 * closed — non-interactive runs reject trades unless --approve-trades was
 * granted and the total fits the --max-spend envelope.
 */

import type { CapabilityHandler } from '../agent/types.js';
import {
  activeTradePlan,
  createTradePlan,
  decideTradePlan,
  formatTradePlanText,
  listTradePlans,
  loadTradePlan,
  validatePlannedTrades,
  TRADE_PLAN_TTL_MS,
} from '../trading/trade-plan.js';
import { getSchedulerSessionId } from '../scheduler/store.js';

export function createTradePlanCapability(): CapabilityHandler {
  return {
    spec: {
      name: 'TradePlan',
      description:
        'Propose a trade plan for user approval — REQUIRED before any real-money trade ' +
        '(JupiterSwap, Base0xSwap, Base0xGaslessSwap, PolymarketBet orders). ' +
        'Actions: "propose" (needs trades[] + rationale; blocks until the user decides), ' +
        '"status" (show the active plan and its remaining budget), "cancel" (needs plan_id). ' +
        'Each trade: {venue: jupiter|zerox|polymarket, action: buy|sell|swap|bet, asset, amountUsd, ' +
        'direction?, maxSlippageBps?, stopCondition?}. Keep plans tight: only the trades you intend ' +
        'to execute now, with a one-paragraph rationale. Approved plans expire after 15 minutes and ' +
        'their budget draws down as trades execute. If the user requests changes, revise and re-propose.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'status', 'cancel'], description: 'Operation to perform.' },
          trades: {
            type: 'array',
            description: 'propose: the trades to authorize.',
            items: {
              type: 'object',
              properties: {
                venue: { type: 'string', enum: ['jupiter', 'zerox', 'polymarket'] },
                action: { type: 'string', enum: ['buy', 'sell', 'swap', 'bet'] },
                asset: { type: 'string', description: 'Symbol, mint/token address, or market outcome.' },
                direction: { type: 'string', enum: ['long', 'short', 'yes', 'no'] },
                amountUsd: { type: 'number', description: 'USD to commit to this trade.' },
                maxSlippageBps: { type: 'number' },
                stopCondition: { type: 'string', description: 'Exit/stop condition in plain language.' },
              },
              required: ['venue', 'action', 'asset', 'amountUsd'],
            },
          },
          rationale: { type: 'string', description: 'propose: why these trades, in one paragraph.' },
          plan_id: { type: 'string', description: 'cancel: plan to cancel.' },
        },
        required: ['action'],
      },
    },
    // Blocks on human input — must not run concurrently with other tools.
    concurrent: false,
    execute: async (input, ctx) => {
      const action = String(input.action || '');
      const sessionId = getSchedulerSessionId();

      if (action === 'status') {
        const active = activeTradePlan(sessionId);
        if (active) {
          const remaining = active.totalSpendUsd - active.consumedUsd;
          return {
            output:
              `${formatTradePlanText(active)}\n\n  Status: APPROVED · $${remaining.toFixed(2)} of ` +
              `$${active.totalSpendUsd.toFixed(2)} remaining · expires ${new Date(active.expiresAt).toLocaleTimeString()}`,
          };
        }
        const recent = listTradePlans().filter(p => p.sessionId === sessionId).slice(0, 3);
        if (recent.length === 0) return { output: 'No trade plans this session. Propose one before trading.' };
        const lines = recent.map(p => `  ${p.id} · ${p.status} · $${p.totalSpendUsd.toFixed(2)} · ${p.trades.length} trade(s)`);
        return { output: `No ACTIVE plan. Recent plans:\n${lines.join('\n')}` };
      }

      if (action === 'cancel') {
        const id = String(input.plan_id || '');
        const plan = id ? loadTradePlan(id) : activeTradePlan(sessionId);
        if (!plan) return { output: `No plan ${id || 'active'} to cancel.`, isError: true };
        if (plan.status === 'consumed' || plan.status === 'cancelled') {
          return { output: `Plan ${plan.id} is already ${plan.status}.`, isError: true };
        }
        decideTradePlan(plan, 'cancelled', 'agent');
        return { output: `Plan ${plan.id} cancelled.` };
      }

      if (action !== 'propose') {
        return { output: `Unknown action "${action}". Use propose, status, or cancel.`, isError: true };
      }

      const validated = validatePlannedTrades(input.trades);
      if ('error' in validated) return { output: `Invalid plan: ${validated.error}`, isError: true };
      const rationale = String(input.rationale || '').trim();
      if (!rationale) return { output: 'Invalid plan: rationale is required.', isError: true };

      const plan = createTradePlan({ sessionId, trades: validated.trades, rationale });

      if (!ctx.onApproval) {
        // No approval surface (piped/scripted run without --approve-trades):
        // fail closed. Autonomy over money is opt-in per run.
        decideTradePlan(plan, 'rejected', 'policy', 'non-interactive run without --approve-trades');
        return {
          output:
            `Trade plan ${plan.id} REJECTED: this is a non-interactive run and trade approval was not ` +
            'granted. Re-run with --approve-trades (and a --max-spend cap) to authorize trades, or run ' +
            'interactively. Do not retry the proposal in this session.',
          isError: true,
        };
      }

      const decision = await ctx.onApproval({
        sessionId,
        kind: 'trade-plan',
        title: `Trade plan: $${plan.totalSpendUsd.toFixed(2)} across ${plan.trades.length} trade(s)`,
        description: formatTradePlanText(plan),
        options: ['approve', 'request changes', 'deny'],
        timeoutMs: TRADE_PLAN_TTL_MS,
        payload: plan,
      });

      const choice = decision.choice.toLowerCase();
      if (choice === 'approve') {
        decideTradePlan(plan, 'approved', decision.message === 'auto' ? 'flag' : 'user');
        return {
          output:
            `Trade plan ${plan.id} APPROVED — $${plan.totalSpendUsd.toFixed(2)} authorized until ` +
            `${new Date(plan.expiresAt).toLocaleTimeString()}. Execute ONLY the planned trades; each ` +
            'execution draws down the budget. Per-swap confirmation is skipped — the plan approval was the confirmation.',
        };
      }
      if (choice === 'request changes') {
        decideTradePlan(plan, 'rejected', 'user', decision.message || 'changes requested');
        return {
          output:
            `Trade plan ${plan.id} needs changes before approval. User feedback: ` +
            `"${decision.message || '(none given)'}". Revise the plan accordingly and propose again.`,
          isError: true,
        };
      }
      decideTradePlan(plan, 'rejected', choice === 'timeout' ? 'policy' : 'user',
        choice === 'timeout' ? 'approval timed out' : decision.message);
      return {
        output:
          `Trade plan ${plan.id} ${choice === 'timeout' ? 'expired unanswered' : 'DENIED by the user'}. ` +
          'Do not execute any trades. Ask the user how they want to proceed.',
        isError: true,
      };
    },
  };
}
