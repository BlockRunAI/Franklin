# Contributing to RunCode

## Setup

```bash
git clone https://github.com/BlockRunAI/runcode
cd runcode
npm install
npm run build
```

## Development

```bash
npm run dev              # Watch mode — recompiles on save
npm start                # Run the agent
npm test                 # Deterministic local tests
npm run test:e2e         # Live E2E tests (model API required)
```

## Code Standards

- TypeScript strict mode
- ESM modules only
- Node >= 20

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `npm run build` to verify compilation
5. Run `npm test` before opening a PR (`npm run test:e2e` if relevant to your change)
5. Submit a PR with a clear description

## Architecture

RunCode uses `@blockrun/llm` for model access and x402 payments. The agent loop is in `src/agent/`, tools in `src/tools/`, and the terminal UI uses Ink (React for terminals).

## License

Apache-2.0
