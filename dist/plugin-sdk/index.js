/**
 * RunCode Plugin SDK — public surface for plugins.
 *
 * Plugins import ONLY from '@blockrun/runcode/plugin-sdk' (or this barrel).
 * They MUST NOT import from src/** of core or other plugins.
 *
 * Core stays plugin-agnostic: adding a plugin should never require editing core.
 */
export { DEFAULT_MODEL_TIERS } from './workflow.js';
