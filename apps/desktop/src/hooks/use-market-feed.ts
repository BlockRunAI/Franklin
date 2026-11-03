import { useEffect, useState } from "react";
import { MarketFeed, initialMarketState } from "../lib/market-feed";
import type { CandleInterval, Market } from "../lib/market-data";

export function useMarketFeed(market: Market, interval: CandleInterval, retry: number) {
  const [snapshot, setSnapshot] = useState<{ key: string; state: ReturnType<typeof initialMarketState> }>(() => ({ key: "", state: initialMarketState() }));
  const key = `${market}:${interval}:${retry}`;
  useEffect(() => {
    const feed = new MarketFeed(market, interval, (state) => setSnapshot({ key, state }));
    feed.start();
    return () => feed.stop();
  }, [market, interval, key]);
  // Effects run after render. Hide the previous pair immediately, including for one frame.
  return snapshot.key === key ? snapshot.state : initialMarketState();
}
