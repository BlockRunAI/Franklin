import { useState } from "react";
import { ArrowUpRight, ChartCandlestick, RefreshCw } from "lucide-react";
import { useTryLang } from "../lib/i18n";
import { marketCopy, marketLocale } from "../lib/market-i18n";
import { INTERVALS, MARKETS, marketIntervalLabel, marketReferenceHeading, marketResearchPrompt, type Market } from "../lib/market-data";
import type { MarketSelection } from "../lib/market-context";
import { useMarketFeed } from "../hooks/use-market-feed";
import { MarketChart } from "./MarketChart";

export function MarketsPanel({ onResearch, selection, onSelectionChange, draft = "" }: {
  onResearch: (prompt: string) => void; selection: MarketSelection; onSelectionChange: (selection: MarketSelection) => void; draft?: string;
}) {
  const { lang } = useTryLang();
  const copy = marketCopy[lang], locale = marketLocale[lang];
  const { market, interval } = selection;
  const [retry, setRetry] = useState(0);
  const state = useMarketFeed(market, interval, retry);
  const quote = state.quotes[market], latest = state.bars.at(-1);
  const price = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }).format(value);
  const quantity = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const age = (received: number | null | undefined) => received ? `${Math.max(0, Math.floor((state.now - received) / 1000))} ${copy.seconds}` : copy.never;
  const stale = (received: number | null | undefined) => !received || state.now - received > 45_000;
  const time = (timestamp: number) => new Date(timestamp * 1000).toISOString().replace("T", " ").slice(0, 16);
  const status = copy[state.status];
  const referenced = draft.split("\n").includes(marketReferenceHeading(market, interval));

  return <section className="markets-panel" aria-label={copy.title}>
    <div className="market-heading">
      <div><h1><ChartCandlestick size={23} aria-hidden />{copy.title}</h1><p>{copy.subtitle}</p></div>
      <button className="market-retry" onClick={() => setRetry((n) => n + 1)}><RefreshCw size={15} aria-hidden />{copy.retry}</button>
    </div>
    <div className="market-source"><span>{copy.source}</span><span className={`market-status is-${state.status}`} role="status"><i aria-hidden />{status}</span></div>
    <div className="market-quotes" aria-label={copy.title}>
      {(Object.keys(MARKETS) as Market[]).map((key) => {
        const q = state.quotes[key];
        const direction = q?.changePct === null || q?.changePct === undefined ? "" : q.changePct >= 0 ? "is-up" : "is-down";
        return <button key={key} className={`market-quote ${market === key ? "is-selected" : ""}`} aria-pressed={market === key} onClick={() => onSelectionChange({ market: key, interval })}>
          <span className="market-quote-name"><span className="market-coin">{key === "BTC" ? "₿" : "Ξ"}</span><span><strong>{MARKETS[key].name}</strong><small>{MARKETS[key].symbol}</small></span></span>
          <span className="market-quote-price">{price(q?.price)}</span>
          <span className={`market-change ${direction}`}>{copy.change} · {q?.changePct === null || q?.changePct === undefined ? copy.unavailable : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toLocaleString(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`}</span>
          <span className="market-quote-time">{copy.received} {age(q?.receivedAt)}{q && stale(q.receivedAt) ? ` · ${copy.stale}` : ""}</span>
        </button>;
      })}
    </div>
    {state.quoteError && <p className="market-notice" role="status">{copy.quoteError}</p>}
    <div className="market-research"><div><strong>{MARKETS[market].symbol} · {marketIntervalLabel(interval)} → Franklin</strong><p>{referenced ? copy.referenceKept : copy.analyzeNote}</p></div><button onClick={() => onResearch(marketResearchPrompt(market, quote, interval, state.bars, { lang, now: state.now, candlesReceivedAt: state.candlesReceivedAt, loading: state.loading, historyError: state.historyError }))}>{referenced ? copy.referenceAdded : copy.analyze}<ArrowUpRight size={16} aria-hidden /></button></div>
    <div className="market-chart-card">
      <div className="market-chart-toolbar"><div><h2>{MARKETS[market].symbol}</h2><span>{copy.source}</span></div>
        <div className="market-intervals" role="group" aria-label={copy.interval}>{INTERVALS.map((value) => <button key={value} aria-pressed={interval === value} onClick={() => onSelectionChange({ market, interval: value })}>{value === 1440 ? copy.day : marketIntervalLabel(value)}</button>)}</div>
      </div>
      {state.historyError && <p className="market-notice" role="status">{copy.historyError}</p>}
      <div className="market-chart-stage" aria-busy={state.loading}>
        {state.bars.length > 0 ? <MarketChart key={`${market}:${interval}:${retry}`} bars={state.bars} label={`${MARKETS[market].symbol} · ${marketIntervalLabel(interval)} · ${copy.chart}`} locale={locale} historyReady={!state.loading && !state.historyError} /> : <div className="market-chart-empty" role="status">{state.loading ? copy.loading : copy.noCandles}</div>}
        {state.loading && state.bars.length > 0 && <div className="market-history-loading" role="status">{copy.loading}</div>}
      </div>
      <div className="market-chart-meta"><span>{state.loading ? copy.loading : `${copy.candleReceived} ${age(state.candlesReceivedAt)}`}{state.candlesReceivedAt && stale(state.candlesReceivedAt) ? ` · ${copy.stale}` : ""}</span><span>{MARKETS[market].symbol} · {marketIntervalLabel(interval)} · UTC</span></div>
      {latest && <div className="market-ohlc" aria-label={copy.latestCandle}><span>{time(latest.time)} UTC</span><span>{copy.open} <b>{price(latest.open)}</b></span><span>{copy.candleHigh} <b>{price(latest.high)}</b></span><span>{copy.candleLow} <b>{price(latest.low)}</b></span><span>{copy.close} <b>{price(latest.close)}</b></span></div>}
    </div>
    <dl className="market-stats"><div><dt>{copy.high}</dt><dd>{price(quote?.high)}</dd></div><div><dt>{copy.low}</dt><dd>{price(quote?.low)}</dd></div><div><dt>{copy.volume}</dt><dd>{quantity(quote?.volume)} <small>{market}</small></dd></div></dl>
    <details className="market-data-table"><summary>{copy.table}</summary><div className="market-table-scroll"><table><caption>{copy.lastRows}</caption><thead><tr>{[copy.time, copy.open, copy.candleHigh, copy.candleLow, copy.close, `${copy.candleVolume} (${market})`].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{state.bars.slice(-20).reverse().map((bar) => <tr key={bar.time}><th scope="row">{time(bar.time)}</th><td>{price(bar.open)}</td><td>{price(bar.high)}</td><td>{price(bar.low)}</td><td>{price(bar.close)}</td><td>{quantity(bar.volume)}</td></tr>)}</tbody></table></div></details>
    <footer className="market-footer"><p>{copy.note}</p><p>{copy.priceNote} {copy.changeNote}</p><div><a href="https://www.kraken.com" target="_blank" rel="noreferrer">{copy.footer}</a><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">{copy.chartBy}</a></div><p>TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc.</p></footer>
  </section>;
}
