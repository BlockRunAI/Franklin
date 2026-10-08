// src/utils/polymarket/withdraw.ts
//
// Cash out: collateral in the deposit wallet → native USDC on Base, delivered
// to the BlockRun agent wallet (the same key/address that pays x402 AI fees) —
// closing the loop. Flow (Polymarket bridge):
//   1. POST /withdraw {address, toChainId, toTokenAddress, recipientAddr} → a
//      one-time EVM bridge address.
//   2. Transfer pUSD FROM the deposit wallet TO that bridge address (gasless
//      relayer WALLET batch; or a direct tx in EOA mode). The amount sent IS the
//      withdrawal amount.
//   3. The bridge unwraps pUSD → USDC (Collateral Offramp + Uniswap v3) and
//      sends it to recipientAddr on Base. Instant, no Polymarket fee (minor
//      swap slippage may apply).
//
// Legacy USDC.e: adapter redemptions pay pUSD, but historic direct-CTF
// redemptions left USDC.e in the wallet, which the bridge does not accept and
// which action:"withdraw" previously could not see at all. Withdrawable
// balance is now pUSD + USDC.e; any shortfall beyond the pUSD on hand is
// wrapped to pUSD through the collateral onramp first (sweep design from
// @KillerQueen-Z's #59/#66, tracked in #71).
import axios from "axios";
import { encodeFunctionData, formatUnits, http, createWalletClient, type Hex } from "viem";
import { polygon } from "viem/chains";
import {
  BASE_CHAIN_ID,
  BASE_USDC,
  BRIDGE_API_HOST,
  COLLATERAL_ONRAMP,
  ERC20_ABI,
  getBuilderCode,
  getSigType,
  POLYGON_WRITE_RPC_URL,
  PUSD_COLLATERAL,
  PUSD_DECIMALS,
  USDCE_COLLATERAL,
} from "./constants.js";
import { getPolymarketAccount } from "./client.js";
import { assertTransactionSucceeded } from "./transactions.js";
import type { ToolResult } from "./orders.js";
import { mapClobError } from "./orders.js";
import { getFundsAddress } from "./positions.js";
import { loadState, saveState } from "./creds.js";
import { getRelayerTransactionState, sendWalletBatch } from "./relayer.js";
import { getPublicClient } from "./setup.js";
// franklin-local: identify an EOA transfer before handing it to the RPC.
import { keccak256 } from "viem";

async function rawTokenBalance(token: Hex, owner: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

// wrap(_asset, _to, _amount) — verified against the Sourcify exact-match
// source of COLLATERAL_ONRAMP (2026-07-21). Pulls `_amount` of `_asset` from
// the caller (needs the ERC-20 approval batched before it) and mints pUSD to
// `_to`.
const COLLATERAL_ONRAMP_ABI = [{
  type: "function",
  name: "wrap",
  stateMutability: "nonpayable",
  inputs: [
    { name: "_asset", type: "address" },
    { name: "_to", type: "address" },
    { name: "_amount", type: "uint256" },
  ],
  outputs: [],
}] as const;

/** Approve-then-wrap calls for sweeping legacy USDC.e into pUSD. Exported for tests. */
export function buildLegacyWrapCalls(owner: Hex, amount: bigint): Array<{ target: Hex; value: "0"; data: Hex }> {
  return [
    {
      target: USDCE_COLLATERAL as Hex,
      value: "0",
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [COLLATERAL_ONRAMP as Hex, amount] }),
    },
    {
      target: COLLATERAL_ONRAMP as Hex,
      value: "0",
      data: encodeFunctionData({ abi: COLLATERAL_ONRAMP_ABI, functionName: "wrap", args: [USDCE_COLLATERAL as Hex, owner, amount] }),
    },
  ];
}

/**
 * Parse a dollar amount into micro-pUSD without silently changing what the
 * caller asked for. The old `BigInt(Math.floor(usd * 1e6))` truncated float
 * noise downward — `19.99 * 1e6` is 19_989_999.999…, i.e. a cent less than
 * requested. Round to the nearest micro-dollar and reject anything that isn't
 * representable (over-precision, negatives, NaN). Exported for tests.
 */
