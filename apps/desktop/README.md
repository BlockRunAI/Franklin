# Franklin Desktop

Franklin Desktop is the native Electron interface for the Franklin agent. It
lives in the main Franklin repository so every Desktop release is built from a
reviewed Franklin runtime and the matching UI.

## Current beta

- Franklin chat with streaming tool activity and inline permission requests
- local Base and Solana wallets with in-app network switching, or prepaid account billing via a BlockRun API key
- model catalog, skills, MCP, media generation, wallet activity, and market tools
- Agent Studio for discovering and importing supported local agent runtimes
- personal and Team conversation spaces
- Team projects with members, shared conversations, and versioned files
- local Team sidecar protected by per-launch tokens and strict loopback access

Private keys remain in the local Franklin process. The renderer receives only
the wallet address, balance, network, and the narrow operations exposed by the
Electron preload bridge.

## Development

Run commands from the Franklin repository root:

```bash
npm ci
npm run build
npm run desktop:real
```

For UI development with the mock agent backend:

```bash
npm run desktop:dev
```

The Vite renderer, Franklin agent, and Team sidecar use loopback-only services.
Packaged builds select ephemeral ports and pass unguessable credentials through
the isolated preload bridge.

## Validation

```bash
npm run typecheck --workspace @blockrun/franklin-desktop
npm run lint --workspace @blockrun/franklin-desktop
npm test --workspace @blockrun/franklin-desktop
npm run build --workspace @blockrun/franklin-desktop
```

The test suite covers Electron URL and IPC boundaries, hostile WebSocket
origins, the Team control plane, sandbox staging, SIWE authentication, and the
Team-to-Franklin agent proxy.

## Packaging

```bash
npm run desktop:package:mac
npm run desktop:package:win
```

`scripts/prepare-runtime.mjs` copies the main repository's built Franklin
runtime into the application before `electron-builder` creates the installer.
The release workflow builds macOS Apple Silicon and Windows x64 installers from
tags matching `desktop-v*`, then publishes them as a GitHub prerelease with
SHA-256 checksums.

Beta installers are currently unsigned. Users may need to confirm the first
launch through their operating system's security prompt.

## Desktop updates

Installed builds with the update feature check the public
`BlockRunAI/Franklin` GitHub releases 30 seconds after startup and every six
hours while running. Settings → Check for updates shows the Desktop version
and offers the newest compatible installer. Beta builds include Desktop
prereleases; stable builds stay on stable releases. CLI releases and drafts are
excluded. No wallet credentials or GitHub login are needed for these checks.

A new release adds **Update Franklin** to the bottom of the sidebar, including
a compact control when the sidebar is collapsed or Trading Mode is active.
Clicking downloads the update inside Franklin, showing progress in the same
button. Once verified, it becomes **Restart to update**. This uses
`electron-updater`: Squirrel.Mac replaces the signed app and relaunches it;
NSIS silently upgrades and relaunches on Windows. Chat, media and Team tasks
block installation in both the renderer and main process. The update never
installs merely because a download finished or the user quits the app.

The release selector pins the native provider to the chosen **Desktop** tag,
so the shared repository's CLI releases cannot become Desktop updates. Native
update metadata must refer to the exact published assets and sizes. The updater
checks SHA-512; Franklin also checks the GitHub SHA-256 digest when present and
rehashes the downloaded file before installation. Code signature checks remain
enabled. Network, checksum and native installation failures are retryable.

Signed/notarized macOS releases include a ZIP payload and `latest-mac.yml`;
Windows includes `latest.yml` and the NSIS installer. Older releases without
native metadata, and unsigned macOS test builds, retain the explicit installer
fallback. They show **Open installer**, not **Restart to update**. See
[signing and release setup](docs/desktop-updates.md) before publishing a new tag.

Older releases, including `0.2.0-beta.6`, do not contain this feature. Those
users must install a release with update support manually once before they can
receive future in-app update prompts.

The update manager and renderer tests are included in `npm test`. For a native
Electron check of sidebar detection, Settings, verified downloads, retry and
Chinese/dark/narrow layout, run `npm run test:updates --workspace
@blockrun/franklin-desktop`. This uses an isolated profile and fixture release
data; it never launches a real installer or sends a paid model request. Windows
CI additionally installs an older package in an isolated directory, downloads
a newer NSIS payload through the native adapter and silently upgrades that
installation while checking that user data survives. This installer test
refuses to run outside an ephemeral Windows Actions runner.

## Team service

Electron starts `cloud-server/server.mjs` as a local sidecar. It accepts only an
explicit action allowlist and requires the per-process Desktop token. A private
remote Team endpoint can be configured with `FRANKLIN_TEAM_CLOUD_URL` or
`~/.blockrun/franklin-team-cloud-url`.

The included standalone control-plane and sandbox provider are development
testbeds. Production Team execution must use an isolated remote worker and
wallet broker rather than exposing a local runtime or Docker socket.

## License

Apache-2.0
