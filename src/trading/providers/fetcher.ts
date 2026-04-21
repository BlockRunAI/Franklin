/**
 * Fetcher<Query, Data> — the three-step Transform/Extract/Transform (TET)
 * contract every trading data provider implements.
 *
 * Named after OpenBB's provider abstraction but reduced to the shape that
 * actually pays rent in a single-language TypeScript codebase:
 *
 *   1. `transformQuery(input)` — normalize caller input (ticker casing,
 *      default values, clamping) into the provider's expected query.
 *   2. `fetchData(query)` — hit the provider's API, return raw payload or a
 *      ProviderError.
 *   3. `transformData(raw, query)` — coerce the raw payload into the
 *      standard data type the rest of the codebase consumes.
 *
 * Keeping these three steps separate makes providers testable in isolation:
 * you can feed a canned raw payload into `transformData` without mocking
 * HTTP. It also keeps the provider code free of formatting concerns —
 * rendering is views' job, not fetchers'.
 */

import type { ProviderError } from './standard-models.js';

export interface Fetcher<Query, Data, Raw = unknown> {
  /** Human-readable provider id — "coingecko", "binance", etc. */
  readonly providerName: string;

  /** Lowercase the ticker, clamp limits, fill defaults. */
  transformQuery(input: Partial<Query>): Query;

  /** Hit the upstream API. Must not throw — return ProviderError on failure. */
  fetchData(query: Query): Promise<Raw | ProviderError>;

  /** Coerce raw → standard data shape. Returns ProviderError if the shape
   *  doesn't map (e.g., provider returned an empty object for a ticker). */
  transformData(raw: Raw, query: Query): Data | ProviderError;

  /**
   * Convenience: end-to-end run. Default implementation composes the three
   * steps; providers can override when a single-step optimization exists.
   */
  run?(input: Partial<Query>): Promise<Data | ProviderError>;
}

/**
 * Helper: run a fetcher end-to-end with the default composition. Providers
 * that want caching, retries, or parallel fan-out can skip this and write
 * their own `run`. Kept as a plain function so callers don't depend on
 * object-oriented glue.
 */
export async function runFetcher<Q, D, R>(
  fetcher: Fetcher<Q, D, R>,
  input: Partial<Q>,
): Promise<D | ProviderError> {
  try {
    if (fetcher.run) return fetcher.run(input);
    const query = fetcher.transformQuery(input);
    const raw = await fetcher.fetchData(query);
    if (isProviderErrorLike(raw)) return raw;
    return fetcher.transformData(raw as R, query);
  } catch (err) {
    return {
      kind: 'unknown',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function isProviderErrorLike(v: unknown): v is ProviderError {
  return typeof v === 'object' && v !== null && 'kind' in v && 'message' in v;
}
