import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.cjs',
  external: ['vscode', 'playwright-core', 'chromium-bidi'],
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
  logLevel: 'info',
});
