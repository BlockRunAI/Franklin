// Public spot data only. These identifiers never come from user-supplied URLs.
export const MARKETS = {
  BTC: { name: "Bitcoin", symbol: "BTC/USD", pair: "XBTUSD", result: "XXBTZUSD" },
  ETH: { name: "Ethereum", symbol: "ETH/USD", pair: "ETHUSD", result: "XETHZUSD" },
} as const;
export type Market = keyof typeof MARKETS;
export const INTERVALS = [1, 5, 15, 60, 240, 1440] as const;
export type CandleInterval = typeof INTERVALS[number];
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Quote = {
  price: number; high: number; low: number; volume: number;
  change: number | null; changePct: number | null; receivedAt: number;
  source: "stream" | "rest";
};
export const REST_URL = "https://api.kraken.com/0/public/";
export const STREAM_URL = "wss://ws.kraken.com/v2";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function positive(value: unknown) { const n = number(value); return n !== null && n > 0 ? n : null; }
function nonnegative(value: unknown) { const n = number(value); return n !== null && n >= 0 ? n : null; }
function candle(time: unknown, open: unknown, high: unknown, low: unknown, close: unknown, volume: unknown): Candle | null {
  const t = number(time), o = positive(open), h = positive(high), l = positive(low), c = positive(close), v = nonnegative(volume);
  if (t === null || !Number.isInteger(t) || t < 1_230_768_000 || t > Date.now() / 1000 + 86_400 || o === null || h === null || l === null || c === null || v === null) return null;
  if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) return null;
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}
function result(body: unknown) {
  const envelope = record(body);
  if (!envelope || !Array.isArray(envelope.error) || envelope.error.length) throw new Error("Market source unavailable");
  const data = record(envelope.result);
  if (!data) throw new Error("Invalid market response");
  return data;
}
export function mergeCandles(...groups: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const group of groups) for (const bar of group) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-720);
}
export function parseHistory(body: unknown, market: Market): Candle[] {
  const rows = result(body)[MARKETS[market].result];
  if (!Array.isArray(rows)) throw new Error("Missing candle history");
  const bars = rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const bar = candle(row[0], row[1], row[2], row[3], row[4], row[6]);
    return bar ? [bar] : [];
  });
  if (!bars.length) throw new Error("No valid candles");
  return mergeCandles(bars);
}
export function parseRestQuotes(body: unknown, receivedAt: number): Partial<Record<Market, Quote>> {
  const data = result(body);
  const quotes: Partial<Record<Market, Quote>> = {};
  for (const market of Object.keys(MARKETS) as Market[]) {
    const raw = record(data[MARKETS[market].result]);
    if (!raw) continue;
    const price = positive(Array.isArray(raw.c) ? raw.c[0] : null);
    const high = positive(Array.isArray(raw.h) ? raw.h[1] : null);
    const low = positive(Array.isArray(raw.l) ? raw.l[1] : null);
    const volume = nonnegative(Array.isArray(raw.v) ? raw.v[1] : null);
    if (price === null || high === null || low === null || volume === null || high < low) continue;
    // REST `o` is today's UTC open, NOT the rolling 24h open. Never label that as 24h change.
    quotes[market] = { price, high, low, volume, change: null, changePct: null, receivedAt, source: "rest" };
  }
  if (!Object.keys(quotes).length) throw new Error("No valid quotes");
  return quotes;
}
export function parseTicker(value: unknown, receivedAt: number): { market: Market; quote: Quote } | null {
  const raw = record(value);
  if (!raw) return null;
  const market = (Object.keys(MARKETS) as Market[]).find((key) => MARKETS[key].symbol === raw.symbol);
  const price = positive(raw.last), high = positive(raw.high), low = positive(raw.low), volume = nonnegative(raw.volume);
  if (!market || price === null || high === null || low === null || volume === null || high < low) return null;
  return { market, quote: { price, high, low, volume, change: number(raw.change), changePct: number(raw.change_pct), receivedAt, source: "stream" } };
}
export function parseStreamCandle(value: unknown, market: Market, interval: CandleInterval): Candle | null {
  const raw = record(value);
  if (!raw || raw.symbol !== MARKETS[market].symbol || raw.interval !== interval || typeof raw.interval_begin !== "string") return null;
  const time = Date.parse(raw.interval_begin) / 1000;
  if (time % (interval * 60) !== 0) return null;
  return candle(time, raw.open, raw.high, raw.low, raw.close, raw.volume);
}

export function marketIntervalLabel(interval: CandleInterval): string {
  return interval === 1440 ? "1D" : interval >= 60 ? `${interval / 60}h` : `${interval}m`;
}
export function marketReferenceHeading(market: Market, interval: CandleInterval): string {
  return `[Kraken ${MARKETS[market].symbol} · ${marketIntervalLabel(interval)}]`;
}
export function marketResearchPrompt(market: Market, quote: Quote | undefined, interval: CandleInterval, bars: Candle[], options: {
  lang?: "en" | "zh" | "es"; now?: number; candlesReceivedAt?: number | null; loading?: boolean; historyError?: boolean;
} = {}): string {
  const latest = bars.at(-1);
  const now = options.now ?? Date.now();
  const fresh = (received: number | null | undefined) => !!received && now - received <= 45_000;
  const text = {
    en: { spot: "Spot", received: "received", fresh: "recently received", stale: "stale", unavailable: "Quote unavailable; fetch fresh data first.", candle: "Latest candle", start: "UTC start", close: "close", forming: "current candle may be incomplete", waiting: "Candle history loading", missing: "Candle history unavailable", verify: "Verify freshness; analyze trend, uncertainty and risks. Spot data is not an execution quote. Do not place orders or sign transactions." },
    zh: { spot: "现货", received: "接收于", fresh: "近期接收", stale: "已过期", unavailable: "报价暂无，请先获取最新数据。", candle: "最新 K 线", start: "UTC 起点", close: "收盘价", forming: "当前 K 线可能尚未收盘", waiting: "K 线历史加载中", missing: "K 线历史暂无", verify: "请核验数据时效，分析走势、不确定性和风险。现货行情不是交易执行报价。不要下单或签署交易。" },
    es: { spot: "Contado", received: "recibido", fresh: "recibido recientemente", stale: "desactualizado", unavailable: "Cotización no disponible; consulta datos recientes.", candle: "Última vela", start: "inicio UTC", close: "cierre", forming: "la vela actual puede estar en formación", waiting: "Cargando historial de velas", missing: "Historial no disponible", verify: "Verifica la vigencia; analiza tendencia, incertidumbre y riesgos. Los datos al contado no son una cotización de ejecución. No coloques órdenes ni firmes transacciones." },
  }[options.lang ?? "en"];
  const quoteLine = quote ? `${text.spot}: $${quote.price.toFixed(2)} USD · ${text.received} ${new Date(quote.receivedAt).toISOString()} · ${fresh(quote.receivedAt) ? text.fresh : text.stale}.` : text.unavailable;
  const candleLine = latest ? `${text.candle}: ${text.start} ${new Date(latest.time * 1000).toISOString()} · ${text.close} $${latest.close.toFixed(2)} · ${text.forming}. ${options.loading ? text.waiting : options.historyError || !fresh(options.candlesReceivedAt) ? text.stale : text.fresh}${options.candlesReceivedAt ? ` · ${text.received} ${new Date(options.candlesReceivedAt).toISOString()}` : ""}.` : options.loading ? text.waiting : text.missing;
  return [marketReferenceHeading(market, interval), quoteLine, candleLine, text.verify].join("\n");
}
