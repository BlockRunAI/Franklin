// Swap history — on-chain swaps the agent executed (0x on Base, Jupiter on
// Solana), logged to ~/.blockrun/swaps.jsonl and served via wallet.swaps.
// Refetches on wallet.event (a swap changes balances → broadcast fires).

import { useEffect, useState } from "react";
import { agent } from "../lib/ws";
import type { ServerMsg } from "../lib/wire";

export interface SwapRow {
  ts: number;
  chain: string;
  dex: string;
  sellSym: string;
  sellAmount: number;
  buySym: string;
  buyAmount: number;
  txHash: string;
  explorer?: string;
}

export function useWalletSwaps(): SwapRow[] {
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  useEffect(() => {
    let alive = true;
    const fetchSwaps = async () => {
      try {
        const r = await agent.request<undefined, { swaps?: SwapRow[] }>("wallet.swaps");
        if (alive) setSwaps(r?.swaps ?? []);
      } catch { /* keep prior */ }
    };
    const offState = agent.onState((s) => { if (s === "open") void fetchSwaps(); });
    const offMsg = agent.subscribe((msg: ServerMsg) => {
      if (msg.kind === "wallet.event") void fetchSwaps();
    });
    return () => { alive = false; offState(); offMsg(); };
  }, []);
  return swaps;
}
