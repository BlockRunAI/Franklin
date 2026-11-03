import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketChart } from "./MarketChart";

const api = vi.hoisted(() => {
  const series = { setData: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) };
  const fitContent = vi.fn();
  const remove = vi.fn();
  return { series, fitContent, remove, chart: { addSeries: () => series, timeScale: () => ({ fitContent }), applyOptions: vi.fn(), remove } };
});
vi.mock("lightweight-charts", () => ({ CandlestickSeries: {}, HistogramSeries: {}, ColorType: { Solid: "solid" }, createChart: () => api.chart }));
const bar = { time: 1_760_832_000, open: 100, high: 120, low: 90, close: 110, volume: 5 };
const history = Array.from({ length: 720 }, (_, i) => ({ ...bar, time: bar.time + i * 3600 }));
beforeEach(() => vi.clearAllMocks());

describe("initial chart viewport", () => {
  it("waits for full history after an early stream snapshot, then preserves zoom on updates", () => {
    const { rerender } = render(<MarketChart bars={[history[719]]} label="BTC" locale="en-US" historyReady={false} />);
    expect(api.series.setData).toHaveBeenCalled();
    expect(api.fitContent).not.toHaveBeenCalled();
    rerender(<MarketChart bars={history} label="BTC" locale="en-US" historyReady />);
    expect(api.fitContent).toHaveBeenCalledOnce();
    rerender(<MarketChart bars={[...history.slice(0, -1), { ...history[719], close: 111 }]} label="BTC" locale="en-US" historyReady />);
    expect(api.fitContent).toHaveBeenCalledOnce();
  });
  it("fits when history first recovers after an error, and disposes the native chart", () => {
    const { rerender, unmount } = render(<MarketChart bars={[bar]} label="ETH" locale="en-US" historyReady={false} />);
    rerender(<MarketChart bars={[bar, { ...bar, time: bar.time + 3600 }]} label="ETH" locale="en-US" historyReady={false} />);
    expect(api.fitContent).not.toHaveBeenCalled();
    rerender(<MarketChart bars={history} label="ETH" locale="en-US" historyReady />);
    expect(api.fitContent).toHaveBeenCalledOnce();
    unmount();
    expect(api.remove).toHaveBeenCalledOnce();
  });
});
