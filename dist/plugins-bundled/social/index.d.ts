/**
 * Social Workflow Plugin.
 *
 * IMPORTANT: This file ONLY imports from `../../plugin-sdk/`.
 * It does NOT import from `src/agent/`, `src/commands/`, `src/social/`, etc.
 * This is the boundary that keeps plugins decoupled from core internals.
 */
import type { Plugin } from '../../plugin-sdk/index.js';
declare const plugin: Plugin;
export default plugin;