export function parseUsdAmount(amount: number): bigint | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scaled = amount * 10 ** PUSD_DECIMALS;
  const rounded = Math.round(scaled);
  // 0.01 micro-dollars separates the two populations cleanly: float noise on a
  // representable amount is ≤ ~1e-4 micro even at $1M (ulp-scale), while a
  // genuine 7th-decimal digit is ≥ 0.1 micro. An absolute 1e-7 bound (the
  // first draft) sat BELOW the noise floor and rejected honest amounts like
  // $1234.56 (noise 2.4e-7); a relative bound sat above real violations.
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || Math.abs(scaled - rounded) > 0.01) {
    return null;
  }
  return BigInt(rounded);
}

/** Re-read pUSD until it reaches `minimum` (post-wrap RPC lag), 3×750ms. */
async function readPusdUntil(owner: Hex, minimum: bigint): Promise<bigint> {
  let observed = 0n;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    observed = await rawTokenBalance(PUSD_COLLATERAL as Hex, owner);
    if (observed >= minimum) return observed;
  }
  return observed;
}

// franklin-local: RPC rejections that prove a node refused (and so never
// relayed) a raw transaction. "already known" is deliberately absent: it means
// the node HAS the transaction. So is "nonce too low": nonce movement is not
// evidence about which transaction used the nonce.
const DEFINITE_REJECTION_RE =
  /insufficient funds|intrinsic gas too low|max fee per gas less than block base fee|transaction underpriced|invalid sender/i;

function isDefiniteBroadcastRejection(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
    if (DEFINITE_REJECTION_RE.test(msg)) return true;
  }
  return false;
}

/** True unless the RPC positively reports the hash as unknown. Read errors count as known (fail closed). */
async function transactionKnown(hash: Hex): Promise<boolean> {
  try {
    await getPublicClient().getTransaction({ hash });
    return true;
  } catch (err) {
    return !(err instanceof Error && err.name === "TransactionNotFoundError");
  }
}

type PendingWithdraw = NonNullable<ReturnType<typeof loadState>["pendingWithdraw"]>;

/**
 * franklin-local: the EOA withdrawal's on-chain outcome, or null while unknown.
 * Only a receipt resolves it. An advanced account nonce plus an RPC that does
 * not know our hash proves nothing — the RPC may lag, or our transaction may
 * be the one that used the nonce — so it is never read as "dropped". While
 * unknown, the same signed bytes are re-broadcast (same nonce, so at most one
 * transfer can ever execute) — never a fresh signature.
 */
async function eoaPendingStatus(pending: PendingWithdraw): Promise<"success" | "reverted" | null> {
  const receipt = await getPublicClient().getTransactionReceipt({ hash: pending.txHash as Hex }).catch(() => null);
  if (receipt) return receipt.status === "success" ? "success" : "reverted";
  if (pending.serializedTransaction) {
    const account = getPolymarketAccount();
    const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
    await wallet.sendRawTransaction({ serializedTransaction: pending.serializedTransaction as Hex }).catch(() => undefined);
  }
  return null;
}

const WITHDRAW_GUIDANCE =
  'check the pUSD balance with action:"setup" and the bridge status endpoint before ANY retry — ' +
  "a resubmitted withdrawal signs a SECOND transfer and can double-send";

interface WithdrawInput {
  amount_usd?: number;
  to_address?: string;
  confirm?: boolean;
}

