/**
 * Mixture-of-Agents (MoA) — query multiple models in parallel, aggregate with a strong model.
 *
 * How it works:
 * 1. Send the same prompt to N reference models (cheap/free) in parallel
 * 2. Collect all responses
 * 3. Send all responses + the original prompt to a strong aggregator model
 * 4. Aggregator synthesizes the best answer from all references
 *
 * This produces higher-quality answers than any single model for complex questions.
 * Inspired by the Mixture-of-Agents architecture from Together.ai research.
 */
import { ModelClient } from '../agent/llm.js';
// ─── Configuration ────────────────────────────────────────────────────────
/** Reference models — diverse, cheap/free models for parallel queries. */
const REFERENCE_MODELS = [
    'nvidia/nemotron-ultra-253b', // Free, strong reasoning
    'nvidia/qwen3-coder-480b', // Free, strong coding
    'google/gemini-2.5-flash', // Fast, cheap
    'deepseek/deepseek-chat', // Cheap, good reasoning
];
/** Aggregator model — strong model that synthesizes the best answer. */
const AGGREGATOR_MODEL = 'anthropic/claude-sonnet-4.6';
/** Max tokens per reference response. */
const REFERENCE_MAX_TOKENS = 4096;
/** Max tokens for aggregator. */
const AGGREGATOR_MAX_TOKENS = 8192;
/** Timeout per reference model call (ms). */
const REFERENCE_TIMEOUT_MS = 60_000;
// ─── Implementation ──────────────────────────────────────────────────────
// These will be injected at registration time
let registeredApiUrl = '';
let registeredChain = 'base';
async function execute(input, ctx) {
    const { prompt, models, aggregator, include_reasoning } = input;
    if (!prompt) {
        return { output: 'Error: prompt is required', isError: true };
    }
    const referenceModels = models || REFERENCE_MODELS;
    const aggregatorModel = aggregator || AGGREGATOR_MODEL;
    const client = new ModelClient({
        apiUrl: registeredApiUrl,
        chain: registeredChain,
    });
    ctx.onProgress?.('Querying reference models...');
    // Step 1: Query all reference models in parallel
    const referencePromises = referenceModels.map(async (model) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REFERENCE_TIMEOUT_MS);
        try {
            const response = await client.complete({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: REFERENCE_MAX_TOKENS,
                stream: false,
            }, controller.signal);
            clearTimeout(timer);
            // Extract text from response
            let text = '';
            if (response.content) {
                for (const part of response.content) {
                    if (typeof part === 'string')
                        text += part;
                    else if (part.type === 'text')
                        text += part.text;
                }
            }
            return { model, text: text.trim(), error: null };
        }
        catch (err) {
            clearTimeout(timer);
            return { model, text: '', error: err.message };
        }
    });
    const references = await Promise.all(referencePromises);
    // Filter out failures
    const successRefs = references.filter(r => r.text && !r.error);
    if (successRefs.length === 0) {
        const errors = references.map(r => `${r.model}: ${r.error}`).join('\n');
        return { output: `All reference models failed:\n${errors}`, isError: true };
    }
    ctx.onProgress?.(`${successRefs.length}/${referenceModels.length} responded, aggregating...`);
    // Step 2: Build aggregation prompt
    const refSection = successRefs.map((r, i) => `## Response ${i + 1} (${r.model})\n\n${r.text}`).join('\n\n---\n\n');
    const aggregationPrompt = `You have been given ${successRefs.length} responses to the same question from different AI models. Your job is to synthesize the BEST possible answer by:

1. Identifying the strongest insights from each response
2. Resolving any contradictions (prefer verifiable facts)
3. Combining the best parts into a single, coherent answer
4. Adding any important points that ALL models missed

## Original Question

${prompt}

## Reference Responses

${refSection}

## Your Task

Synthesize the best possible answer. Be comprehensive but concise. If the responses agree, be confident. If they disagree, note the disagreement and explain which is more likely correct.`;
    // Step 3: Aggregate with strong model
    try {
        const aggResponse = await client.complete({
            model: aggregatorModel,
            messages: [{ role: 'user', content: aggregationPrompt }],
            max_tokens: AGGREGATOR_MAX_TOKENS,
            stream: false,
        }, ctx.abortSignal);
        let aggText = '';
        if (aggResponse.content) {
            for (const part of aggResponse.content) {
                if (typeof part === 'string')
                    aggText += part;
                else if (part.type === 'text')
                    aggText += part.text;
            }
        }
        // Build output
        const parts = [];
        parts.push(aggText.trim());
        if (include_reasoning) {
            parts.push('\n\n---\n*Reference responses:*');
            for (const ref of successRefs) {
                parts.push(`\n**${ref.model}:** ${ref.text.slice(0, 500)}${ref.text.length > 500 ? '...' : ''}`);
            }
        }
        // Note which models responded
        const modelList = successRefs.map(r => r.model.split('/').pop()).join(', ');
        const failList = references.filter(r => r.error).map(r => r.model.split('/').pop()).join(', ');
        parts.push(`\n\n*MoA: ${successRefs.length} models (${modelList})${failList ? `, ${failList} failed` : ''} → ${aggregatorModel.split('/').pop()}*`);
        return { output: parts.join('\n') };
    }
    catch (err) {
        return {
            output: `Aggregation failed: ${err.message}\n\nBest reference response (${successRefs[0].model}):\n${successRefs[0].text}`,
            isError: true,
        };
    }
}
export const moaCapability = {
    spec: {
        name: 'MixtureOfAgents',
        description: `Query multiple AI models in parallel and synthesize the best answer.

Use this for complex questions where a single model might miss important perspectives.
Sends the prompt to 4 diverse models, then aggregates with a strong model.

Parameters:
- prompt (required): The question or task to send to all models
- models (optional): Array of model IDs to use as references (default: 4 diverse free/cheap models)
- aggregator (optional): Model to aggregate responses (default: claude-sonnet-4.6)
- include_reasoning (optional): If true, include reference responses in output`,
        input_schema: {
            type: 'object',
            required: ['prompt'],
            properties: {
                prompt: { type: 'string', description: 'The question or task to send to all models' },
                models: { type: 'array', items: { type: 'string' }, description: 'Override reference models' },
                aggregator: { type: 'string', description: 'Override aggregator model' },
                include_reasoning: { type: 'boolean', description: 'Include reference responses in output' },
            },
        },
    },
    execute,
    concurrent: true,
};
/** Register the API URL for MoA tool (called during agent setup). */
export function registerMoAConfig(apiUrl, chain) {
    registeredApiUrl = apiUrl;
    registeredChain = chain;
}
