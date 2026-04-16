/**
 * Persistence for ContentLibrary. Whole-library JSON snapshot (vs the
 * trade log's append-only JSONL) because content records are mutable
 * throughout their life — new drafts, new assets, status transitions —
 * so append-only would require replaying every edit on load. A single
 * re-written JSON file is simpler and content volume is orders of
 * magnitude smaller than a trade log.
 *
 * Disk failures and corruption are always survivable: save is
 * best-effort, load returns `null` on any error so the agent falls back
 * to a fresh in-memory library rather than refusing to start.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { ContentLibrary, type Content } from './library.js';

interface SerializedLibrary {
  version: 1;
  contents: Content[];
}

export function saveLibrary(lib: ContentLibrary, filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const payload: SerializedLibrary = { version: 1, contents: lib.list() };
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Persistence is best-effort; never block a capability call on disk
    // failure. The in-memory library stays authoritative until the next
    // successful save.
  }
}

export function loadLibrary(filePath: string): ContentLibrary | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SerializedLibrary;
    if (raw?.version !== 1 || !Array.isArray(raw.contents)) return null;
    const lib = new ContentLibrary();
    for (const c of raw.contents) {
      // Defensive — skip records missing the load-bearing fields rather than
      // importing partially-shaped data.
      if (
        typeof c?.id !== 'string' ||
        typeof c?.title !== 'string' ||
        typeof c?.budgetUsd !== 'number' ||
        typeof c?.spentUsd !== 'number' ||
        !Array.isArray(c?.assets) ||
        !Array.isArray(c?.drafts) ||
        !Array.isArray(c?.distribution)
      ) {
        continue;
      }
      lib.restore(c);
    }
    return lib;
  } catch {
    return null;
  }
}
