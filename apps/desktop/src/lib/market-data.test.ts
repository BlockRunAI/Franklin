import { describe, expect, it } from "vitest";
import { marketResearchPrompt, mergeCandles, parseHistory, parseRestQuotes, parseStreamCandle, parseTicker } from "./market-data";

const time = 1_760_832_000;
const bar = { time, open: 100, high: 120, low: 90, close: 110, volume: 5 };
const ticker = { symbol: "BTC/USD", last: 110, high: 120, low: 90, volume: 5, change: -2, change_pct: -1.78 };
describe("public market normalization", () => {
  it("does not mislabel REST UTC-day open as rolling 24h change", () => {
    const quotes = parseRestQuotes({ error: [], result: { XXBTZUSD: { c: ["110"], h: ["115", "120"], l: ["100", "90"], v: ["2", "5"], o: "100" } } }, 1000);
    expect(quotes.BTC).toMatchObject({ price: 110, high: 120, low: 90, volume: 5, change: null, changePct: null, source: "rest" });
    expect(quotes.ETH).toBeUndefined();
  });
  it("uses the exchange's signed rolling change from the stream", () => {
    expect(parseTicker(ticker, 1000)?.quote).toMatchObject({ change: -2, changePct: -1.78, source: "stream" });
    expect(parseTicker({ ...ticker, symbol: "BTC/USDT" }, 1000)).toBeNull();
  });
  it.each([NaN, Infinity, 0, -1, "", null, {}, true])("rejects invalid prices (%s)", (price) => {
    expect(parseTicker({ ...ticker, last: price }, 1000)).toBeNull();
  });
  it("parses OHLC fields and rejects invalid candles, sorts and deduplicates", () => {
    const bars = parseHistory({ error: [], result: { XXBTZUSD: [
      [time + 3600, "110", "120", "100", "115", "112", "8", 2],
      [time, "100", "120", "90", "110", "105", "5", 2],
      [time, "100", "120", "90", "111", "105", "5", 2],
      [time + 7200, "100", "80", "90", "110", "105", "5", 2],
    ], last: time } }, "BTC");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({ ...bar, close: 111 });
  });
  it("uses interval_begin, ignores a different asset/interval or unaligned time", () => {
    const input = { ...bar, symbol: "BTC/USD", interval: 60, interval_begin: new Date(time * 1000).toISOString(), timestamp: "incorrect" };
    expect(parseStreamCandle(input, "BTC", 60)).toEqual(bar);
    expect(parseStreamCandle(input, "ETH", 60)).toBeNull();
    expect(parseStreamCandle(input, "BTC", 5)).toBeNull();
    expect(parseStreamCandle({ ...input, interval_begin: new Date((time + 1) * 1000).toISOString() }, "BTC", 60)).toBeNull();
  });
  it("keeps the newest update for a bucket and limits recent history", () => {
    const many = Array.from({ length: 730 }, (_, i) => ({ ...bar, time: time + i * 60 }));
    const merged = mergeCandles(many, [{ ...many[729], close: 112 }]);
    expect(merged).toHaveLength(720);
    expect(merged[0].time).toBe(time + 600);
    expect(merged.at(-1)?.close).toBe(112);
  });
  it("rejects upstream errors and empty/invalid history", () => {
    expect(() => parseHistory({ error: ["rate limit"], result: {} }, "BTC")).toThrow();
    expect(() => parseHistory({ error: [], result: { XXBTZUSD: [] } }, "BTC")).toThrow();
    expect(() => parseRestQuotes({ result: {} }, 1000)).toThrow();
  });
  it("prepares explicit, dated spot context without executing or claiming a swap quote", () => {
    const text = marketResearchPrompt("BTC", parseTicker(ticker, time * 1000)!.quote, 60, [bar]);
    expect(text).toContain("[Kraken BTC/USD · 1h]");
    expect(text).toContain(new Date(time * 1000).toISOString());
    expect(text).toContain("current candle may be incomplete");
    expect(text).toContain("Do not place orders or sign transactions");
    expect(marketResearchPrompt("ETH", undefined, 5, [])).toContain("fetch fresh data first");
  });
  it("localizes references and reports quote and candle freshness independently", () => {
    const now = time * 1000;
    const quote = parseTicker(ticker, now - 46_000)!.quote;
    const text = marketResearchPrompt("BTC", quote, 1440, [bar], { lang: "zh", now, candlesReceivedAt: now });
    expect(text).toContain("[Kraken BTC/USD · 1D]");
    expect(text.split("\n")[1]).toContain("已过期");
    expect(text.split("\n")[2]).toContain("近期接收");
    expect(text).toContain("当前 K 线可能尚未收盘");
    expect(text).toContain("不要下单或签署交易");
    expect(marketResearchPrompt("BTC", quote, 60, [bar], { now, loading: true })).toContain("Candle history loading");
    expect(marketResearchPrompt("BTC", quote, 60, [bar], { now, candlesReceivedAt: now, historyError: true }).split("\n")[2]).toContain("stale");
  });
});
