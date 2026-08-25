# franklin-desktop

**Native desktop app for the [Franklin agent](https://github.com/BlockRunAI/Franklin) (Electron).**

Same agent, same wallet, same tools as the CLI — in a polished native window
(macOS / Windows / Linux). The desktop shell spawns Franklin's local `webui`
agent server and talks to it over a WebSocket; the renderer is a React app with
chat, image / video / music generation, a marketplace, gallery, wallet and more.

> Think Claude Code or Cursor's chat panel, but for the Franklin agent — as a
> standalone app. (Started life as the browser-based `franklin-webui`; the same
> renderer now ships inside the desktop shell.)

## Run (dev)

```bash
npm install
npm run desktop:real   # real Franklin agent + Electron window
npm run desktop:dev    # mock backend (UI work, no agent)
```

## Why a separate UI

| | Franklin CLI (Ink) | **franklin-webui** | [franklin.run](https://franklin.run) (hosted web) |
|---|---|---|---|
| Runs | Your terminal | `localhost`, your browser | Public website |
| Backend | The CLI process itself | **The CLI process itself** | franklin.run's Next.js + BlockRun gateway |
| Wallet | `~/.blockrun/wallet.key` (local) | **Same local key, zero popups** | Browser wallet (MetaMask/Coinbase), sign every payment |
| Tools | All 12 built-in + MCP | **All 12 built-in + MCP** | Web-safe subset (search, prediction, prices, media) |
| File access | Real (`Read`/`Write`/`Edit`) | **Real (`Read`/`Write`/`Edit`)** | None |
| Shell access | Real (`Bash`) | **Real (`Bash`)** | None |
| Audience | Power developers | Developers who prefer GUI to TUI | Anyone trying Franklin |

The CLI and the WebUI share **the same agent loop, wallet, sessions, and tool registry**. The browser is just a richer renderer than Ink.

## Architecture

```
┌─ Browser tab ────────────────────────┐
│   franklin-webui (this repo)         │
│   Vite + React 19 + TypeScript       │
│   Single WebSocket → CLI             │
└────────────┬─────────────────────────┘
             │ ws://localhost:3737/agent
             │ (single duplex channel, envelope protocol — see src/lib/wire.ts)
             │
┌─ CLI process (Franklin repo) ────────┐
│   `franklin webui` command           │
│   Express/Fastify on :3737           │
│     - Serves the built UI on /       │
│     - WebSocket on /agent for the    │
│       agent loop + RPCs              │
│     - HTTP /artifacts/* for          │
│       generated media files          │
│   Reuses existing src/agent/loop.ts, │
│   src/tools/*, src/wallet/*,         │
│   src/session/*                      │
└──────────────────────────────────────┘
```

## Repo layout

```
src/
├── App.tsx                    # shell: i18n + theme + main view
├── main.tsx                   # React 19 entry
├── components/
│   ├── FranklinChat.tsx       # main chat surface (composer + messages + steps)
│   ├── HistorySidebar.tsx     # session list + search + wallet pill + settings
│   ├── WalletPill.tsx         # bottom-of-sidebar wallet status (read-only)
│   ├── MoreMenu.tsx           # theme / language flyout
│   ├── MessageContent.tsx     # markdown renderer (ported from franklin-run)
│   ├── MessageActions.tsx     # copy / like / dislike / regenerate row
│   ├── ActivitySummary.tsx    # "searched N keywords · M sources" recap
│   └── ModelSelect.tsx        # model picker with grouping (Free / Premium / etc.)
├── hooks/
│   ├── use-franklin-chat.ts   # streams agent turns over WebSocket
│   ├── use-sessions.ts        # list / select / delete / rename sessions
│   ├── use-wallet.ts          # read-only wallet info from CLI
│   ├── use-models.ts          # model catalog from CLI
│   └── use-theme.ts           # gold / light / dark
├── lib/
│   ├── wire.ts                # WebSocket envelope + payload types (the contract)
│   ├── ws.ts                  # singleton WebSocket client (auto-reconnect, RPC)
│   └── i18n.tsx               # 3-language dictionary (en / zh / es)
└── styles/
    └── globals.css            # full design system, ported from franklin-run

dev-server/
└── mock.mjs                   # standalone WebSocket server speaking the same
                               # protocol, for UI dev without the real CLI
```

## Development

Two-terminal flow:

```bash
npm install

# Terminal 1 — fake CLI backend
npm run dev:server
# → http://localhost:3737  (WebSocket: ws://localhost:3737/agent)

# Terminal 2 — Vite dev server
npm run dev:vite
# → http://localhost:5173  (proxies /agent to :3737)
```

Or one-shot with auto-restart on either:

```bash
npm run dev
```

## Wire protocol

[src/lib/wire.ts](./src/lib/wire.ts) defines the full message contract. Both sides — the React UI and the CLI's `webui` server — must speak it. Brief shape:

```ts
// Client → Server
{ id: "m1", kind: "agent.send", payload: { sessionId, text, model? } }

// Server → Client (streamed for `agent.send`, single response for RPCs)
{ id: "m1", kind: "agent.step",    payload: { stepId, label, state: "thinking" } }
{ id: "m1", kind: "agent.text",    payload: { sessionId, text: "Hello " } }
{ id: "m1", kind: "agent.text",    payload: { sessionId, text: "world" } }
{ id: "m1", kind: "agent.done",    payload: { sessionId, costUsd: 0.0023 } }
```

| Client `kind` | Direction | Notes |
|---|---|---|
| `agent.send` | → | Stream — fires multiple server messages, terminates with `agent.done` or `agent.error` |
| `agent.cancel` | → | Fire-and-forget for the matching turn id |
| `agent.permissionResponse` | → | Reply to a server-issued `agent.permissionAsk` |
| `session.list` / `.load` / `.delete` / `.rename` | ↔ | Request/response |
| `wallet.info` / `wallet.balance` | ↔ | Request/response |
| `models.list` / `settings.get` / `settings.set` | ↔ | Request/response |

| Server `kind` | Direction | Notes |
|---|---|---|
| `agent.text` / `.step` / `.tool_use` / `.tool_result` | ← | Streamed during a turn |
| `agent.permissionAsk` | ← | Mid-turn block; UI surfaces approve/deny |
| `agent.payment` | ← | Informational — CLI signs locally, no UI action |
| `agent.done` / `.error` | ← | Terminate the stream for the matching id |
| `session.event` / `wallet.event` | ← | Server-initiated broadcasts (no client id to echo) |
| `response` / `error` | ← | Reply to a client-issued RPC |

## What the CLI side needs to add (separate Franklin PR)

This repo only contains the UI. To make it work end-to-end, the Franklin CLI repo adds:

1. **`src/commands/webui.ts`** — `franklin webui [--port 3737] [--open]` command
2. **`src/webui-server/`** — Express/Fastify + `ws` setup:
   - `GET /` and `GET /assets/*` → serve `node_modules/@blockrun/franklin-webui/dist/`
   - `WS /agent` → router that dispatches `ClientMsg.kind` to the appropriate adapter
   - `GET /artifacts/:sessionId/:filename` → serve files generated by tools (images, videos, audio)
3. **Adapters** mapping wire protocol kinds to existing CLI internals:
   - `agent.send` → wrap `interactiveSession` from `src/agent/loop.ts`; pipe events to the WebSocket
   - `session.*` → `src/session/storage.ts`
   - `wallet.*` → `src/wallet/*`
   - `models.list` → existing model catalog
4. **Optional dep** in CLI's `package.json`: `"@blockrun/franklin-webui": "^0.1.0"`, downloaded on first use of `franklin webui`

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **v0.1** | Chat-only. Sessions, sidebar, model picker, activity log, permission asks. Mock dev server. | **shipped (this commit)** |
| v0.2 | Image / video / music modes (reuse franklin-run's ratio/resolution pickers). Wire to existing CLI media tools. | planned |
| v0.3 | Tool execution visualization — Read/Write/Edit show diffs; Bash shows live output; MCP tools show their schemas. | planned |
| v0.4 | File browser panel (working-directory tree) + terminal panel (xterm.js bound to a CLI-spawned PTY). | planned |
| v0.5 | Settings panel (chain switch, model picker, plugin manager, telemetry toggle). Real Skills panel backed by `Plugin` SDK. | planned |
| v1.0 | Mobile polish, SSE fallback for environments where WebSocket is blocked, integration tests against real CLI. | planned |

## License

Apache-2.0 — same as the Franklin CLI.
