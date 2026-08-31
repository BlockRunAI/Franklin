/**
 * Pure free-tier constants — NO imports, no side effects.
 *
 * Split out of free-models.ts so the PUBLIC plugin SDK can name the free
 * default without dragging core internals in behind it. free-models.ts imports
 * gateway-models.ts, which imports config.ts, which does a `readFileSync` and
 * builds `~/.blockrun` paths AT MODULE LOAD. Before this split, importing
 * `@blockrun/franklin/plugin-sdk` just to read DEFAULT_MODEL_TIERS triggered
 * that filesystem I/O — a side effect the SDK never had when the tier was a
 * bare string literal, and a coupling the plugin-sdk header explicitly forbids
 * ("Core stays plugin-agnostic").
 *
 * This keeps ONE definition, which is the point of the whole module: the
 * alternative was copying the literal back into the SDK and re-acquiring the
 * drift this file was created to end.
 *
 * Rationale, measurements and the routing logic all stay in free-models.ts,
 * which re-exports everything here.
 */

/**
 * The free model Franklin asks for by default. Chosen for AVAILABILITY, not
 * for being the best — see the full note in free-models.ts.
 */
export const FREE_DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';

/** Free models in preference order, best first. See free-models.ts. */
export const FREE_PREFERENCE_ORDER: readonly string[] = [
  'nvidia/nemotron-3-nano-30b',     // 5/5 healthy, fastest
  FREE_DEFAULT_MODEL,               // the floor this never drops below
  'poolside/laguna-xs-2.1',         // different provider
  'cohere/north-mini-code',         // different provider; needs max_tokens >= 1200
];

/** Context budget for ANY free-tier request. See free-models.ts. */
export const FREE_POOL_CONTEXT_FLOOR = 131_072;