export async function withdrawFunds(input: WithdrawInput): Promise<ToolResult> {
  let owner: Hex;
  let recipient: Hex;
  try {
    // franklin-local: this is the agent's x402 signer, not the deposit wallet.
    recipient = getPolymarketAccount().address;
    if (input.to_address !== undefined && (typeof input.to_address !== "string" || input.to_address.toLowerCase() !== recipient.toLowerCase())) {
      return {
        text: "Withdraw to your agent wallet first; moving funds to an external address is not something the agent does on its own.",
        isError: true,
      };
    }
    owner = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    // Refuse to sign while an earlier withdrawal batch may still land: its
    // signature stays executable until its deadline, and a second signed
    // transfer on top of it double-sends (issue #72 finding 1). Resolved
    // states clear the guard; the balance reads below then reflect reality.
    const pending = loadState().pendingWithdraw;
    if (pending && input.confirm === true) {
      const graceSec = 60; // relayer can mine right at the deadline; don't race it
      // franklin-local: resolving an earlier withdrawal ENDS this call. The
      // retry that finds the first transfer settled is the same call that
      // would otherwise sign a second one on top of it — the double-send this
      // guard exists to stop. The outcome is reported; another withdrawal
      // needs a fresh, deliberate call.
      let resolution: string | null = null;
      if (pending.txHash) {
        // franklin-local: EOA transfers have no deadline; only a receipt proves resolution.
        const status = await eoaPendingStatus(pending);
        if (status === null) {
          return {
            text: `A previous withdrawal (${pending.txHash}) has no receipt and may still land — it was re-broadcast ` +
              `as the same signed transaction. Do not retry; check the balance again in a few minutes.`,
            isError: true,
          };
        }
        resolution = status === "success"
          ? `The previous withdrawal SETTLED on-chain (tx ${pending.txHash}).`
          : `The previous withdrawal REVERTED on-chain (tx ${pending.txHash}); no pUSD moved.`;
      // franklin-local: an unacknowledged batch cannot be queried, but can still execute.
      } else if (pending.deadline === undefined || Math.floor(Date.now() / 1000) < pending.deadline + graceSec) {
        const state = pending.transactionID ? await getRelayerTransactionState(pending.transactionID) : undefined;
        if (state === "STATE_MINED" || state === "STATE_CONFIRMED") {
          resolution = `The previous withdrawal SETTLED (relayer tx ${pending.transactionID}, ${state}).`;
        } else if (state === "STATE_FAILED" || state === "STATE_INVALID") {
          resolution = `The previous withdrawal FAILED (relayer tx ${pending.transactionID}, ${state}); no pUSD moved.`;
        } else {
          const waitSecs = pending.deadline === undefined ? "unknown" : pending.deadline + graceSec - Math.floor(Date.now() / 1000);
          return {
            text: `A previous withdrawal (relayer tx ${pending.transactionID ?? "unacknowledged"}, state: ${state ?? "unreachable"}) ` +
              `may still execute — its signed transfer stays valid for up to ~${waitSecs}s more. Signing another ` +
              `one now could double-send. Re-run after that window, when the balance reads will show what happened.`,
            isError: true,
          };
        }
      } else {
        // Deadline long past: the batch can no longer execute, but it may
        // already have, so this is not proof that nothing moved.
        resolution = `The previous withdrawal's signature expired (relayer tx ${pending.transactionID ?? "unacknowledged"}). ` +
          `It may or may not have executed before its deadline.`;
      }
      saveState({ pendingWithdraw: undefined });
      return {
        text: `${resolution} Nothing new was signed. Check the balances (action:"setup") and the bridge status ` +
          `before deciding whether ANOTHER withdrawal is wanted; only then call withdraw again.`,
        isError: true,
        structured: { previousWithdrawal: resolution },
      };
    }

    // Withdrawable = pUSD + legacy USDC.e (wrapped on demand below).
    const [pusdRaw, usdceRaw] = await Promise.all([
      rawTokenBalance(PUSD_COLLATERAL as Hex, owner),
      rawTokenBalance(USDCE_COLLATERAL as Hex, owner),
    ]);
    const totalRaw = pusdRaw + usdceRaw;
    const totalUsd = Number(formatUnits(totalRaw, PUSD_DECIMALS));
    if (totalRaw === 0n) {
      return { text: `No pUSD or USDC.e to withdraw — the deposit wallet ${owner} holds $0. (Redeem/sell a position first.)`, isError: true };
    }
    const amountRaw = input.amount_usd !== undefined ? parseUsdAmount(input.amount_usd) : totalRaw;
    if (amountRaw === null) {
      return { text: `amount_usd must be a positive USD amount with at most ${PUSD_DECIMALS} decimal places.`, isError: true };
    }
    if (amountRaw > totalRaw) {
      return { text: `Requested $${input.amount_usd} exceeds the withdrawable collateral balance of $${totalUsd.toFixed(2)}.`, isError: true };
    }
    const amountUsd = Number(formatUnits(amountRaw, PUSD_DECIMALS));
    const wrapRaw = amountRaw > pusdRaw ? amountRaw - pusdRaw : 0n;

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing withdrawn.`,
          `Withdraw $${amountUsd.toFixed(2)} → native USDC on Base`,
          `  from deposit wallet: ${owner}`,
          `  to (agent wallet): ${recipient}`,
          ...(wrapRaw > 0n
            ? [``, `  First wrap: $${Number(formatUnits(wrapRaw, PUSD_DECIMALS)).toFixed(2)} legacy USDC.e → pUSD (collateral onramp, same wallet)`]
            : []),
          ``,
          `pUSD is unwrapped to USDC (Uniswap v3 — minor slippage may apply); instant, no Polymarket fee.`,
          `Re-call with confirm:true to execute.`,
        ].join("\n"),
        structured: {
          dryRun: true, amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC,
          pusdUsd: Number(formatUnits(pusdRaw, PUSD_DECIMALS)),
          usdceUsd: Number(formatUnits(usdceRaw, PUSD_DECIMALS)),
          wrapUsd: Number(formatUnits(wrapRaw, PUSD_DECIMALS)),
        },
      };
    }

    // 0. Sweep legacy USDC.e → pUSD when the pUSD on hand can't cover the
    //    amount. Wrapping keeps funds in the SAME wallet (a re-run after a
    //    partial failure is safe), so this batch is not double-spend-tracked.
    if (wrapRaw > 0n) {
      const [approveCall, wrapCall] = buildLegacyWrapCalls(owner, wrapRaw);
      if (getSigType() === 3) {
        await sendWalletBatch([approveCall, wrapCall], owner, "Wrap legacy USDC.e", {
          guidance: 're-run action:"withdraw" — wrapping keeps funds in your wallet, so retrying is safe',
        });
      } else {
        const account = getPolymarketAccount();
        const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
        const approveHash = await wallet.sendTransaction({ to: approveCall.target, data: approveCall.data, chain: polygon, account });
        assertTransactionSucceeded(await getPublicClient().waitForTransactionReceipt({ hash: approveHash }), "USDC.e approval", approveHash);
        const wrapHash = await wallet.sendTransaction({ to: wrapCall.target, data: wrapCall.data, chain: polygon, account });
        assertTransactionSucceeded(await getPublicClient().waitForTransactionReceipt({ hash: wrapHash }), "USDC.e wrap", wrapHash);
      }
      const normalizedPusd = await readPusdUntil(owner, amountRaw);
      if (normalizedPusd < amountRaw) {
        throw new Error(
          "The USDC.e wrap confirmed but the required pUSD balance is not yet visible after 3 reads. " +
          "Your funds are in your wallet (wrapping moves nothing out) — re-run action:\"withdraw\" in a minute.",
        );
      }
    }

    // 1. Ask the bridge for a one-time deposit address for this withdrawal.
    const headers: Record<string, string> = { "content-type": "application/json" };
    const builderCode = getBuilderCode();
    if (builderCode) headers["X-Builder-Code"] = builderCode;
    const wres = await axios.post(
      `${BRIDGE_API_HOST}/withdraw`,
      { address: owner, toChainId: String(BASE_CHAIN_ID), toTokenAddress: BASE_USDC, recipientAddr: recipient },
      { headers, timeout: 20_000 },
    );
    const bridgeEvm = (wres.data as { address?: { evm?: string } })?.address?.evm as Hex | undefined;
    if (!bridgeEvm) {
      return { text: `Bridge did not return a withdrawal address (got: ${JSON.stringify(wres.data)}).`, isError: true };
    }

    // 2. Transfer pUSD from the deposit wallet to the bridge address.
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [bridgeEvm, amountRaw] });
    let txHash: string | undefined;
    if (getSigType() === 3) {
      const res = await sendWalletBatch([{ target: PUSD_COLLATERAL, value: "0", data }], owner, "Withdraw", {
        guidance: WITHDRAW_GUIDANCE,
        trackPendingWithdraw: true,
      });
      txHash = res.transactionHash;
    } else {
      const account = getPolymarketAccount();
      const wallet = createWalletClient({ account, chain: polygon, transport: http(POLYGON_WRITE_RPC_URL) });
      // franklin-local: hash the locally signed bytes and persist before any broadcast.
      // franklin-local: the nonce comes from the WRITE endpoint
      // (prepareTransactionRequest asks the wallet's own transport), not the
      // fallback public readers, which are separate providers with their own
      // pending pools. A load-balanced write URL can still answer from a
      // different backend than the broadcast; safety does not rest on this —
      // the bytes are persisted first and a retry re-sends only those.
      const request = await wallet.prepareTransactionRequest({ to: PUSD_COLLATERAL as Hex, data, chain: polygon, account });
      const nonce = request.nonce;
      const serializedTransaction = await wallet.signTransaction(request);
      txHash = keccak256(serializedTransaction);
      saveState({ pendingWithdraw: { txHash, nonce, from: account.address, serializedTransaction } });
      try {
        await wallet.sendRawTransaction({ serializedTransaction });
      } catch (err) {
        // franklin-local: a node that rejected these bytes outright never
        // relayed them, so only that case may release the guard. Anything
        // ambiguous (timeout, 5xx) keeps it until a receipt says otherwise.
        if (isDefiniteBroadcastRejection(err) && !(await transactionKnown(txHash as Hex))) {
          saveState({ pendingWithdraw: undefined });
        }
        throw err;
      }
      // viem does NOT throw on a reverted tx — it resolves with status:"reverted".
      // Discarding the receipt meant a REVERTED pUSD transfer still printed
      // "✅ Withdrawal submitted … the bridge delivers USDC to Base" with a link
      // to the failed tx and no isError, so the user waited for money that was
      // never sent and blamed the bridge. redeem.ts and setup.ts both assert
      // status; this path was the one that did not.
      // franklin-local: either receipt status resolves the guard; timeouts retain it.
      const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash as Hex });
      saveState({ pendingWithdraw: undefined });
      assertTransactionSucceeded(receipt, "pUSD transfer", txHash);
    }

    return {
      text: [
        `✅ Withdrawal submitted: $${amountUsd.toFixed(2)} → USDC on Base`,
        ...(wrapRaw > 0n ? [`  (included wrapping $${Number(formatUnits(wrapRaw, PUSD_DECIMALS)).toFixed(2)} legacy USDC.e → pUSD first)`] : []),
        `  to your agent wallet: ${recipient}`,
        ...(txHash ? [`  pUSD transfer tx: https://polygonscan.com/tx/${txHash}`] : []),
        `  The bridge unwraps + delivers USDC to Base (usually within a minute).`,
        `  Track: GET ${BRIDGE_API_HOST}/status/${owner}`,
      ].join("\n"),
      structured: {
        amountUsd, from: owner, to: recipient, toChainId: BASE_CHAIN_ID, toToken: BASE_USDC,
        bridgeAddress: bridgeEvm, transactionHash: txHash,
        ...(wrapRaw > 0n ? { wrappedUsdceUsd: Number(formatUnits(wrapRaw, PUSD_DECIMALS)) } : {}),
      },
    };
  } catch (err) {
    return { text: await mapClobError(err), isError: true };
  }
}
