#!/usr/bin/env node
/**
 * Postbuild: copy plugin.json (and any non-TS assets) from src/plugins-bundled
 * to dist/plugins-bundled, since tsc only compiles .ts files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'plugins-bundled');
const DIST = path.join(ROOT, 'dist', 'plugins-bundled');

if (!fs.existsSync(SRC)) {
  console.log('[copy-plugin-assets] no src/plugins-bundled directory, skipping');
  process.exit(0);
}

let copied = 0;

function walk(dir, base) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const rel = path.relative(SRC, srcPath);
    const distPath = path.join(DIST, rel);

    if (entry.isDirectory()) {
      walk(srcPath, base);
    } else if (entry.isFile() && !entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      // Copy non-TS files (plugin.json, README, etc.)
      fs.mkdirSync(path.dirname(distPath), { recursive: true });
      fs.copyFileSync(srcPath, distPath);
      copied++;
    }
  }
}

walk(SRC, SRC);
console.log(`[copy-plugin-assets] copied ${copied} files to dist/plugins-bundled/`);
