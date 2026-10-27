import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendMarketDraft, loadMarketSelection, saveMarketSelection } from "./market-context";
import { marketResearchPrompt } from "./market-data";

beforeEach(() => localStorage.clear());
describe("market workspace continuity", () => {
  it("restores a supported instrument and timeframe, including daily candles", () => {
    saveMarketSelection({ market: "ETH", interval: 1440 });
    expect(loadMarketSelection()).toEqual({ market: "ETH", interval: 1440 });
  });
  it.each(["null", "[]", "broken", '{"market":"SOL","interval":999}', '{"market":"__proto__","interval":"60"}'])("ignores invalid preferences (%s)", (raw) => {
    localStorage.setItem("franklin-market-selection-v1", raw);
    expect(loadMarketSelection()).toEqual({ market: "BTC", interval: 60 });
  });
  it("works when optional preference storage is unavailable", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(loadMarketSelection()).toEqual({ market: "BTC", interval: 60 });
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => saveMarketSelection({ market: "ETH", interval: 5 })).not.toThrow();
    write.mockRestore();
  });
  it("keeps user text and original snapshots intact across duplicate clicks, languages and assets", () => {
    const btc = marketResearchPrompt("BTC", undefined, 60, [], { lang: "zh" });
    const draft = appendMarketDraft("  我的原文\n", btc);
    expect(draft.startsWith("  我的原文\n\n\n")).toBe(true);
    expect(appendMarketDraft(draft, marketResearchPrompt("BTC", undefined, 60, [], { lang: "es" }))).toBe(draft);
    const combined = appendMarketDraft(draft, marketResearchPrompt("ETH", undefined, 5, []));
    expect(combined.startsWith(draft)).toBe(true);
    expect(combined).toContain("[Kraken ETH/USD · 5m]");
    expect(appendMarketDraft(combined, btc)).toBe(combined);
    // Removing a reference lets the next explicit click capture new data.
    expect(appendMarketDraft("My edited question", btc)).toContain(btc);
  });
});
