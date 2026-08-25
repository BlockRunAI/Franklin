// Real spend — sourced from the agent server (wallet.spend), which reads the
// x402 settlement ledger (~/.blockrun/cost_log.jsonl). This is the same truth
// the CLI dashboard uses and covers BOTH model calls and paid tools (web
// search, image gen, …) — unlike the old localStorage estimate that stayed $0
// because the desktop server never emitted per-call costs.
//
// Returns the same Usage shape WalletPanel already consumes. Refetches whenever
// the server broadcasts wallet.event (i.e. after each turn settles).

import { useEffect, useState } from "react";
import { agent } from "../lib/ws";
import type { ServerMsg } from "../lib/wire";

export interface Receipt {
  ts: number;
  model: string;
  usd: number;
}
export interface Usage {
  totalUsd: number;
  requests: number;
  byModel: Record<string, { usd: number; count: number }>;
  receipts: Receipt[];
}

const EMPTY: Usage = { totalUsd: 0, requests: 0, byModel: {}, receipts: [] };

export function useSpend(): Usage {
  const [usage, setUsage] = useState<Usage>(EMPTY);

  useEffect(() => {
    let alive = true;
    const fetchSpend = async () => {
      try {
        const r = await agent.request<undefined, Usage>("wallet.spend");
        if (alive && r) setUsage({ ...EMPTY, ...r });
      } catch { /* keep prior */ }
    };
    // Initial load once the socket is open, then refresh after each settled turn.
    const offState = agent.onState((s) => { if (s === "open") void fetchSpend(); });
    const offMsg = agent.subscribe((msg: ServerMsg) => {
      if (msg.kind === "wallet.event") void fetchSpend();
    });
    return () => { alive = false; offState(); offMsg(); };
  }, []);

  return usage;
}
