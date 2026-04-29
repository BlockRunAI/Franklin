# 0002 — Single BlockRun Gateway as the only upstream

**Status:** accepted

Franklin makes every LLM and paid-tool call through a single counterparty — the BlockRun Gateway — instead of integrating directly with each model provider, image/video/audio service, search API, and market-data feed. The gateway aggregates 55+ models and a small set of paid APIs and accepts x402 uniformly.

## Considered options

- **Direct integration per provider (rejected).** Each provider has its own auth, billing, rate-limit, error shape, and (for the paid ones) bespoke payment plumbing. Multi-provider routing would mean reimplementing the **fallback chain** and **payment-aware fallback** N times, and the **per-turn spend cap** would need to reason across N pricing schemas. The ergonomics of "one wallet, one chain, one signing flow" disappear.
- **Multiple aggregators behind a Franklin-side adapter layer (rejected for now).** Solves single-vendor risk but doubles the surface the **router**, **fallback chain**, and **picker** have to reason about, and the x402 shape is still gateway-specific. Worth revisiting only if BlockRun proves to be a reliability bottleneck.
- **Single gateway (chosen).** One counterparty, one auth shape, one payment shape, one upstream price feed for the picker. The router and the proxy server are simpler because of this.

## Consequences

- Every LLM call, every paid tool, every market-data fetch, and every `TradingMarket` `stockPrice`/`fxPrice`/`commodityPrice` request flows through the same gateway client, with the same telemetry ring buffer (`src/trading/providers/telemetry.ts`).
- "Gateway retired this model" or "gateway exposes this model unreliably on `/v1/messages`" is a recurring failure mode; the **free tier matrix** test (`npm run test:free-models`) exists specifically to detect that drift.
- Single-vendor risk on the upstream is real. The acceptable mitigation today is the **fallback chain** (cross-model resilience, not cross-gateway), the **doctor** command's `gateway` row, and the picker's "retired/unreliable gateway-model" comments. Cross-gateway resilience is explicitly out of scope until a second x402-capable aggregator exists.
- Reversing this would mean reintroducing per-provider clients in `src/agent/llm.ts`, `src/proxy/`, and every paid tool — a large surface change. Treat new direct-provider integrations as a red flag for review.
