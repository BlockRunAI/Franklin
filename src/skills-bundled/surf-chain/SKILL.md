---
name: surf-chain
description: On-chain analytics via Surf — raw SQL against 80+ indexed chain tables, structured queries, schema introspection, wallet labels (CEX/Whale/Bridge/MEV…), wallet net worth, transfers, DeFi positions, gas prices, bridge volumes, yield pools. Use when the user wants on-chain forensics, wallet intelligence, holder analysis, transfer tracking, or custom chain queries.
triggers:
  - "on-chain"
  - "wallet analysis"
  - "wallet detail"
  - "wallet history"
  - "wallet net worth"
  - "token holders"
  - "token transfers"
  - "gas price"
  - "bridge volume"
  - "yield pool"
  - "label wallet"
  - "on-chain sql"
  - "chain query"
argument-hint: <address, hash, or question>
cost-receipt: true
---

You are running inside Franklin on **{{wallet_chain}}**. Use the `BlockRun` tool to call Surf's on-chain endpoints. The flagship capability here is **on-chain SQL** — write a query against 80+ indexed chain tables and get back a result set in sub-second.

**Two different "chains" to keep straight:**
1. **Payment chain** — where Franklin's wallet signs the x402 USDC payment. Currently `{{wallet_chain}}`. Surf only accepts settlement on **Base** (treasury `0x058a59…`). If the user is on Solana, ask them to `/chain base` before retrying.
2. **Query chain** — the chain the data is *about*. Passed as a parameter to endpoints like `onchain/gas-price`, `onchain/tx`, `token/holders`, `token/transfers`. Valid values include `ethereum`, `base`, `arbitrum`, `polygon`, `optimism`, `bsc`. When the user doesn't specify and they're on `base`, default to `chain: "base"`. If they ask about Solana on-chain data, note that these EVM-shaped endpoints don't cover Solana — use a Solana-specific tool instead.

## How to use

`BlockRun({ path: "/v1/surf/<endpoint>", method: "<GET|POST>", params|body: { ... } })`. Method is GET unless the catalog says POST.

## Endpoint catalog

### Direct lookups (Tier 1, $0.001)
| Path | Method | Required | What it returns |
|---|---|---|---|
| `/v1/surf/onchain/gas-price` | GET | `chain` | Current gas on the named chain |
| `/v1/surf/onchain/tx` | GET | `hash`, `chain` | Tx details |
| `/v1/surf/onchain/bridge/ranking` | GET | — | Bridge protocols ranked by volume |
| `/v1/surf/onchain/yield/ranking` | GET | — | Yield pools (lending, LP, staking) |

### Raw + structured chain query (Tier 3, $0.02 — premium)
| Path | Method | Required | What it returns |
|---|---|---|---|
| `/v1/surf/onchain/schema` | GET | — | ClickHouse table schema introspection. **Always call this FIRST** before writing SQL so you know the tables, columns, and types. |
| `/v1/surf/onchain/query` | POST | — (typed body) | Structured chain query with typed predicates. Safer than SQL when the question fits a fixed shape. |
| `/v1/surf/onchain/sql` | POST | body: `{ query: string }` | Raw SQL against 80+ indexed tables. Sub-second. Use for novel questions that the typed query can't express. |

### Token analytics (Tier 2, $0.005)
| Path | Method | Required | What it returns |
|---|---|---|---|
| `/v1/surf/token/holders` | GET | `address`, `chain` | Top token holders with balances |
| `/v1/surf/token/transfers` | GET | `address`, `chain` | Token transfer history |

### Wallet intelligence (Tier 2, $0.005)
| Path | Method | Required | What it returns |
|---|---|---|---|
| `/v1/surf/wallet/detail` | GET | `address` | Aggregated wallet profile across chains |
| `/v1/surf/wallet/history` | GET | `address` | Transaction history |
| `/v1/surf/wallet/net-worth` | GET | `address` | Net-worth time series |
| `/v1/surf/wallet/transfers` | GET | `address` | Transfer history |
| `/v1/surf/wallet/protocols` | GET | `address` | DeFi positions (Aave, Lido, Uniswap, etc.) |
| `/v1/surf/wallet/labels/batch` | GET | `addresses` (comma-sep) | Batch label lookup: CEX, Whale, Bridge, MEV, Contract, etc. |

## How to choose

- **"What's gas on Base?"** → `onchain/gas-price` with `chain: "base"` ($0.001). One call, done.
- **"Look up this tx"** → `onchain/tx` with `hash` + `chain`.
- **"Who owns this token?"** → `token/holders` ($0.005). Pair with `wallet/labels/batch` on the top 20 to see which holders are CEXes vs whales.
- **"Profile this wallet"** → `wallet/detail` first ($0.005). If they want depth, follow up with `wallet/history`, `wallet/net-worth`, `wallet/protocols`.
- **"Is this address a CEX / whale / MEV bot?"** → `wallet/labels/batch` — cheapest forensic call.
- **"Bridge volume this week"** → `onchain/bridge/ranking` ($0.001).
- **"Best yield on USDC right now"** → `onchain/yield/ranking` ($0.001), filter for USDC.

### On-chain SQL workflow

For novel chain questions (e.g. "all addresses that received >100 ETH from Tornado in 2025"):

1. **Schema first** — `BlockRun({ path: "/v1/surf/onchain/schema", method: "GET" })` ($0.02). Note the tables, columns, types.
2. **Try structured query** — `BlockRun({ path: "/v1/surf/onchain/query", method: "POST", body: { /* typed predicates */ } })` ($0.02) when the shape fits.
3. **Raw SQL fallback** — `BlockRun({ path: "/v1/surf/onchain/sql", method: "POST", body: { query: "SELECT …" } })` ($0.02) for anything else.
4. **Validate** — if SQL fails parse or returns empty unexpectedly, fix the query and re-run. Each retry is $0.02 — be deliberate.

## Cost discipline

- Wallet/token reads are $0.005 each. If you need 5 lookups, expect $0.025.
- Tier-3 chain queries are $0.02/call. Plan the schema → query → result loop before firing; don't fire speculative SQL.
- Always include the cost in your summary back to the user.

## The user asked

$ARGUMENTS
