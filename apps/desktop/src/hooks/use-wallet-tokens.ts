// Wallet holdings — native ETH + curated Base ERC-20s with a non-zero balance,
// fetched from the agent server (wallet.tokens, which balanceOf's a known token
// set over public Base RPC). Refetches when the server broadcasts wallet.event
// (balance changed after a turn/swap).

import { useEffect, useState } from "react";
import { agent } from "../lib/ws";
import type { ServerMsg } from "../lib/wire";

export interface TokenHolding {
  symbol: string;
  amount: number;
  usd?: number;
}

export function useWalletTokens(): { tokens: TokenHolding[]; loading: boolean } {
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const fetchTokens = async () => {
      try {
        const r = await agent.request<undefined, { tokens?: TokenHolding[] }>("wallet.tokens");
        if (alive) {
          setTokens(r?.tokens ?? []);
          setLoading(false);
        }
      } catch {
        if (alive) setLoading(false);
      }
    };
    // Fetch immediately on mount (the socket is usually already open by the time
    // the wallet panel opens), then on (re)connect, on wallet.event, and on a
    // 30s timer so holdings self-heal after a top-up/spend that didn't run a
    // turn — keeping them in step with the periodically-refreshed top balance.
    void fetchTokens();
    const offState = agent.onState((s) => { if (s === "open") void fetchTokens(); });
    const offMsg = agent.subscribe((msg: ServerMsg) => {
      if (msg.kind === "wallet.event") void fetchTokens();
    });
    const poll = setInterval(() => { void fetchTokens(); }, 30_000);
    return () => { alive = false; offState(); offMsg(); clearInterval(poll); };
  }, []);

  return { tokens, loading };
}
