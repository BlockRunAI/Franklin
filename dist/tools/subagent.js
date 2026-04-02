/**
 * SubAgent capability — spawn a child agent for independent tasks.
 */
import { ModelClient } from '../agent/llm.js';
import { assembleInstructions } from '../agent/context.js';
// These will be injected at registration time
let registeredApiUrl = '';
let registeredChain = 'base';
let registeredCapabilities = [];
async function execute(input, ctx) {
    const { prompt, description, model } = input;
    if (!prompt) {
        return { output: 'Error: prompt is required', isError: true };
    }
    const client = new ModelClient({
        apiUrl: registeredApiUrl,
        chain: registeredChain,
    });
    const capabilityMap = new Map();
    // Sub-agents get a subset of tools (no sub-agent recursion)
    const subTools = registeredCapabilities.filter(c => c.spec.name !== 'Agent');
    for (const cap of subTools) {
        capabilityMap.set(cap.spec.name, cap);
    }
    const toolDefs = subTools.map(c => c.spec);
    const systemInstructions = assembleInstructions(ctx.workingDir);
    const systemPrompt = systemInstructions.join('\n\n');
    const history = [
        { role: 'user', content: prompt },
    ];
    const maxTurns = 30;
    let turn = 0;
    let finalText = '';
    while (turn < maxTurns) {
        turn++;
        const { content: parts } = await client.complete({
            model: model || 'anthropic/claude-sonnet-4.6',
            messages: history,
            system: systemPrompt,
            tools: toolDefs,
            max_tokens: 16384,
            stream: true,
        }, ctx.abortSignal);
        history.push({ role: 'assistant', content: parts });
        // Collect text and invocations
        const invocations = [];
        for (const part of parts) {
            if (part.type === 'text') {
                finalText = part.text;
            }
            else if (part.type === 'tool_use') {
                invocations.push(part);
            }
        }
        if (invocations.length === 0)
            break;
        // Execute tools
        const outcomes = [];
        for (const inv of invocations) {
            const handler = capabilityMap.get(inv.name);
            let result;
            if (handler) {
                try {
                    result = await handler.execute(inv.input, ctx);
                }
                catch (err) {
                    result = {
                        output: `Error: ${err.message}`,
                        isError: true,
                    };
                }
            }
            else {
                result = { output: `Unknown tool: ${inv.name}`, isError: true };
            }
            outcomes.push({
                type: 'tool_result',
                tool_use_id: inv.id,
                content: result.output,
                is_error: result.isError,
            });
        }
        history.push({ role: 'user', content: outcomes });
    }
    const label = description || 'sub-agent';
    return {
        output: finalText || `[${label}] completed after ${turn} turn(s) with no text output.`,
    };
}
export function createSubAgentCapability(apiUrl, chain, capabilities) {
    registeredApiUrl = apiUrl;
    registeredChain = chain;
    registeredCapabilities = capabilities;
    return {
        spec: {
            name: 'Agent',
            description: 'Launch a sub-agent for independent tasks. The sub-agent has its own context and tools.',
            input_schema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'The task for the sub-agent to perform' },
                    description: { type: 'string', description: 'Short description of what the sub-agent will do' },
                    model: { type: 'string', description: 'Model for the sub-agent. Default: claude-sonnet-4.6' },
                },
                required: ['prompt'],
            },
        },
        execute,
        concurrent: false,
    };
}
