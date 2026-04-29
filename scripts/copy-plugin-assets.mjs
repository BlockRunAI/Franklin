#!/usr/bin/env node
/**
 * Postbuild: copy non-TS assets from `src/plugins-bundled` and
 * `src/skills-bundled` into the matching `dist/` paths, since tsc only
 * compiles .ts/.tsx.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ASSET_TREES = [
  { src: path.join(ROOT, 'src', 'plugins-bundled'), dist: path.join(ROOT, 'dist', 'plugins-bundled'), label: 'plugins-bundled' },
  { src: path.join(ROOT, 'src', 'skills-bundled'),  dist: path.join(ROOT, 'dist', 'skills-bundled'),  label: 'skills-bundled' },
];

function walk(srcRoot, distRoot, dir) {
  let copied = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(dir, entry.name);
    const rel = path.relative(srcRoot, srcPath);
    const distPath = path.join(distRoot, rel);

    if (entry.isDirectory()) {
      copied += walk(srcRoot, distRoot, srcPath);
    } else if (entry.isFile() && !entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
      // Copy non-TS files (plugin.json, README, SKILL.md, etc.)
      fs.mkdirSync(path.dirname(distPath), { recursive: true });
      fs.copyFileSync(srcPath, distPath);
      copied++;
    }
  }
  return copied;
}

for (const tree of ASSET_TREES) {
  if (!fs.existsSync(tree.src)) {
    console.log(`[copy-plugin-assets] no src/${tree.label} directory, skipping`);
    continue;
  }
  const copied = walk(tree.src, tree.dist, tree.src);
  console.log(`[copy-plugin-assets] copied ${copied} files to dist/${tree.label}/`);
}

// Ensure the CLI entry point stays executable. tsc drops the exec bit every
// build, and without this a clean `rm -rf dist && npm run build` leaves
// `franklin` as a non-executable file — the shebang is correct but the
// kernel won't run it. Mirrors what npm does for published bins.
const ENTRY = path.join(ROOT, 'dist', 'index.js');
if (fs.existsSync(ENTRY)) {
  try {
    fs.chmodSync(ENTRY, 0o755);
  } catch (err) {
    console.warn(`[copy-plugin-assets] chmod failed on ${ENTRY}: ${err.message}`);
  }
}
