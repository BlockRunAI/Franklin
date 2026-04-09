/**
 * Multi-model tier router.
 * Maps ModelTier (free/cheap/premium) to actual model names.
 * Uses RunCode's existing ModelClient for API calls.
 */

import { ModelClient } from '../agent/llm.js';
import type { ModelTier, ModelTierConfig } from './types.js';
import { DEFAULT_MODEL_TIERS } from './types.js';
import { estimateCost } from '../pricing.js';

export class ModelRouter {
  private client: ModelClient;
  private tiers: ModelTierConfig;

  constructor(client: ModelClient, tiers?: ModelTierConfig) {
    this.client = client;
    this.tiers = tiers ?? DEFAULT_MODEL_TIERS;
  }

  /** Resolve a tier to an actual model name */
  resolveModel(tier: ModelTier): string | null {
    switch (tier) {
      case 'free': return this.tiers.free;
      case 'cheap': return this.tiers.cheap;
      case 'premium': return this.tiers.premium;
      case 'none': return null;
    }
  }

  /** Call a model at the specified tier. Returns the response text + cost. */
  async call(tier: ModelTier, prompt: string, system?: string): Promise<{ text: string; cost: number; model: string }> {
    const model = this.resolveModel(tier);
    if (!model) throw new Error(`Cannot call model with tier "none"`);

    // Use the streaming completion API and collect the full response
    const { content, usage } = await this.client.complete({
      model,
      messages: [{ role: 'user', content: prompt }],
      system,
      max_tokens: 4096,
      stream: true,
    });

    // Extract text from content parts
    let text = '';
    for (const part of content) {
      if (part.type === 'text') {
        text += part.text;
      }
    }

    const cost = estimateCost(model, usage.inputTokens, usage.outputTokens, 1);
    return { text, cost, model };
  }

  /** Get the tier config for display */
  getTiers(): ModelTierConfig {
    return { ...this.tiers };
  }

  /** Estimate cost for a tier (rough, for display before execution) */
  estimateTierCost(tier: ModelTier): string {
    const model = this.resolveModel(tier);
    if (!model) return '$0';
    const cost = estimateCost(model, 1000, 500, 1);
    if (cost === 0) return 'FREE';
    if (cost < 0.001) return '<$0.001';
    return `~$${cost.toFixed(3)}`;
  }
}
