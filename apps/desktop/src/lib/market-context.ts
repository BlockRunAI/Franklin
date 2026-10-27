import { INTERVALS, type CandleInterval, type Market } from "./market-data";

export type MarketSelection = { market: Market; interval: CandleInterval };
const KEY = "franklin-market-selection-v1";
export function loadMarketSelection(): MarketSelection {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return {
      market: saved?.market === "BTC" || saved?.market === "ETH" ? saved.market : "BTC",
      interval: INTERVALS.includes(saved?.interval) ? saved.interval : 60,
    };
  } catch { return { market: "BTC", interval: 60 }; }
}
export function saveMarketSelection(selection: MarketSelection) {
  try { localStorage.setItem(KEY, JSON.stringify(selection)); } catch { /* optional preference */ }
}
// Never replace a referenced snapshot with newer prices when the chart changes.
export function appendMarketDraft(draft: string, prompt: string): string {
  const heading = prompt.split("\n")[0];
  const isReference = /^\[Kraken (BTC|ETH)\/USD · (1m|5m|15m|1h|4h|1D)\]$/.test(heading);
  if (isReference ? draft.split("\n").includes(heading) : draft.includes(prompt)) return draft;
  return draft.trim() ? `${draft}\n\n${prompt}` : `${draft}${prompt}`;
}
