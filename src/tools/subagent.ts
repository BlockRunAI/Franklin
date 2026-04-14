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
let registeredParentModel = '';
let registeredCapabilities: CapabilityHandler[] = [];

interface SubAgentInput {
  prompt: string;
  description?: string;
  model?: string;
}

// Heuristic: which model IDs are free?
function isFreeModel(m: string): boolean {
  return m.startsWith('nvidia/') || m === 'blockrun/free' || m === '';
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { prompt, description, model } = input as unknown as SubAgentInput;

  if (!prompt) {
    return { output: 'Error: prompt is required', isError: true };
  }

  // Resolve which model the sub-agent will actually run on
  const subModel = model || registeredParentModel || 'nvidia/nemotron-ultra-253b';

  // Cost gate: if parent is free but sub-agent wants paid, ask user first.
  // Prevents silent charges when the agent decides to spawn a more capable sub-agent.
  if (isFreeModel(registeredParentModel) && !isFreeModel(subModel) && ctx.onAskUser) {
    const shortLabel = subModel.split('/').pop() || subModel;
    const answer = await ctx.onAskUser(
      `Sub-agent wants to use ${shortLabel} (paid). Approve?`,
      ['y', 'n']
    );
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      return {
        output: `Sub-agent skipped — user declined paid model (${shortLabel}). Retry with a free model like nemotron.`,
        isError: true,
      };
    }
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

  // Inject parent context so sub-agent avoids duplicate work
  let parentContextSection = '';
  if (ctx.parentContext) {
    const parts: string[] = [];
    if (ctx.parentContext.goal) {
      parts.push(`Parent task: ${ctx.parentContext.goal}`);
    }
    if (ctx.parentContext.recentFiles && ctx.parentContext.recentFiles.length > 0) {
      parts.push(`Files already read by parent: ${ctx.parentContext.recentFiles.join(', ')}`);
      parts.push('Do not re-read these files unless you need to verify a change.');
    }
    if (parts.length > 0) {
      parentContextSection = '\n\n# Parent Agent Context\n' + parts.join('\n');
    }
  }

  const systemPrompt = systemInstructions.join('\n\n') + parentContextSection;

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
        model: subModel,
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
  capabilities: CapabilityHandler[],
  parentModel?: string
): CapabilityHandler {
  registeredApiUrl = apiUrl;
  registeredChain = chain;
  registeredCapabilities = capabilities;
  if (parentModel) registeredParentModel = parentModel;

  return {
    spec: {
      name: 'Agent',
      description: `Launch a new agent to handle complex, multi-step tasks. Each agent gets its own context window, tools, and reasoning loop.

## When to use
- Tasks requiring 3+ independent tool calls (research, exploration, implementation)
- Work that benefits from a separate context (won't pollute your main conversation)
- Parallel execution: launch multiple agents in a single response for independent tasks
- Open-ended codebase exploration that may require multiple rounds of globbing and grepping

## When NOT to use
- If you want to read a specific file path, use Read directly — faster and cheaper
- If you are searching for a specific symbol like "class Foo", use Grep directly
- If you are searching within 2-3 specific files, use Read directly
- Simple, single-tool operations (just call the tool directly)
- Tasks that depend on results from other pending tool calls

## Writing the prompt
Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why
- Describe what you've already learned or ruled out
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction
- If you need a short response, say so ("report in under 200 words")
- For lookups: hand over the exact command. For investigations: hand over the question — prescribed steps become dead weight when the premise is wrong
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches), since it is not aware of the user's intent

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Usage notes
- Always include a short description (3-5 words) summarizing what the agent will do
- The agent's result is returned to you, NOT shown to the user. To show the user the result, you must send a text message summarizing it
- Trust but verify: the agent's summary describes what it intended, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting success
- If launching multiple agents for independent work, send them ALL in a single response with multiple Agent tool calls — this runs them in parallel
- Use foreground (default) when you need results before you can proceed. The agent completes before your response continues
- Do not re-read files or re-search for things the agent already found — trust its output`,
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
