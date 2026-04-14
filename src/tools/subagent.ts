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
      description: `Launch a sub-agent to handle complex, multi-step tasks autonomously. Each sub-agent gets its own context window, tools, and reasoning loop.

## When to use
- Tasks requiring 3+ tool calls that are independent of your current work
- Research or exploration where intermediate output isn't worth keeping in your context
- Parallel execution: launch multiple agents in a single response for independent tasks

## When NOT to use
- Simple, single-tool operations (just call the tool directly)
- Tasks that depend on results from other pending tool calls

## Writing the prompt
Brief the agent like a smart colleague who just walked into the room — it hasn't seen your conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why
- Describe what you've already learned or ruled out
- Give enough context for the agent to make judgment calls
- For lookups: hand over the exact command. For investigations: hand over the question
- **Never delegate understanding** — don't write "based on your findings, fix the bug." Write prompts that prove you understood: include file paths, what specifically to change

## Usage notes
- Always include a short description (3-5 words) summarizing the task
- The agent's result is returned to you, not shown to the user. Summarize it for the user.
- Trust but verify: the agent describes intent, not necessarily outcome. Check actual changes before reporting.
- If launching multiple agents for independent work, send them all in a single response.
- Terse command-style prompts produce shallow, generic work. Be specific.`,
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for the sub-agent to perform. Must be self-contained — the agent has no memory of your conversation.' },
          description: { type: 'string', description: 'Short (3-5 word) description of the task (e.g. "Research auth patterns", "Fix import errors")' },
          model: { type: 'string', description: 'Model for the sub-agent. Default: claude-sonnet-4.6' },
        },
        required: ['prompt'],
      },
    },
    execute,
    concurrent: false,
  };
}
