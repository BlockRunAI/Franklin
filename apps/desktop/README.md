# Franklin Desktop

Franklin Desktop is the native macOS and Windows workspace for the
[Franklin agent](https://github.com/BlockRunAI/Franklin). It packages the real
Franklin runtime inside an Electron shell; it is not a hosted web client or a
mock of the CLI.

> **Status: Beta.** CI produces unsigned test installers for macOS Apple silicon
> and Windows x64. Signed public downloads and automatic updates are not live yet.
> Team Mode and Studio adapters for additional agent CLIs are being developed
> separately and are not included in this stable integration.

## What is included

- Franklin chat with streaming tool activity and permission requests
- Persistent local conversations and search
- Model selection through the BlockRun router
- Local wallet, spend, media gallery, tools, skills, and CLI panels
- Collapsible navigation and light/dark themes
- The same Franklin agent loop and tool registry used by the CLI

## Workspace and security

Packaged builds use `Documents/Franklin` as the default workspace. Workspace
files are available to Franklin normally. A direct or symlinked path outside the
workspace is still usable, but the app asks for explicit approval first. Shell
commands also ask for approval in the current beta.

The Desktop shell creates a private credential for each local agent launch,
restricts local service origins and file URLs, and does not silently inherit
ambient API keys from the launching shell. Cloud session sync is disabled in
packaged Desktop builds unless the user explicitly enables it.

## Development

Use Node.js 22 LTS (22.12 or newer is recommended), then run these commands from
the repository root:

```bash
npm install
npm run build
npm run desktop:real --workspace @blockrun/franklin-desktop
```

For visual work that does not need a live agent, start the Electron app with the
mock backend:

```bash
npm run desktop:dev
```

## Check and package

```bash
npm run desktop:build
npm run desktop:package:mac
npm run desktop:package:win
```

Installers are written to `apps/desktop/release/`. Local and CI packages are
unsigned test builds, so operating systems may show a developer verification
warning. The CI workflow uploads its installers for seven days.

## Repository structure

```text
apps/desktop/
├── electron/          Electron main process and preload bridge
├── franklin-agent/   Packaged launcher for the Franklin runtime
├── src/              React renderer, panels, hooks, and styles
├── build/            Desktop icons and packaging assets
└── release/          Local packaging output (not committed)

src/serve/             Authenticated local Franklin service shared by Desktop
```

The renderer communicates with the local service over an authenticated WebSocket
protocol. Shared message types live in `apps/desktop/src/lib/wire.ts` and the
server implementation lives in `src/serve/`.

## License

Apache-2.0, the same license as Franklin.
