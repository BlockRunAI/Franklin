# Contributing to Franklin Agent

## Setup

```bash
git clone https://github.com/BlockRunAI/Franklin
cd Franklin
npm install
npm run build
```

## Development

```bash
npm run dev              # Watch mode — recompiles on save
npm start                # Run the agent
npm test                 # Deterministic local tests (no API calls, no wallet funding)
npm run test:e2e         # Live E2E tests (real models, needs a funded wallet)
```

## Code Standards

- TypeScript strict mode
- ESM modules only (`"type": "module"`)
- Node >= 20
- **English-only source.** Comments, prompts, tool spec descriptions,
  classifier keyword arrays, and few-shot examples in `src/` must not
  contain literal restricted-script (CJK / Korean / etc.) characters.
  The model is multilingual at runtime; the policy keeps the source
  audit-friendly. A regression test in `test/local.mjs` enforces this on
  every PR. Test fixtures and changelog/release-note evidence are
  exempt.
- **Never reference competitor product names** in commits, comments, or
  docs. State capabilities directly without comparison.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `npm run build` to verify compilation
5. Run `npm test` (and `npm run test:e2e` if your change touches model
   calls, x402 settlements, or tool integrations)
6. Submit a PR with a clear description

### Quality bar for fixes

Franklin is audit-driven: every fix should have a receipt — a real
session, log line, gateway response, or failing test that proves the
bug is real and the fix lands.

When you find a bug, **search the codebase for the same bug class
before opening a PR.** If you find one `JSON.stringify(part.content)`
that destroys image blocks, there are likely four more — fix them all
in the same PR rather than leaving sibling instances unpatched. The
review will surface them anyway, and a one-shot landing is cheaper
than a follow-up cycle.

Add at least one regression test for each behavior you fix. The PR
description should quote the original failure mode (the log line, the
session id, the gateway 402 body, etc.) so the receipt survives in git
history alongside the code change.

## Architecture

Franklin uses [`@blockrun/llm`](https://www.npmjs.com/package/@blockrun/llm)
for model access and x402 micropayments on Base or Solana. The agent
loop lives in `src/agent/`, tools in `src/tools/`, and the terminal UI
is Ink (React for terminals) under `src/ui/`. Plugins are extensible
via the public SDK in `src/plugin-sdk/`.

For a deeper architecture tour, see `docs/anatomy-of-an-economic-agent.md`
and the ADRs under `docs/adr/`.

## Releases

Patches land on `main` and ship via `chore(release): X.Y.Z — …`
commits that bump `package.json` and prepend a `CHANGELOG.md` entry.
A matching narrative goes under `docs/release-notes/YYYY-MM-DD-*.md`.
The `npm publish` step is currently driven manually by the maintainer;
the GitHub Release tag is the canonical record.

## License

Apache-2.0
