/**
 * Workflow Engine types.
 * Shared by all workflows (social, trading, content, etc.)
 */
export const DEFAULT_MODEL_TIERS = {
    free: 'nvidia/nemotron-ultra-253b',
    cheap: 'zai/glm-5.1',
    premium: 'anthropic/claude-sonnet-4.6',
};
