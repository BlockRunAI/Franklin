// src/utils/polymarket/fund.ts
//
// action:"fund" — top up the Polymarket deposit wallet from the agent's OWN Base
// USDC, gaslessly, in one call. NON-CUSTODIAL: the agent signs an EIP-3009
// authorization transferring USDC (Base) DIRECTLY to the Polymarket bridge
// address for its vault; BlockRun's /v1/polymarket/fund endpoint hands it to the
// CDP facilitator (which broadcasts + pays gas) and charges a $0.01 fee. The
// principal never touches a BlockRun wallet — it goes agent → bridge → vault
// (wrapped to pUSD). The agent needs ZERO Base ETH for gas.
import axios from "axios";
import type { Hex } from "viem";
import { BlockrunClient, createPaymentPayload } from "@blockrun/llm";
import { getOrCreateWalletKey, getChainBalance } from "./wallet-key.js";
import { getPolymarketAccount } from "./client.js";
import { BASE_CHAIN_ID, BRIDGE_API_HOST, getSigType } from "./constants.js";
import { getFundsAddress } from "./positions.js";
import { getPublicClient } from "./setup.js";
import type { ToolResult } from "./orders.js";

const FUND_FEE_USD = 0.01;
const USDC_DECIMALS = 6;
// The Polymarket bridge does NOT process Base-USDC deposits below this — a
// smaller amount lands at the bridge address but is never wrapped/delivered to
// the vault (verified live: a $0.10 deposit confirmed on Base but never reached
// the vault). Override with POLYMARKET_FUND_MIN_USD if the bridge minimum moves.
const FUND_MIN_USD = Number(process.env.POLYMARKET_FUND_MIN_USD || "2");

/** Bridge deposit address for a Polymarket vault (delivers pUSD to the vault). */
async function bridgeAddressFor(vault: string): Promise<string> {
  const res = await axios.post(
    `${BRIDGE_API_HOST}/deposit`,
    { address: vault },
    { headers: { "content-type": "application/json" }, timeout: 20_000 },
  );
  const evm = (res.data as { address?: { evm?: string } })?.address?.evm;
  if (!evm) throw new Error(`Bridge did not return a deposit address (got: ${JSON.stringify(res.data)}).`);
  return evm;
}

export async function fundVault(input: { amount_usd?: number; confirm?: boolean }): Promise<ToolResult> {
  if (input.amount_usd === undefined || input.amount_usd <= 0) {
    return { text: `Pass amount_usd — the USDC amount to move from your Base wallet into your Polymarket vault (e.g. amount_usd:5).`, isError: true };
  }
  if (input.amount_usd < FUND_MIN_USD) {
    return {
      text: `Minimum funding is $${FUND_MIN_USD} — the Polymarket bridge does not process smaller Base-USDC deposits ` +
        `(a smaller amount would confirm on Base but never wrap to pUSD in your vault). Use amount_usd ≥ ${FUND_MIN_USD}.`,
      isError: true,
    };
  }
  const amountUsd = input.amount_usd;

  let vault: Hex;
  try {
    vault = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  const agent = getPolymarketAccount().address;

  try {
    // The deposit wallet must be DEPLOYED before funding: the bridge delivers
    // pUSD to the vault contract, and it can't credit a vault that doesn't
    // exist on-chain yet (verified live — funding an undeployed vault let the
    // bridge sweep the USDC but never deliver pUSD). Correct order is
    // setup(deploy) → fund. EOA mode (the funds ARE the EOA) is exempt.
    if (getSigType() === 3) {
      const code = await getPublicClient().getCode({ address: vault }).catch(() => undefined);
      if (!code || code === "0x") {
        return {
          text: `Your deposit wallet ${vault} is not deployed yet — deploy it FIRST with ` +
            `action:"setup" confirm:true (needs relayer creds), then fund. Funding an undeployed ` +
            `vault strands your USDC at the bridge (it can't deliver pUSD to a vault that doesn't exist).`,
          isError: true,
        };
      }
    }

    const baseBalance = (await getChainBalance("base", agent)) ?? 0;
    const needed = amountUsd + FUND_FEE_USD;
    if (baseBalance < needed) {
      return {
        text: `Your Base wallet ${agent} holds $${baseBalance.toFixed(2)} USDC — need $${needed.toFixed(2)} ` +
          `($${amountUsd.toFixed(2)} deposit + $${FUND_FEE_USD} fee). Top up your Base USDC first.`,
        isError: true,
      };
    }

    const bridge = await bridgeAddressFor(vault);

    if (input.confirm !== true) {
      return {
        text: [
          `DRY RUN — nothing moved.`,
          `Fund your Polymarket vault with $${amountUsd.toFixed(2)} USDC (gasless):`,
          `  from Base wallet: ${agent}`,
          `  → bridge:         ${bridge}`,
          `  → wraps to pUSD in your vault: ${vault}`,
          `  fee: $${FUND_FEE_USD} (BlockRun pays the Base gas; you need no ETH)`,
          ``,
          `Re-call with confirm:true to sign and submit.`,
        ].join("\n"),
        structured: { dryRun: true, amountUsd, agent, bridge, vault, feeUsd: FUND_FEE_USD },
      };
    }

    // Sign the EIP-3009 deposit authorization: Base USDC → bridge address.
    const privateKey = getOrCreateWalletKey();
    const amountMicro = String(Math.floor(amountUsd * 10 ** USDC_DECIMALS));
    const depositAuthorization = await createPaymentPayload(
      privateKey, agent, bridge, amountMicro, `eip155:${BASE_CHAIN_ID}`,
    );

    // Call the gateway fund endpoint — it charges $0.01 via x402 automatically
    // and relays the deposit authorization to the CDP facilitator (pays gas).
    const client = new BlockrunClient({ privateKey });
    const result = (await client.post("/v1/polymarket/fund", {
      depositWallet: vault,
      recipient: bridge,
      amountMicro,
      depositAuthorization,
    })) as {
      success?: boolean;
      funded?: boolean;
      creditPending?: boolean;
      deposit?: { txHash?: string; amountUsd?: number };
      fee?: { txHash?: string };
      error?: string;
    };

    if (!result?.success) {
      return { text: `Funding failed: ${result?.error ?? JSON.stringify(result)}`, isError: true };
    }

    // success:true = the deposit was SUBMITTED to the bridge + fee charged on
    // Base. It does NOT mean the vault is funded: the Polymarket bridge credits
    // pUSD on Polygon asynchronously (usually minutes, occasionally 30+),
    // off-chain and un-pollable here — don't claim "Funded" (issue #226).
    return {
      text: [
        `✅ Deposit of $${amountUsd.toFixed(2)} USDC submitted to the Polymarket bridge (gasless).`,
        `  from Base wallet: ${agent}`,
        ...(result.deposit?.txHash ? [`  deposit tx: https://basescan.org/tx/${result.deposit.txHash}`] : []),
        `  ⏳ pUSD credit to your vault ${vault} is PENDING — the bridge settles on Polygon`,
        `     asynchronously (usually minutes, occasionally 30+). Re-run action:"setup"`,
        `     and watch for the pUSD balance; it is not instant.`,
        `  Fee charged: $${FUND_FEE_USD}.`,
      ].join("\n"),
      structured: {
        success: true,
        funded: false,
        creditPending: true,
        amountUsd,
        agent,
        bridge,
        vault,
        deposit: result.deposit,
        fee: result.fee,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Funding error: ${msg}`, isError: true };
  }
}
