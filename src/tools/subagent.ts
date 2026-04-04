/**
 * SubAgent capability — spawn a child agent for independent tasks.
 */

import { ModelClient } from '../agent/llm.js';
import { assembleInstructions } from '../agent/context.js';
import type {
  CapabilityHandler,
  CapabilityResult,
  CapabilityInvocation,
  ContentPart,
  Dialogue,
  ExecutionScope,
  UserContentPart,
} from '../agent/types.js';

// These will be injected at registration time
let registeredApiUrl = '';
let registeredChain: 'base' | 'solana' = 'base';
let registeredCapabilities: CapabilityHandler[] = [];

interface SubAgentInput {
  prompt: string;
  description?: string;
  model?: string;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { prompt, description, model } = input as unknown as SubAgentInput;

  if (!prompt) {
    return { output: 'Error: prompt is required', isError: true };
  }

  const client = new ModelClient({
    apiUrl: registeredApiUrl,
    chain: registeredChain,
  });

  const capabilityMap = new Map<string, CapabilityHandler>();
  // Sub-agents get a subset of tools (no sub-agent recursion)
  const subTools = registeredCapabilities.filter(c => c.spec.name !== 'Agent');
  for (const cap of subTools) {
    capabilityMap.set(cap.spec.name, cap);
  }
  const toolDefs = subTools.map(c => c.spec);

  const systemInstructions = assembleInstructions(ctx.workingDir);
  const systemPrompt = systemInstructions.join('\n\n');

  const history: Dialogue[] = [
    { role: 'user', content: prompt },
  ];

  const maxTurns = 30;
  const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute total timeout
  const deadline = Date.now() + SUB_AGENT_TIMEOUT_MS;
  let turn = 0;
  let finalText = '';

  while (turn < maxTurns) {
    if (Date.now() > deadline) {
      return { output: `[${description || 'sub-agent'}] timed out after 5 minutes (${turn} turns completed).`, isError: true };
    }
    turn++;

    const { content: parts } = await client.complete(
      {
        model: model || 'anthropic/claude-sonnet-4.6',
        messages: history,
        system: systemPrompt,
        tools: toolDefs,
        max_tokens: 16384,
        stream: true,
      },
      ctx.abortSignal
    );

    history.push({ role: 'assistant', content: parts });

    // Collect text and invocations
    const invocations: CapabilityInvocation[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        finalText = part.text;
      } else if (part.type === 'tool_use') {
        invocations.push(part);
      }
    }

    if (invocations.length === 0) break;

    // Execute tools
    const outcomes: UserContentPart[] = [];
    for (const inv of invocations) {
      const handler = capabilityMap.get(inv.name);
      let result: CapabilityResult;
      if (handler) {
        try {
          result = await handler.execute(inv.input, ctx);
        } catch (err) {
          result = {
            output: `Error: ${(err as Error).message}`,
            isError: true,
          };
        }
      } else {
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

export function createSubAgentCapability(
  apiUrl: string,
  chain: 'base' | 'solana',
  capabilities: CapabilityHandler[]
): CapabilityHandler {
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
