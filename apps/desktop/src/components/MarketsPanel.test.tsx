import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TryLangProvider } from "../lib/i18n";
import { initialMarketState } from "../lib/market-feed";
import { useMarketFeed } from "../hooks/use-market-feed";
import { MarketsPanel } from "./MarketsPanel";
import { useState } from "react";
import type { MarketSelection } from "../lib/market-context";

vi.mock("../hooks/use-market-feed", () => ({ useMarketFeed: vi.fn() }));
vi.mock("./MarketChart", () => ({ MarketChart: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }));

function draw() {
  const onResearch = vi.fn();
  function ControlledPanel() {
    const [selection, onSelectionChange] = useState<MarketSelection>({ market: "BTC", interval: 60 });
    return <MarketsPanel onResearch={onResearch} selection={selection} onSelectionChange={onSelectionChange} />;
  }
  render(<TryLangProvider><ControlledPanel /></TryLangProvider>);
  return onResearch;
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(useMarketFeed).mockReturnValue({ ...initialMarketState(), loading: false, status: "live", candlesReceivedAt: Date.now(),
    quotes: { BTC: { price: 68000, high: 69000, low: 67000, volume: 10, change: -100, changePct: -0.15, source: "stream", receivedAt: Date.now() } },
    bars: [{ time: 1_760_832_000, open: 67500, high: 69000, low: 67000, close: 68000, volume: 10 }],
  });
});
describe("market dashboard", () => {
  it("labels USD, source, signed movement and an accessible data table", () => {
    draw();
    expect(screen.getAllByText("Kraken spot · USD").length).toBe(2);
    expect(screen.getByText("24h · -0.15%")).toBeTruthy();
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getByText("Latest 20 candles · UTC")).toBeTruthy();
    expect(within(table).getAllByText("$68,000.00")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("BTC/USD");
  });
  it("changes symbol/interval and reconnects using a new feed lifetime", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Ethereum/ }));
    expect(useMarketFeed).toHaveBeenLastCalledWith("ETH", 60, 0);
    fireEvent.click(screen.getByRole("button", { name: "5m" }));
    expect(useMarketFeed).toHaveBeenLastCalledWith("ETH", 5, 0);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(useMarketFeed).toHaveBeenLastCalledWith("ETH", 5, 1);
  });
  it("only prepares context after an explicit click", () => {
    const onResearch = draw();
    expect(onResearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reference market" }));
    expect(onResearch).toHaveBeenCalledOnce();
    expect(onResearch.mock.calls[0][0]).toContain("Do not place orders or sign transactions");
  });
  it("shows a recoverable empty/error state without made-up prices", () => {
    vi.mocked(useMarketFeed).mockReturnValue({ ...initialMarketState(), loading: false, status: "offline", quoteError: true, historyError: true });
    draw();
    expect(screen.getByText("Connection unavailable")).toBeTruthy();
    expect(screen.getByText("No candle data yet. Check your connection and retry.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
  it("keeps an existing reference visible as a frozen draft rather than recapturing silently", () => {
    render(<TryLangProvider><MarketsPanel selection={{ market: "ETH", interval: 1440 }} onSelectionChange={vi.fn()} onResearch={vi.fn()} draft={"My question\n[Kraken ETH/USD · 1D]\nOriginal price"} /></TryLangProvider>);
    expect(screen.getByRole("button", { name: "View draft reference" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1D" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("ETH/USD · 1D");
  });
  it("distinguishes early streaming candles from still-loading full history", () => {
    vi.mocked(useMarketFeed).mockReturnValue({ ...vi.mocked(useMarketFeed)("BTC", 60, 0), loading: true });
    draw();
    expect(screen.getAllByText("Loading market data…").length).toBeGreaterThan(0);
    expect(screen.getByRole("img")).toBeTruthy();
  });
});
