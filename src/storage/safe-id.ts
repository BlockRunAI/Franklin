/**
 * Ids that become a single path segment (session ids, task run ids).
 *
 * These ids reach the filesystem helpers from URLs (panel /api/sessions/:id,
 * /api/tasks/:runId) after decodeURIComponent, so `..%2F` arrives as `../`.
 * Validate in the shared path helper, not in each route: GHSA-jx74-262x-94p3
 * fixed the sessions route while the tasks route kept the same hole.
 */

import path from 'node:path';

export function isSafePathSegment(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id !== '.' &&
    !id.includes('..') &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('\0') &&
    id === path.basename(id)
  );
}

export function assertSafePathSegment(id: unknown, kind: string): asserts id is string {
  if (!isSafePathSegment(id)) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(id)}`);
  }
}
