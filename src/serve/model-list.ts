import { sortModelsNewestFirst } from '@blockrun/model-catalog';
import type { GatewayModel } from '../gateway-models.js';

// Keep company sections in the established picker order. Recency within each
// section belongs to Model Core, shared with the expanded terminal picker.
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', azure: 'OpenAI', google: 'Google', 'google-vertex': 'Google',
  xai: 'xAI', deepseek: 'DeepSeek', meta: 'Meta', 'meta-llama': 'Meta', nvidia: 'NVIDIA',
  moonshot: 'Moonshot', moonshotai: 'Moonshot', qwen: 'Qwen', alibaba: 'Qwen', mistral: 'Mistral',
  mistralai: 'Mistral', minimax: 'MiniMax', zhipu: 'Zhipu', bytedance: 'ByteDance', cohere: 'Cohere',
  perplexity: 'Perplexity', amazon: 'Amazon', microsoft: 'Microsoft', '01-ai': 'Yi', ai21: 'AI21',
};
const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Qwen', 'Moonshot', 'Meta', 'Mistral', 'MiniMax', 'NVIDIA'];

function providerLabel(id: string, ownedBy?: string): string {
  const p = (id.split('/')[0] || ownedBy || '').toLowerCase();
  return PROVIDER_LABEL[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other');
}

/** The models.list payload used by both Desktop and the browser UI. */
export function buildModelList(models: GatewayModel[]) {
  const groups = new Map<string, GatewayModel[]>();
  for (const model of models) {
    if (model.available === false || !model.categories.includes('chat')) continue;
    const provider = providerLabel(model.id, model.owned_by);
    const group = groups.get(provider) ?? [];
    group.push(model);
    groups.set(provider, group);
  }
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index < 0 ? PROVIDER_ORDER.length : index;
  };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .flatMap(([provider, rows]) => sortModelsNewestFirst(rows).map(model => ({
      id: model.id,
      label: model.name,
      free: model.billing_mode === 'free',
      group: provider,
      provider,
      contextWindow: model.context_window,
    })));
}
