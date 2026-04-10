/**
 * Workflow contract — public surface for plugins implementing workflows.
 *
 * A workflow is a multi-step AI process: search → filter → generate → execute → track.
 * Plugins implement Workflow; core orchestrates execution and provides infrastructure.
 */
export const DEFAULT_MODEL_TIERS = {
    free: 'nvidia/nemotron-ultra-253b',
    cheap: 'zai/glm-5.1',
    premium: 'anthropic/claude-sonnet-4.6',
};
