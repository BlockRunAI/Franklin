# Desktop public spot markets

Enable **Settings → Trading Mode**, or use **Markets** in the normal Desktop
sidebar as a shortcut to the same mode. BTC/USD and ETH/USD quote cards select
the chart; intervals are 1m, 5m, 15m, 1h, 4h and 1D. The chart includes volume,
zoom/pan, crosshair, and a text table of the last 20 candles. Light, Dark and Gold
themes and the Desktop minimum window width are supported. Normal mode retains team/project, Agents and creative navigation. Trading Mode
keeps markets, personal chat history, wallet and settings visible.

## Data contract

- Quotes and candles use Kraken public spot data, with no API key, wallet or
  agent request. This is a single exchange's USD market, not a consolidated
  index, a USD-stablecoin pair or an on-chain swap execution quote.
- REST bootstrap: `https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD`
  and `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60` (or ETHUSD).
- Live stream: `wss://ws.kraken.com/v2`, `ticker` for both symbols and `ohlc`
  for the selected symbol/interval. The CSP allows only these additional hosts;
  Electron web security, context isolation and sandbox settings stay enabled.
- Rolling 24h change comes from the live ticker's `change_pct`. REST's `o` is
  today's UTC opening price and is deliberately **not** presented as 24h change.
  The percentage is shown as unavailable in REST-only mode.
- Candles use `interval_begin` in UTC. Recent history is capped at 720 candles;
  the last candle may still be forming. No-trade intervals may be absent.
- Received times describe when Franklin obtained a snapshot, not the time of
  the last trade. Data older than 45 seconds is marked stale. A heartbeat alone
  cannot make quotes fresh. Live status requires fresh stream quotes for both
  symbols; candle freshness is reported separately.
- Requests time out after 10 seconds. Stream failure triggers bounded
  exponential reconnects and 15-second REST polling. Reconnect refreshes history;
  stale candles are refreshed even if the ticker stream is still healthy.
  Request cancellation and per-selection feed lifetimes protect against slow
  responses from a previously selected pair/interval. Only updates received
  during a history request may override that history snapshot.
- Leaving Markets disposes its sockets, fetches and timers. Viewing Markets or
  choosing **Reference market** never sends a chat/agent request, signs
  anything or places an order. That action appends dated spot context to the
  existing personal draft for review; it does not replace the user's draft.

## Local verification

From the repository root:

```sh
npm ci
npm run test:unit --workspace @blockrun/franklin-desktop
npm run test:security --workspace @blockrun/franklin-desktop
npm run lint --workspace @blockrun/franklin-desktop
npm run test:markets --workspace @blockrun/franklin-desktop
npm run test:markets:live --workspace @blockrun/franklin-desktop
```

The last two commands build the production renderer and launch the actual
Electron shell with a unique temporary profile, work directory and cloud demo
data directory. They force the existing mock backend and intercept agent
messages; unexpected `agent.send` calls fail the test. One explicitly permitted fixture case
returns a zero-cost chat response directly from the test driver. They never open a real
agent runtime, authenticate a trading account or use a real wallet. Fixtures
exercise live updates, all intervals, cancellation, offline/recovery states,
data tables, themes, minimum window width, navigation and preserving drafts.
The `:live` variant reads real public Kraken quotes and candles without making
authenticated requests. Logs print a temporary artifact directory containing
results and a Chinese Desktop screenshot. The live test requires internet
access; all fixture tests need permission to bind local loopback ports.

Chart rendering uses pinned `lightweight-charts` 5.2.1 (Apache-2.0), separately
from the data provider. Its attribution logo is enabled and the page includes
the upstream copyright notice/link. A notice also ships in
`public/market-third-party-notices.txt`. Public accessibility of an API does not
change its provider's applicable usage terms.

Primary references:

- https://docs.kraken.com/api-reference/market-data/get-ohlc-data
- https://docs.kraken.com/api-reference/market-data/get-ticker-information
- https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker
- https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ohlc
- https://github.com/tradingview/lightweight-charts/tree/v5.2.1

## Trading Mode and interaction

Settings → Trading Mode enables the focused chart/chat workspace. It hides
creative model catalogs, gallery, marketplace, projects and agent management.
The choice persists across restarts; Exit Trading Mode returns to ordinary chat.
During the same session, exiting restores the previous view, mode and draft.
Switching mode is disabled during a running task. Trading Mode is a UI preference
and does not change tool permissions or execute orders.

The split, chat-only and chart-only layouts animate without scaling text;
reduced-motion preferences are respected. Chat messages and composer share a
bounded column, compact type and consistent alignment at narrow window sizes.
Settings submenus open on click and remain scrollable within the minimum window.
