# 0001 — x402 micropayments as Franklin's economic substrate

**Status:** accepted

Franklin pays for every paid call by signing a USDC micropayment over the HTTP `402 Payment Required` flow against a user-funded wallet, instead of running on a flat-rate subscription, a credit ledger, or per-vendor API keys. This decision is the spine of the project: it is the mechanism that makes "give the AI a budget and walk away" structurally true rather than a UX promise.

## Considered options

- **Flat-rate subscription (rejected).** Decouples agent actions from cost — destructive actions have no upper bound, token bloat is invisible, and the agent has no economic feedback from its own behavior. The Economic Agent category does not exist on top of this substrate.
- **Pre-funded credit ledger on a centralized backend (rejected).** Solves cost visibility but reintroduces a privileged operator (us) on the spend path, makes multi-provider routing political, and turns "no bank account needed" into a lie. Lock-in returns through the back door.
- **Per-vendor API keys passed through (rejected).** Pushes wallet management onto the user as N separate accounts and gives the agent no uniform price-per-call surface. The router cannot meaningfully shop across vendors without a common payment shape.
- **x402 against a single gateway (chosen).** Gives a wallet-as-identity, on-chain receipt per call, and a single price-per-call surface that the router and the per-turn spend cap can both reason about. Adds a hard dependency on the gateway accepting x402 (see ADR 0002).

## Consequences

- The wallet, not the user account, is the rate limiter — running out of USDC is the only structural stop. This is intentional and shapes the design of the **per-turn spend cap**, the **fallback chain**, and the **subagent cost gate**.
- Every paid tool (`Exa*`, `ImageGen`, `VideoGen`, `MusicGen`, `TradingMarket` stocks/fx/commodities) implements the same x402 probe → sign → retry shape. Adding a new paid tool means wiring that shape, not inventing a new payment mechanism.
- Removing x402 would require redesigning the payment surface end-to-end and would dissolve the category positioning in [`PHILOSOPHY.md`](../../PHILOSOPHY.md). Treat this ADR as load-bearing.
