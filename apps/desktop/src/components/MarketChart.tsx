import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/market-data";

export function MarketChart({ bars, label, locale, historyReady }: { bars: Candle[]; label: string; locale: string; historyReady: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (!element.current) return;
    const style = getComputedStyle(element.current);
    const chart = createChart(element.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: style.getPropertyValue("--market-surface").trim() || "#ffffff" }, textColor: style.getPropertyValue("--fg-muted").trim() || "#666666", attributionLogo: true, fontFamily: "system-ui, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: style.getPropertyValue("--border").trim() || "#eeeeee" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.27 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { locale },
    });
    candleSeries.current = chart.addSeries(CandlestickSeries, { upColor: "#16836b", downColor: "#d04b57", borderVisible: false, wickUpColor: "#16836b", wickDownColor: "#d04b57" });
    volumeSeries.current = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    fit.current = () => chart.timeScale().fitContent();
    const observer = new MutationObserver(() => {
      const current = getComputedStyle(element.current!);
      chart.applyOptions({ layout: { background: { type: ColorType.Solid, color: current.getPropertyValue("--market-surface").trim() || "#fff" }, textColor: current.getPropertyValue("--fg-muted").trim() }, grid: { horzLines: { color: current.getPropertyValue("--border").trim() } } });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { observer.disconnect(); chart.remove(); candleSeries.current = null; volumeSeries.current = null; fit.current = null; fitted.current = false; };
  }, [locale]);
  useEffect(() => {
    candleSeries.current?.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
    volumeSeries.current?.setData(bars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "rgba(22,131,107,0.25)" : "rgba(208,75,87,0.25)" })));
    // A stream snapshot can arrive first with only a few candles. Wait for the
    // initial history before fitting, including when history succeeds on retry.
    // Subsequent live updates must preserve the user's zoom/pan.
    if (historyReady && bars.length && !fitted.current) { fit.current?.(); fitted.current = true; }
  }, [bars, locale, historyReady]);
  return <div className="market-chart" ref={element} role="img" aria-label={label} />;
}
