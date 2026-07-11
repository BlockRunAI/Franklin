// src/utils/polymarket/positions.ts
//
// Positions via Polymarket's free, unauthenticated Data-API — deliberately NOT
// the paid Predexon route in blockrun_markets (don't pay for what's free). If
// the Data-API is down, the error text points at the paid fallback.
import axios from "axios";
import type { Hex } from "viem";
import { getPolymarketAccount } from "./client.js";
import { DATA_API_HOST, getSigType } from "./constants.js";
import { loadDepositWalletForSigner } from "./creds.js";
import type { ToolResult } from "./orders.js";

/** The wallet that actually holds funds/positions for the active sig mode. */
export function getFundsAddress(): Hex {
  const account = getPolymarketAccount();
  if (getSigType() === 3) {
    const depositWallet = loadDepositWalletForSigner(account.address) as Hex | undefined;
    if (!depositWallet) {
      throw new Error(`No deposit wallet configured for this signer yet — run blockrun_polymarket action:"setup" first.`);
    }
    return depositWallet;
  }
  return account.address;
}

export interface DataApiPosition {
  asset?: string;
  conditionId?: string;
  title?: string;
  outcome?: string;
  outcomeIndex?: number;
  size?: number;
  avgPrice?: number;
  curPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  redeemable?: boolean;
  negativeRisk?: boolean;
}

const POSITIONS_PAGE = 100;
const POSITIONS_MAX = 500;

/**
 * Fetch positions with offset pagination so wallets with >100 holdings aren't
 * silently truncated (a redeemable winner sorted past the first page would
 * otherwise be invisible). Bounded at POSITIONS_MAX pages of safety.
 */
export async function fetchPositions(user: string): Promise<DataApiPosition[]> {
  const all: DataApiPosition[] = [];
  for (let offset = 0; offset < POSITIONS_MAX; offset += POSITIONS_PAGE) {
    const res = await axios.get(`${DATA_API_HOST}/positions`, {
      params: { user, limit: POSITIONS_PAGE, offset },
      timeout: 15_000,
    });
    const page = Array.isArray(res.data) ? (res.data as DataApiPosition[]) : [];
    all.push(...page);
    if (page.length < POSITIONS_PAGE) break;
  }
  return all;
}

export async function listPositions(): Promise<ToolResult> {
  let user: Hex;
  try {
    user = getFundsAddress();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }

  try {
    const positions = await fetchPositions(user);
    if (!positions.length) {
      return {
        text: `No positions for ${user}.`,
        structured: { user, positions: [] },
      };
    }

    const fmtUsd = (n: number | undefined) => (typeof n === "number" ? `$${n.toFixed(2)}` : "n/a");
    const lines = positions.map((p) => {
      const pnl = typeof p.cashPnl === "number"
        ? ` · PnL ${p.cashPnl >= 0 ? "+" : ""}${fmtUsd(p.cashPnl)}${typeof p.percentPnl === "number" ? ` (${p.percentPnl.toFixed(1)}%)` : ""}`
        : "";
      const redeem = p.redeemable ? ` · 🏆 REDEEMABLE (action:"redeem" condition_id:"${p.conditionId}")` : "";
      return `  ${p.title ?? p.conditionId ?? "?"} — ${p.outcome ?? "?"}: ` +
        `${p.size?.toFixed(2) ?? "?"} shares @ ${p.avgPrice?.toFixed(3) ?? "?"} → ` +
        `${p.curPrice?.toFixed(3) ?? "?"} (${fmtUsd(p.currentValue)})${pnl}${redeem}`;
    });
    const totalValue = positions.reduce((s, p) => s + (p.currentValue ?? 0), 0);
    const redeemableCount = positions.filter((p) => p.redeemable).length;

    return {
      text: [
        `Positions for ${user} (${positions.length}, total value ~$${totalValue.toFixed(2)}):`,
        ...lines,
        ...(redeemableCount ? [``, `${redeemableCount} position(s) are redeemable — claim with action:"redeem".`] : []),
      ].join("\n"),
      structured: { user, positions, totalValue },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: `Could not fetch positions from Polymarket's Data-API (${msg}). ` +
        `Fallback: blockrun_markets path:"polymarket/positions" params:{user:"${user}"} ($0.001).`,
      isError: true,
    };
  }
}
