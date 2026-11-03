import { MARKETS, REST_URL, STREAM_URL, mergeCandles, parseHistory, parseRestQuotes, parseStreamCandle, parseTicker, type Candle, type CandleInterval, type Market, type Quote } from "./market-data";

export type MarketState = {
  quotes: Partial<Record<Market, Quote>>; bars: Candle[]; loading: boolean;
  historyError: boolean; quoteError: boolean; status: "connecting" | "live" | "polling" | "offline";
  now: number; candlesReceivedAt: number | null;
};
export function initialMarketState(): MarketState {
  return { quotes: {}, bars: [], loading: true, historyError: false, quoteError: false, status: "connecting", now: Date.now(), candlesReceivedAt: null };
}
type Dependencies = { fetch: typeof fetch; createSocket: () => WebSocket };

// One lifetime per symbol/interval: aborts and generation guards prevent a slow old response
// from being applied to the next chart. No agent, wallet or authenticated endpoints involved.
export class MarketFeed {
  private state = initialMarketState();
  private stopped = false;
  private socket: WebSocket | null = null;
  private abort = new AbortController();
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private lastStreamAt = 0;
  private openedAt = 0;
  private streamBroken = false;
  private quotesPending = false;
  private historyPending = false;
  private historyRevision = 0;
  private streamBars: Candle[] = [];

  constructor(private market: Market, private interval: CandleInterval, private emit: (state: MarketState) => void,
    private deps: Dependencies = { fetch: (...args) => fetch(...args), createSocket: () => new WebSocket(STREAM_URL) }) {}

  start() {
    this.publish({});
    void this.fetchQuotes();
    void this.fetchHistory();
    this.connect();
    this.poll = setInterval(() => {
      if (this.state.status !== "live") void this.fetchQuotes();
      if (this.state.status !== "live" || !this.state.candlesReceivedAt || Date.now() - this.state.candlesReceivedAt > 45_000) void this.fetchHistory();
    }, 15_000);
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      // Heartbeats alone do not make a price fresh. Reconnect a stalled stream and fill its gap.
      if (this.socket && now - Math.max(this.lastStreamAt, this.openedAt) > 45_000) this.failStream();
      const fresh = (Object.keys(MARKETS) as Market[]).every((key) => {
        const quote = this.state.quotes[key];
        return quote?.source === "stream" && now - quote.receivedAt < 45_000;
      });
      this.publish({ now, ...(this.state.status === "live" && !fresh ? { status: "polling" as const } : {}) });
    }, 5_000);
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.poll); clearInterval(this.heartbeat); clearTimeout(this.reconnect);
    this.closeSocket();
  }
  private publish(update: Partial<MarketState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...update, now: Date.now() };
    this.emit(this.state);
  }
  private async request(path: string) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.abort.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 10_000);
    try {
      const response = await this.deps.fetch(REST_URL + path, { signal: controller.signal, credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("Public market request failed");
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
      this.abort.signal.removeEventListener("abort", abort);
    }
  }
  private async fetchQuotes() {
    if (this.stopped || this.quotesPending) return;
    this.quotesPending = true;
    try {
      const quotes = parseRestQuotes(await this.request("Ticker?pair=XBTUSD,ETHUSD"), Date.now());
      if (this.stopped) return;
      const merged = { ...this.state.quotes };
      for (const key of Object.keys(quotes) as Market[]) {
        // A late REST response must not replace a fresh stream quote (or its 24h change).
        const previous = merged[key];
        if (!previous || previous.source !== "stream" || Date.now() - previous.receivedAt > 45_000 || this.streamBroken) merged[key] = quotes[key];
      }
      this.publish({ quotes: merged, quoteError: false, ...(this.state.status !== "live" ? { status: "polling" as const } : {}) });
    } catch {
      // A failed initial REST request does not invalidate a healthy live stream.
      if (this.state.status !== "live") this.publish({ quoteError: true, status: "offline" });
    } finally { this.quotesPending = false; }
  }
  private async fetchHistory() {
    if (this.stopped || this.historyPending) return;
    this.historyPending = true;
    // Buffer only updates received DURING this request. Older stream bars must
    // never overwrite a newer REST snapshot during polling/recovery.
    this.streamBars = [];
    const revision = this.historyRevision;
    try {
      const bars = parseHistory(await this.request(`OHLC?pair=${MARKETS[this.market].pair}&interval=${this.interval}`), this.market);
      if (this.stopped || revision !== this.historyRevision) return;
      this.publish({ bars: mergeCandles(bars, this.streamBars), loading: false, historyError: false, candlesReceivedAt: Date.now() });
    } catch { this.publish({ loading: false, historyError: true }); }
    finally {
      this.historyPending = false;
      if (!this.stopped && revision !== this.historyRevision) void this.fetchHistory();
    }
  }
  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
    socket.close();
  }
  private failStream() {
    if (this.stopped || this.reconnect) return;
    this.streamBroken = true;
    this.closeSocket();
    this.publish({ status: "connecting" });
    void this.fetchQuotes();
    void this.fetchHistory();
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
    this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, delay);
  }
  private connect() {
    if (this.stopped) return;
    this.openedAt = Date.now(); this.lastStreamAt = 0;
    try {
      const socket = this.deps.createSocket();
      this.socket = socket;
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD", "ETH/USD"], snapshot: true } }));
          socket.send(JSON.stringify({ method: "subscribe", params: { channel: "ohlc", symbol: [MARKETS[this.market].symbol], interval: this.interval, snapshot: true } }));
          if (this.streamBroken) {
            // Drop old buffered bars before resync; they must not overwrite corrected history.
            this.streamBars = []; this.historyRevision++;
            // An in-flight history fetch from before disconnect will be discarded. Poll retries it.
            void this.fetchHistory();
          }
        } catch { this.failStream(); }
      };
      socket.onmessage = (event) => {
        if (this.stopped || socket !== this.socket || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.method === "subscribe" && message.success === false) { this.failStream(); return; }
          if (message.channel === "status" && Array.isArray(message.data) && message.data.some((item: { system?: string }) => item?.system && item.system !== "online")) { this.failStream(); return; }
          if (!Array.isArray(message.data)) return;
          if (message.channel === "ticker") {
            const quotes = { ...this.state.quotes };
            let valid = false;
            for (const raw of message.data) {
              const parsed = parseTicker(raw, Date.now());
              if (parsed) { quotes[parsed.market] = parsed.quote; valid = true; }
            }
            if (valid) {
              this.lastStreamAt = Date.now(); this.streamBroken = false; this.attempts = 0;
              const bothFresh = (Object.keys(MARKETS) as Market[]).every((key) => quotes[key]?.source === "stream" && Date.now() - quotes[key]!.receivedAt < 45_000);
              this.publish({ quotes, status: bothFresh ? "live" : this.state.status, quoteError: false });
            }
          } else if (message.channel === "ohlc") {
            const bars = message.data.flatMap((raw) => { const bar = parseStreamCandle(raw, this.market, this.interval); return bar ? [bar] : []; });
            if (bars.length) {
              if (this.historyPending) this.streamBars = mergeCandles(this.streamBars, bars);
              this.publish({ bars: mergeCandles(this.state.bars, bars), candlesReceivedAt: Date.now() });
            }
          }
        } catch { /* Ignore malformed third-party messages without losing the last valid snapshot. */ }
      };
      socket.onerror = () => this.failStream();
      socket.onclose = () => this.failStream();
    } catch { this.failStream(); }
  }
}
