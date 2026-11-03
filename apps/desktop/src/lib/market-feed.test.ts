import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketFeed, type MarketState } from "./market-feed";

const time = 1_760_832_000;
const row = [time, "100", "120", "90", "110", "105", "5", 4];
const history = { error: [], result: { XXBTZUSD: [row], XETHZUSD: [row], last: time } };
const rest = { error: [], result: { XXBTZUSD: { c: ["110"], h: ["110", "120"], l: ["100", "90"], v: ["2", "5"] }, XETHZUSD: { c: ["105"], h: ["110", "120"], l: ["100", "90"], v: ["2", "5"] } } };
const ticker = (symbol = "BTC/USD", last = 112) => ({ symbol, last, high: 120, low: 90, volume: 5, change: 2, change_pct: 1.8 });
class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn(); close = vi.fn();
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const feeds: MarketFeed[] = [];
function setup(fetcher = vi.fn<typeof fetch>(async (url) => response(String(url).includes("OHLC") ? history : rest))) {
  const sockets: Socket[] = [];
  let state!: MarketState;
  const emit = vi.fn((next: MarketState) => { state = next; });
  const feed = new MarketFeed("BTC", 60, emit, { fetch: fetcher, createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; } });
  feeds.push(feed); feed.start();
  return { feed, sockets, fetcher, emit, get state() { return state; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T12:00:00Z")); });
afterEach(() => { feeds.splice(0).forEach((feed) => feed.stop()); vi.useRealTimers(); });
describe("market feed lifecycle", () => {
  it("loads fixed public endpoints without credentials and subscribes to both spot symbols", async () => {
    const run = setup(); await flush();
    expect(run.state.status).toBe("polling");
    expect(run.state.bars).toHaveLength(1);
    run.sockets[0].open();
    expect(run.sockets[0].send.mock.calls.map(([value]) => JSON.parse(value as string).params)).toEqual([
      { channel: "ticker", symbol: ["BTC/USD", "ETH/USD"], snapshot: true },
      { channel: "ohlc", symbol: ["BTC/USD"], interval: 60, snapshot: true },
    ]);
    for (const [url, options] of run.fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.kraken\.com\/0\/public\/(OHLC|Ticker)\?/);
      expect(options?.credentials).toBe("omit");
      expect(options?.headers).toBeUndefined();
    }
    expect(run.state.status).not.toBe("live");
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    expect(run.state.status).toBe("live");
  });
  it("buffers stream candles and prevents delayed REST data from overwriting newer quotes/bars", async () => {
    let resolveHistory!: (r: Response) => void;
    let resolveTicker!: (r: Response) => void;
    const run = setup(vi.fn<typeof fetch>((url) => new Promise((resolve) => { if (String(url).includes("OHLC")) resolveHistory = resolve; else resolveTicker = resolve; })));
    run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    run.sockets[0].message({ channel: "ohlc", data: [{ symbol: "BTC/USD", interval: 60, interval_begin: new Date(time * 1000).toISOString(), open: 100, high: 120, low: 90, close: 118, volume: 8 }] });
    resolveHistory(response(history)); resolveTicker(response(rest)); await flush();
    expect(run.state.bars.at(-1)?.close).toBe(118);
    expect(run.state.quotes.BTC?.price).toBe(112);
    expect(run.state.quotes.BTC?.changePct).toBe(1.8);
  });
  it("falls back to polling, reconnects and resyncs history after a disconnect", async () => {
    const run = setup(); await flush(); run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    run.sockets[0].onclose?.(); await flush();
    expect(run.state.status).toBe("polling");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.sockets).toHaveLength(2);
    run.sockets[1].open(); await flush();
    expect(run.fetcher.mock.calls.filter(([url]) => String(url).includes("OHLC")).length).toBeGreaterThanOrEqual(3);
    run.sockets[1].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    expect(run.state.status).toBe("live");
  });
  it("does not call a heartbeat a fresh price; restarts silent sockets", async () => {
    const run = setup(); await flush(); run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    for (let i = 0; i < 10; i++) { run.sockets[0].message({ channel: "heartbeat" }); await vi.advanceTimersByTimeAsync(5000); }
    expect(run.sockets[0].close).toHaveBeenCalled();
    expect(run.state.status).not.toBe("live");
  });
  it("downgrades the overall state when only one symbol is updating", async () => {
    const run = setup(); await flush(); run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    await vi.advanceTimersByTimeAsync(40_000);
    run.sockets[0].message({ channel: "ticker", data: [ticker("ETH/USD")] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.state.status).toBe("polling");
  });
  it("handles subscription rejection and HTTP failure without inventing data", async () => {
    const run = setup(vi.fn<typeof fetch>(async () => { throw new Error("offline"); })); await flush();
    expect(run.state.status).toBe("offline"); expect(run.state.historyError).toBe(true); expect(run.state.quotes).toEqual({});
    run.sockets[0].open(); run.sockets[0].message({ method: "subscribe", success: false, error: "not available" });
    await flush(); expect(run.sockets[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(run.sockets).toHaveLength(2);
  });
  it("does not let a pre-disconnect stream candle overwrite a newer REST snapshot", async () => {
    const run = setup(); await flush(); run.sockets[0].open();
    run.sockets[0].message({ channel: "ohlc", data: [{ symbol: "BTC/USD", interval: 60, interval_begin: new Date(time * 1000).toISOString(), open: 100, high: 120, low: 90, close: 118, volume: 8 }] });
    expect(run.state.bars[0].close).toBe(118);
    run.sockets[0].onclose?.(); await flush();
    expect(run.state.bars[0].close).toBe(110);
  });
  it("refreshes stale candles even while ticker messages keep the price stream live", async () => {
    const run = setup(); await flush(); run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    await vi.advanceTimersByTimeAsync(40_000);
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.state.status).toBe("live");
    expect(run.fetcher.mock.calls.filter(([url]) => String(url).includes("OHLC"))).toHaveLength(2);
  });
  it("does not flag a healthy stream when a late initial REST request fails", async () => {
    let rejectTicker!: (reason: Error) => void;
    const run = setup(vi.fn<typeof fetch>((url) => String(url).includes("OHLC") ? Promise.resolve(response(history)) : new Promise((_resolve, reject) => { rejectTicker = reject; })));
    run.sockets[0].open();
    run.sockets[0].message({ channel: "ticker", data: [ticker(), ticker("ETH/USD")] });
    rejectTicker(new Error("timeout")); await flush();
    expect(run.state.status).toBe("live"); expect(run.state.quoteError).toBe(false);
  });
  it("ignores invalid messages and candles belonging to a different pair or interval", async () => {
    const run = setup(); await flush();
    run.sockets[0].message({ channel: "ohlc", data: [{ symbol: "ETH/USD", interval: 60, interval_begin: new Date(time * 1000).toISOString(), open: 100, high: 120, low: 90, close: 119, volume: 8 }] });
    run.sockets[0].onmessage?.({ data: "invalid json" });
    expect(run.state.bars[0].close).toBe(110);
  });
  it("aborts requests and stops sockets, timers and late updates when unmounted/switched", async () => {
    let resolveHistory!: (r: Response) => void;
    const run = setup(vi.fn<typeof fetch>((url) => String(url).includes("OHLC") ? new Promise((resolve) => { resolveHistory = resolve; }) : Promise.resolve(response(rest))));
    await flush(); const count = run.emit.mock.calls.length;
    const signal = run.fetcher.mock.calls.find(([url]) => String(url).includes("OHLC"))?.[1]?.signal;
    run.feed.stop(); resolveHistory(response(history)); await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(signal?.aborted).toBe(true);
    expect(run.sockets[0].close).toHaveBeenCalled();
    expect(run.emit.mock.calls).toHaveLength(count);
    expect(run.fetcher).toHaveBeenCalledTimes(2);
  });
});
