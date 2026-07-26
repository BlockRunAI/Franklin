// src/utils/polymarket/redeem.ts
//
// Claim winnings for a resolved market. Burns the ERC-1155 outcome tokens and
// credits pUSD back to the funds wallet:
//   - POLY_1271: a gasless relayer WALLET batch executed BY the deposit wallet
//     (the adapter credits msg.sender, i.e. the deposit wallet).
//   - EOA mode: a direct transaction from the EOA (needs POL gas).
//
// Target contracts — ALWAYS the pUSD collateral adapters, NEVER the CTF or the
// legacy NegRiskAdapter directly. CTF positions (the CLOB token_ids) are still
// keyed to USDC.e (standard) / the legacy adapter's wrapped collateral
// (neg-risk); a direct CTF redeem with pUSD collateral computes a positionId
// nobody holds and SUCCEEDS redeeming 0 — success + tx hash, zero payout (the
// bug behind data-api "REDEEM size=0" reports). The adapters pull the caller's
// outcome tokens (one-time CTF operator approval, granted in setup), redeem
// through the right underlying path, wrap the USDC.e payout into pUSD, and
// return pUSD to the caller:
//   - standard binary markets → CtfCollateralAdapter.redeemPositions(...)
//   - negRisk markets → NegRiskCtfCollateralAdapter.redeemPositions(...)
// Both mirror the CTF redeemPositions(collateral, parent, conditionId,
// indexSets) signature; only conditionId is read — the adapter derives the
// position ids and amounts (full caller balance) itself.
import { createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { getClobClient, getPolymarketAccount } from "./client.js";
import {
  CONDITIONAL_TOKENS,
  CTF_COLLATERAL_ADAPTER,
  ERC1155_ABI,
  getSigType,
  NEG_RISK_CTF_COLLATERAL_ADAPTER,
  POLYGON_WRITE_RPC_URL,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
} from "./constants.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { sendWalletBatch } from "./relayer.js";
import { getPublicClient, getPusdBalance } from "./setup.js";
import { assertTransactionSucceeded } from "./transactions.js";

interface ClobMarketToken { token_id?: string; outcome?: string; winner?: boolean }

/**
 * Redeem call for the pUSD collateral adapter (standard or neg-risk). Exported
 * for unit tests — the target/calldata pair is the money-critical part of this
 * file. The CTF-mirror arguments besides conditionId are ignored by the
 * adapter; we pass the canonical values anyway so the calldata reads sanely on
 * a block explorer.
 */
export function buildRedeemCall(negRisk: boolean, conditionId: Hex): { target: Hex; data: Hex } {
  return {
    target: (negRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER : CTF_COLLATERAL_ADAPTER) as Hex,
    data: encodeFunctionData({
      abi: ERC1155_ABI,
      functionName: "redeemPositions",
      args: [PUSD_COLLATERAL as Hex, "0x0000000000000000000000000000000000000000000000000000000000000000", conditionId, [1n, 2n]],
    }),
  };
}

/**
 * Did the redeem actually consume something we held?
 *
 * A transaction hash is not proof: redeeming through the wrong collateral path
 * burns a positionId nobody holds, which SUCCEEDS on-chain having done nothing
 * (CTF redeemPositions never reverts on a zero balance). Only a DECREASE in a
 * balance that was non-zero before proves the position was consumed.
 *
 * Conservative on length mismatch: a missing `after` entry reads as unchanged,
 * i.e. "not redeemed", so a truncated read can never fake success.
 *
 * Pure and exported for tests. Design from @KillerQueen-Z's #66.
 */
export function didRedeemAnyHeldPosition(before: readonly bigint[], after: readonly bigint[]): boolean {
  return before.some((balance, index) => balance > 0n && (after[index] ?? balance) < balance);
}

export async function redeemPosition(input: { condition_id?: string; confirm?: boolean }): Promise<ToolResult> {
  if (!input.condition_id) {
    return { text: `Pass condition_id:"0x…" (see action:"positions" for redeemable markets).`, isError: true };
  }
  const conditionId = input.condition_id as Hex;

  let owner: Hex;
  try {
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Market metadata (question, outcome tokens, negRisk) via the CLOB.
    const clob = await getClobClient();
    const market = (await clob.getMarket(conditionId)) as {
      question?: string;
      neg_risk?: boolean;
      closed?: boolean;
      tokens?: ClobMarketToken[];
    };
    const tokens = (market?.tokens ?? []).filter((t) => t.token_id);
    if (!tokens.length) return { text: `No tokens found for condition ${conditionId}.`, isError: true };

    // Exact on-chain balances per outcome token — the redeem amounts.
    const pc = getPublicClient();
    const balances: bigint[] = [];
    for (const t of tokens) {
      balances.push(
        await pc.readContract({
          address: CONDITIONAL_TOKENS as Hex,
          abi: ERC1155_ABI,
          functionName: "balanceOf",
          args: [owner, BigInt(t.token_id as string)],
        }),
      );
    }
    if (balances.every((b) => b === 0n)) {
      return { text: `Nothing to redeem: ${owner} holds no outcome tokens for "${market?.question ?? conditionId}".`, isError: true };
    }

    // negRisk picks WHICH adapter redeems — the wrong one is the silent
    // no-op this module was rewritten to kill. A missing field is not "false":
    // if the market payload omits it (API shape drift), cross-check the order
    // book, and refuse rather than guess if that's missing too. Guessing wrong
    // is caught post-hoc by no_effect_detected, but only after burning a
    // relayer transaction and confusing the caller (issue #72 finding 3).
    let negRiskRaw: boolean | undefined = market?.neg_risk;
    if (negRiskRaw === undefined) {
      const book = (await clob.getOrderBook(tokens[0].token_id as string).catch(() => null)) as { neg_risk?: boolean } | null;
      negRiskRaw = book?.neg_risk;
    }
    if (typeof negRiskRaw !== "boolean") {
      return {
        text: `Cannot determine whether "${market?.question ?? conditionId}" is a neg-risk market (neither the ` +
          `market metadata nor the order book carries neg_risk) — refusing to guess, because the wrong collateral ` +
          `adapter redeems 0. Retry shortly; if this persists, report it.`,
        isError: true,
      };
    }
    const negRisk = negRiskRaw;
    const held = tokens
      .map((t, i) => ({ outcome: t.outcome, winner: t.winner, shares: Number(balances[i]) / 10 ** PUSD_DECIMALS }))
      .filter((h) => h.shares > 0);
    const heldText = held
      .map((h) => `  ${h.shares.toFixed(2)} × "${h.outcome}"${h.winner ? " (winner → pays $1/share)" : ""}`)
      .join("\n");

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing redeemed.`,
          `Market: ${market?.question ?? conditionId}${market?.closed === false ? " ⚠️ (not closed yet — redeem will revert until resolution)" : ""}`,
          `Holdings:`,
          heldText,
          ``,
          `Re-call with confirm:true to redeem the FULL balance (Polymarket redeems`,
          `everything for the condition; partial redemption is not supported).`,
        ].join("\n"),
        structured: { dryRun: true, conditionId, negRisk, holdings: held },
      };
    }

    // The dry-run only WARNED about an unresolved market; the confirm path
    // then happily submitted a batch that reverts on-chain (CTF requires
    // payoutDenominator > 0). No fund risk, but a wasted relayer transaction
    // and a confusing failure — refuse up front instead (issue #72 finding 6).
    if (market?.closed === false) {
      return {
        text: `"${market?.question ?? conditionId}" is not closed/resolved yet — redeeming now would revert ` +
          `on-chain. Wait for resolution, then re-run action:"redeem".`,
        isError: true,
      };
    }

    const { target, data } = buildRedeemCall(negRisk, conditionId);

    // Balance BEFORE the tx so the success message can report the actual
    // payout delta — "tx succeeded" alone is NOT proof anything was paid
    // (that deception is the exact bug class this path was rewritten to fix).
    const balanceBefore = await getPusdBalance(owner).catch(() => null);

    let txHash: string | undefined;
    if (getSigType() === 3) {
      const res = await sendWalletBatch([{ target, value: "0", data }], owner, "Redeem", {
        guidance: 're-run action:"positions" to see whether the position was consumed before retrying',
      });
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      txHash = await wallet.sendTransaction({ to: target, data, chain: polygon, account });
      assertTransactionSucceeded(
        await pc.waitForTransactionReceipt({ hash: txHash as Hex }),
        "redeem transaction",
        txHash,
      );
    }

    // Two INDEPENDENT questions, and a redeem is only proven by answering both:
    //   1. did my outcome tokens actually burn?   (ERC-1155 balances, below)
    //   2. did I actually get paid?               (pUSD delta, further down)
    // Until 0.32.6 only (2) was checked. A receipt plus a pUSD balance that
    // happens to look right is not proof the position was consumed — the
    // wrong-collateral no-op that started all of this burns nothing and
    // reverts nothing. Token-effect verification per @KillerQueen-Z's #66.
    //
    // Retry the read: a receipt can land before every public RPC reflects its
    // state, and reporting "your tokens did not burn" off a lagging node is a
    // false alarm on a money operation.
    let balancesAfter: bigint[] | null = null;
    for (let attempt = 0; attempt < 3 && balancesAfter === null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
      balancesAfter = await Promise.all(tokens.map((t) => pc.readContract({
        address: CONDITIONAL_TOKENS as Hex,
        abi: ERC1155_ABI,
        functionName: "balanceOf",
        args: [owner, BigInt(t.token_id as string)],
      }))).catch(() => null);
    }

    const balanceAfter = await getPusdBalance(owner).catch(() => null);
    const paidOut = balanceBefore !== null && balanceAfter !== null ? balanceAfter - balanceBefore : null;
    const heldWinner = held.some((h) => h.winner);

    // "We could not check" and "we checked and nothing burned" are different
    // facts that need different actions from the caller, so they get different
    // statuses. Collapsing them is what made the original bug invisible.
    if (balancesAfter === null) {
      return {
        text: [
          `⚠️ Redeem transaction confirmed, but its token effect could NOT be verified — the Polygon RPC read failed after 3 attempts.`,
          `This is "the transaction landed", not "you were paid". Do not retry blindly:`,
          `inspect the transaction, then re-run action:"positions" once the RPC recovers.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: {
          status: "confirmed_but_unverified", conditionId, negRisk, transactionHash: txHash,
          paidOutUsd: paidOut, pusdBalance: balanceAfter, tokensBurned: null, payoutVerified: paidOut !== null,
        },
        isError: true,
      };
    }
    if (!didRedeemAnyHeldPosition(balances, balancesAfter)) {
      return {
        text: [
          `⚠️ Redeem transaction confirmed, but NO held outcome tokens were consumed.`,
          `Nothing was redeemed. Your outcome tokens are NOT lost — this points at an`,
          `unexpected collateral route or a missing CTF operator approval for the`,
          `collateral adapter. Re-run action:"setup" to check approvals, then retry.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: {
          status: "no_effect_detected", conditionId, negRisk, transactionHash: txHash,
          paidOutUsd: paidOut, pusdBalance: balanceAfter, tokensBurned: false, payoutVerified: paidOut !== null,
        },
        isError: true,
      };
    }
    if (paidOut !== null && paidOut <= 0 && heldWinner) {
      return {
        text: [
          `⚠️ Redeem transaction succeeded but paid out $0 while winning tokens were held.`,
          `This should not happen — the market may be routed to the wrong adapter or not fully`,
          `resolved on-chain yet. Your outcome tokens are NOT lost; re-run action:"positions"`,
          `to check, wait a few minutes, then retry. If it persists, report it.`,
          ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ].join("\n"),
        structured: { conditionId, negRisk, transactionHash: txHash, paidOutUsd: 0, pusdBalance: balanceAfter },
        isError: true,
      };
    }
    return {
      text: [
        `✅ Redeemed "${market?.question ?? conditionId}".`,
        heldText,
        // paidOut === null means a balance read failed, which ALSO makes the
        // "paid $0 while holding a winner" guard above unreachable. Silently
        // omitting the payout line then rendered identically to a verified
        // payout — the exact size=0 silent-loss shape this module was rewritten
        // to kill. Say which one it is.
        ...(paidOut !== null
          ? [`  Paid out: $${paidOut.toFixed(2)} pUSD`]
          : [`  ⚠️ Payout UNVERIFIED — the pUSD balance read failed, so this is "the tx landed", not "you were paid". Re-run action:"positions" to confirm.`]),
        ...(txHash ? [`  tx: https://polygonscan.com/tx/${txHash}`] : []),
        ...(balanceAfter !== null ? [`  Funds wallet pUSD balance: $${balanceAfter.toFixed(2)}`] : []),
      ].join("\n"),
      structured: {
        status: "redeemed", conditionId, negRisk, transactionHash: txHash,
        paidOutUsd: paidOut, pusdBalance: balanceAfter, tokensBurned: true, payoutVerified: paidOut !== null,
      },
    };
  } catch (err) {
    const base = await mapClobError(err);
    // The adapter pulls tokens via safeBatchTransferFrom — a vault set up
    // before the collateral-adapter approvals were added reverts here.
    const approvalHint = ` If the transaction reverted, the wallet may be missing the collateral-adapter ` +
      `approval (added 2026-07) — run action:"setup" confirm:true once to grant it, then retry.`;
    return { text: `${base}${/revert|execution reverted|failed/i.test(base) ? approvalHint : ""}`, isError: true };
  }
}
